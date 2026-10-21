import React, { useEffect, useState } from 'react';
import { Check, Code2, Download, LoaderCircle, SlidersHorizontal } from 'lucide-react';
import { api } from '../../lib/api.js';
import { downloadJSON } from '../../lib/download-json.js';
import { Modal } from '../../components/Modal.jsx';
import { Notice } from '../../components/feedback.jsx';
import {
  applyJsonFields,
  createRuleDraft,
  formatRule,
  parseRuleDocument,
  ruleField,
  withRuleField,
} from './editor.js';

const sections = [
  ['basic', '基本信息'],
  ['search', '搜索配置'],
  ['chapters', '章节配置'],
  ['playback', '播放与请求'],
  ['verification', '验证码'],
];
const modes = [
  ['xpath', 'XPath · 网页解析'],
  ['api', 'API · JSON 接口'],
];

export function RuleEditor({ rule, onClose, onSaved }) {
  const [initial] = useState(() => formatRule(rule || createRuleDraft()));
  const [content, setContent] = useState(initial);
  const [jsonFields, setJsonFields] = useState({});
  const [mode, setMode] = useState('form');
  const [section, setSection] = useState('basic');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const dirty = content !== initial || Object.keys(jsonFields).length > 0;
  let draft;
  try {
    draft = parseRuleDocument(content);
  } catch {
    // Invalid source remains editable in JSON mode, and cannot replace the form.
    draft = {};
  }

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const changed = () => {
    setError('');
    setChecked(false);
    setDiscarding(false);
  };
  const update = (path, value) => {
    setContent((current) => formatRule(withRuleField(parseRuleDocument(current), path, value)));
    changed();
  };
  const document = () => applyJsonFields(parseRuleDocument(content), jsonFields);
  const sync = () => {
    const value = document();
    setContent(formatRule(value));
    setJsonFields({});
    return value;
  };
  const switchMode = (next) => {
    if (mode === next) return;
    try {
      sync();
      setMode(next);
      setError('');
    } catch (error) {
      setError(error.message);
    }
  };
  const close = () => {
    if (pending) return;
    if (dirty) setDiscarding(true);
    else onClose();
  };
  const validate = async () => {
    setPending('validate');
    setError('');
    setChecked(false);
    try {
      await api('/rules/validate', {
        method: 'POST',
        body: JSON.stringify({ content: sync() }),
      });
      setChecked(true);
    } catch (error) {
      setError(error.message);
    } finally {
      setPending('');
    }
  };
  const save = async () => {
    setPending('save');
    setError('');
    try {
      await api(rule ? `/rules/${encodeURIComponent(rule.name)}` : '/rules', {
        method: rule ? 'PUT' : 'POST',
        body: JSON.stringify(document()),
      });
      await onSaved();
    } catch (error) {
      setError(error.message);
    } finally {
      setPending('');
    }
  };
  const exportDraft = () => {
    try {
      const value = document();
      downloadJSON(value, `${value.name || 'kazumi-rule'}.json`);
    } catch (error) {
      setError(error.message);
    }
  };

  const field = (path, label, { hint, options, fallback = '', multiline, json, ...props } = {}) => {
    const value = path.split('.').reduce((current, key) => current?.[key], draft);
    const inputProps = {
      'aria-label': label,
      value: json
        ? (jsonFields[path] ?? formatRule(value === undefined ? {} : value))
        : (value ?? fallback),
      onChange: (event) => {
        if (json) {
          setJsonFields((current) => ({ ...current, [path]: event.target.value }));
          changed();
        } else update(path, event.target.value);
      },
      ...props,
    };
    return (
      <label className={`rule-field ${multiline || json ? 'rule-field-wide' : ''}`} key={path}>
        <span>
          {label}
          <code>{path}</code>
        </span>
        {options ? (
          <select {...inputProps}>
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ) : multiline || json ? (
          <textarea {...inputProps} rows={json ? 8 : 3} spellCheck={false} />
        ) : (
          <input {...inputProps} spellCheck={false} />
        )}
        {hint && <small>{hint}</small>}
      </label>
    );
  };
  const toggle = (path, label, hint, fallback = false) => (
    <label className="rule-editor-toggle" key={path}>
      <input
        type="checkbox"
        checked={ruleField(draft, path, fallback) === true}
        onChange={(event) => update(path, event.target.checked)}
      />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
  const apiConfig = (kind) => {
    const search = kind === 'search';
    const path = search ? 'searchApiConfig' : 'chapterApiConfig';
    return (
      <>
        {field(`${path}.request.url`, '接口地址', {
          placeholder: search
            ? 'https://example.com/api/search?q=@keyword'
            : 'https://example.com/api/detail?id=@source',
          hint: search
            ? '使用 @keyword 引用搜索词，填写完整 HTTP(S) 地址。'
            : '使用 @source 引用搜索结果中的来源值。',
        })}
        {field(`${path}.request.method`, '请求方法', {
          fallback: 'GET',
          options: [
            ['GET', 'GET'],
            ['POST', 'POST'],
          ],
        })}
        {field(`${path}.request.headers`, '请求头 JSON', { json: true })}
        {field(`${path}.request.query`, '查询参数 JSON', { json: true })}
        {field(`${path}.request.bodyType`, '请求体类型', {
          fallback: 'none',
          options: [
            ['none', '无'],
            ['json', 'JSON'],
            ['form', '表单'],
          ],
        })}
        {ruleField(draft, `${path}.request.bodyType`, 'none') !== 'none' &&
          field(`${path}.request.body`, '请求体 JSON', { json: true })}
        {search ? (
          <>
            {field(`${path}.listPath`, '结果列表 JSONPath', { fallback: '$.data[*]' })}
            {field(`${path}.namePath`, '名称 JSONPath', { fallback: '$.name' })}
            {field(`${path}.sourcePath`, '来源 JSONPath', { fallback: '$.url' })}
            {field(`${path}.sourceTemplate`, '详情页地址模板', {
              placeholder: '/detail/@source',
              hint: '可选；使用 @source 将来源值转换为详情地址，需要 API 9。',
            })}
          </>
        ) : (
          <>
            {field(`${path}.format`, '章节数据格式', {
              fallback: 'nested',
              options: [
                ['nested', '嵌套数组'],
                ['delimited', '分隔字符串'],
              ],
            })}
            {ruleField(draft, `${path}.format`, 'nested') === 'delimited' ? (
              <>
                {field(`${path}.roadNamesPath`, '线路名称 JSONPath')}
                {field(`${path}.roadEpisodesPath`, '线路剧集 JSONPath')}
                {field(`${path}.roadSeparator`, '线路分隔符', { fallback: '$$$' })}
                {field(`${path}.episodeSeparator`, '剧集分隔符', { fallback: '#' })}
                {field(`${path}.fieldSeparator`, '名称与地址分隔符', { fallback: '$' })}
              </>
            ) : (
              <>
                {field(`${path}.roadsPath`, '线路列表 JSONPath', { fallback: '$.data.roads[*]' })}
                {field(`${path}.roadNamePath`, '线路名称 JSONPath', { fallback: '$.name' })}
                {field(`${path}.episodesPath`, '剧集列表 JSONPath', { fallback: '$.episodes[*]' })}
                {field(`${path}.episodeNamePath`, '剧集名称 JSONPath', { fallback: '$.name' })}
                {field(`${path}.episodeUrlPath`, '剧集地址 JSONPath', { fallback: '$.url' })}
              </>
            )}
            {field(`${path}.variables`, '模板变量 JSON', {
              json: true,
              hint: '变量名映射到 JSONPath，例如 {"id": "$.data.id"}。',
            })}
            <label className="rule-editor-toggle">
              <input
                type="checkbox"
                checked={draft.chapterApiConfig?.episodePage != null}
                onChange={(event) => {
                  update(
                    `${path}.episodePage`,
                    event.target.checked ? { url: '', query: {} } : undefined,
                  );
                  setJsonFields((current) =>
                    Object.fromEntries(
                      Object.entries(current).filter(
                        ([key]) => !key.startsWith(`${path}.episodePage.`),
                      ),
                    ),
                  );
                }}
              />
              <span>
                自定义播放页地址
                <small>支持 @source、@roadNumber、@episodeNumber 和模板变量。</small>
              </span>
            </label>
            {draft.chapterApiConfig?.episodePage != null && (
              <>
                {field(`${path}.episodePage.url`, '播放页地址模板', {
                  placeholder: '/play/@source/@episodeNumber',
                })}
                {field(`${path}.episodePage.query`, '播放页查询参数 JSON', { json: true })}
              </>
            )}
          </>
        )}
      </>
    );
  };

  return (
    <Modal
      wide
      className="rule-editor-modal"
      title={rule ? `编辑规则 · ${rule.name}` : '新建规则'}
      onClose={close}
    >
      <p className="muted">配置搜索、章节与播放规则。保存后对使用本部署的所有设备生效。</p>
      <div className="rule-editor-toolbar">
        <div className="filter-tabs" role="group" aria-label="编辑方式">
          <button
            className={mode === 'form' ? 'selected' : ''}
            aria-pressed={mode === 'form'}
            disabled={!!pending}
            onClick={() => switchMode('form')}
          >
            <SlidersHorizontal size={15} />
            表单编辑
          </button>
          <button
            className={mode === 'json' ? 'selected' : ''}
            aria-pressed={mode === 'json'}
            disabled={!!pending}
            onClick={() => switchMode('json')}
          >
            <Code2 size={15} />
            JSON 编辑
          </button>
        </div>
        <button className="text-button" onClick={exportDraft} disabled={!!pending}>
          <Download size={15} />
          导出草稿
        </button>
      </div>
      {mode === 'form' && (
        <div className="rule-editor-sections" role="group" aria-label="规则配置分组">
          {sections.map(([id, label]) => (
            <button
              key={id}
              className={section === id ? 'selected' : ''}
              aria-pressed={section === id}
              disabled={!!pending}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="rule-editor-body">
        {mode === 'json' ? (
          <>
            <div className="rule-editor-source-heading">
              <p className="muted small">编辑完整 JSON；切回表单时保留额外字段。</p>
              <button
                className="text-button"
                disabled={!!pending}
                onClick={() => {
                  try {
                    sync();
                    setError('');
                  } catch (error) {
                    setError(error.message);
                  }
                }}
              >
                格式化 JSON
              </button>
            </div>
            <textarea
              className="code-input rule-editor-source"
              aria-label="规则 JSON"
              spellCheck={false}
              disabled={!!pending}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                changed();
              }}
            />
          </>
        ) : (
          <fieldset className="rule-editor-fields" disabled={!!pending}>
            <legend>{sections.find(([id]) => id === section)[1]}</legend>
            {section === 'basic' && (
              <>
                {field('name', '规则名称', {
                  maxLength: 100,
                  placeholder: '我的站点',
                  required: true,
                })}
                {field('baseURL', '站点地址', {
                  placeholder: 'https://example.com/',
                  required: true,
                })}
                {field('version', '规则版本', { placeholder: '1.0' })}
                {field('api', 'API 版本', {
                  fallback: '1',
                  hint: 'XPath 基础功能从 API 1 起，API 搜索与章节需要 8，地址模板需要 9。',
                })}
                {field('author', '作者')}
                {field('type', '规则类型', { fallback: 'anime' })}
                {toggle('enabled', '启用规则', '启用后参与默认的片源搜索。', true)}
              </>
            )}
            {section === 'search' && (
              <>
                {field('searchMode', '搜索方式', { fallback: 'xpath', options: modes })}
                {ruleField(draft, 'searchMode', 'xpath') === 'api' ? (
                  apiConfig('search')
                ) : (
                  <>
                    {field('searchURL', '搜索地址', {
                      placeholder: 'https://example.com/search?wd=@keyword',
                      hint: '使用 @keyword 引用搜索词。',
                    })}
                    {field('searchList', '结果列表 XPath', {
                      hint: '选中每个搜索结果条目，例如 //article。',
                    })}
                    {field('searchName', '结果名称 XPath', {
                      hint: '相对于单个结果条目，支持 //a/text()。',
                    })}
                    {field('searchResult', '结果链接 XPath', {
                      hint: '选中包含详情页 href 的链接节点，例如 //a。',
                    })}
                    {toggle('usePost', '使用 POST 搜索', '需要 API 2 或更高版本。')}
                  </>
                )}
              </>
            )}
            {section === 'chapters' && (
              <>
                {field('chapterMode', '章节方式', { fallback: 'xpath', options: modes })}
                {ruleField(draft, 'chapterMode', 'xpath') === 'api' ? (
                  apiConfig('chapter')
                ) : (
                  <>
                    {field('chapterRoads', '播放线路 XPath', {
                      hint: '选中每条线路的剧集容器；使用 // 代表整个文档。',
                    })}
                    {field('chapterResult', '剧集链接 XPath', {
                      hint: '相对于每个线路容器，选中包含 href 的剧集链接。',
                    })}
                  </>
                )}
                {toggle('muliSources', '多播放线路')}
              </>
            )}
            {section === 'playback' && (
              <>
                {field('userAgent', 'User-Agent', { placeholder: '留空使用默认值' })}
                {field('referer', 'Referer', {
                  placeholder: 'https://example.com/',
                  hint: '可选，填写完整 HTTP(S) 地址，需要 API 3。',
                })}
                {toggle(
                  'useWebview',
                  'WebView 标记',
                  '保留 Kazumi 原始配置；网页端按解析结果自动使用 Chromium。',
                )}
                {toggle(
                  'useNativePlayer',
                  '原生播放器标记',
                  '保留 Kazumi 原始配置，网页播放由浏览器能力决定。',
                )}
                {toggle('useLegacyParser', '旧版解析方式', '需要 API 3 或更高版本。')}
                {toggle('adBlocker', 'HLS 去广告', '使用部署服务的原生过滤功能，需要 API 5。')}
              </>
            )}
            {section === 'verification' && (
              <>
                {toggle(
                  'antiCrawlerConfig.enabled',
                  '启用验证码处理',
                  '需要 Chromium 和 API 6；自定义检测及脚本需要 API 7。',
                )}
                {draft.antiCrawlerConfig?.enabled === true && (
                  <>
                    {field('antiCrawlerConfig.captchaType', '验证方式', {
                      fallback: 1,
                      options: [
                        [1, '图片验证码'],
                        [2, '点击验证'],
                        [3, '自定义脚本'],
                      ],
                      onChange: (event) =>
                        update('antiCrawlerConfig.captchaType', Number(event.target.value)),
                    })}
                    {field('antiCrawlerConfig.captchaDetectType', '检测方式', {
                      fallback: 1,
                      options: [
                        ['xpath', 'XPath'],
                        ['text', '文本'],
                        ['regex', '正则表达式'],
                      ],
                      value:
                        { 1: 'xpath', 2: 'text', 3: 'regex' }[
                          draft.antiCrawlerConfig.captchaDetectType
                        ] ||
                        draft.antiCrawlerConfig.captchaDetectType ||
                        'xpath',
                    })}
                    {field('antiCrawlerConfig.captchaDetectValue', '检测表达式', {
                      hint: '可选，留空使用内置检测。',
                    })}
                    {(draft.antiCrawlerConfig.captchaType ?? 1) === 1 && (
                      <>
                        {field('antiCrawlerConfig.captchaImage', '验证码图片 XPath')}
                        {field('antiCrawlerConfig.captchaInput', '验证码输入框 XPath')}
                      </>
                    )}
                    {(draft.antiCrawlerConfig.captchaType ?? 1) !== 3 &&
                      field('antiCrawlerConfig.captchaButton', '验证按钮 XPath')}
                    {draft.antiCrawlerConfig.captchaType === 3 &&
                      field('antiCrawlerConfig.captchaScript', '验证脚本', {
                        multiline: true,
                        hint: '在来源页面的浏览器环境中执行 JavaScript。',
                      })}
                  </>
                )}
              </>
            )}
          </fieldset>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {checked && (
        <p className="rule-editor-success" role="status">
          <Check size={16} />
          规则配置与兼容性检查通过，实际搜索与播放取决于来源站点。
        </p>
      )}
      {discarding ? (
        <div className="rule-editor-discard" role="alert">
          <p>有未保存的修改，是否放弃？</p>
          <div className="button-group">
            <button className="button quiet" onClick={() => setDiscarding(false)}>
              继续编辑
            </button>
            <button className="button danger" onClick={onClose}>
              放弃修改
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-actions rule-editor-actions">
          <button className="button quiet" disabled={!!pending} onClick={validate}>
            {pending === 'validate' && <LoaderCircle size={15} className="spin" />}检查兼容性
          </button>
          <span className="muted">{dirty ? '有未保存的修改' : '尚未修改'}</span>
          <button className="button quiet" disabled={!!pending} onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={!!pending} onClick={save}>
            {pending === 'save' && <LoaderCircle size={15} className="spin" />}
            {rule ? '保存规则' : '创建规则'}
          </button>
        </div>
      )}
    </Modal>
  );
}
