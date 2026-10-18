import React, { useEffect, useState } from 'react';
import { Network, Save, Wifi } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Notice } from '../../components/feedback.jsx';

const imageModes = { mirror: '镜像', ech: 'ECH', direct: '直连' };
const proxyRows = [
  {
    scope: 'video',
    key: 'videoProxy',
    label: '视频源请求代理',
    help: '用于片源搜索、剧集解析、视频播放、下载和验证页面。',
    testUrl: '',
  },
  {
    scope: 'image',
    key: 'imageProxy',
    label: '番剧图片请求代理',
    help: '用于原图、wsrv.nl 镜像和封面地址查询。',
    testUrl: 'https://api.bgm.tv/v0/subjects/253/image?type=large',
  },
  {
    scope: 'bangumi',
    key: 'bangumiProxy',
    label: 'Bangumi API 请求代理',
    help: '用于 Bangumi 分类、搜索、详情、章节和日历等 API。',
    testUrl: 'https://api.bgm.tv/v0/subjects/253',
  },
  {
    scope: 'rules',
    key: 'rulesProxy',
    label: '规则仓库请求代理',
    help: '用于官方规则列表、规则安装和规则更新。',
    testUrl: 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json',
  },
  {
    scope: 'archive',
    key: 'archiveProxy',
    label: '资料归档下载代理',
    help: '用于归档版本检查和 ZIP 下载，手动及自动更新、命令行更新均使用此设置。',
    testUrl: 'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json',
  },
];

export function NetworkSettings({ request, notify }) {
  const [form, setForm] = useState(null);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [testScope, setTestScope] = useState('bangumi');
  const [testUrls, setTestUrls] = useState({});
  const testType = proxyRows.find(({ scope }) => scope === testScope);
  const testLabel = testType.label.replace(/代理$/, '');
  const testUrl = testUrls[testScope] ?? testType.testUrl;
  const disabled = Boolean(busy) || request.saving || request.loading;
  useEffect(() => {
    if (request.data)
      setForm((previous) =>
        previous
          ? { ...previous, videoProxy: request.data.videoProxy }
          : { ...request.data, password: '' },
      );
  }, [request.data]);
  const change = (key, value) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    if (key === 'password') setPasswordChanged(true);
    setError('');
    setResult('');
  };
  const submit = async (action) => {
    setBusy(action);
    setError('');
    setResult('');
    const settings = {
      videoProxy: form.videoProxy,
      imageProxy: form.imageProxy,
      bangumiProxy: form.bangumiProxy,
      rulesProxy: form.rulesProxy,
      archiveProxy: form.archiveProxy,
      url: form.url,
      username: form.username,
      bangumiEch: form.bangumiEch,
      imageAcceleration: form.imageAcceleration,
      echDohUrl: form.echDohUrl,
    };
    if (passwordChanged) settings.password = form.password;
    try {
      if (action === 'save') {
        const saved = await request.save(settings);
        setForm({ ...saved, password: '' });
        setPasswordChanged(false);
        setResult('saved');
        notify('网络设置已保存');
      } else {
        const tested = await api('/network-settings/test', {
          method: 'POST',
          body: JSON.stringify({ settings, scope: testScope, url: testUrl }),
        });
        const mode = { proxy: '代理', ech: 'ECH', direct: '直连', mirror: '镜像' }[tested.mode];
        setResult(
          `${testLabel} · ${mode}${tested.mirror && tested.mode === 'proxy' ? ' / 镜像' : ''}测试成功 · HTTP ${tested.status} · ${tested.elapsedMs} ms。测试不会保存设置。`,
        );
      }
    } catch (error) {
      setError(action === 'test' ? `${testLabel}测试失败：${error.message}` : error.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <section id="network-settings" className="settings-card" aria-label="网络设置">
      <div className="settings-card-heading">
        <Network size={19} />
        <div>
          <h2>网络设置</h2>
          <p>服务器共享设置，适用于所有连接此服务器的设备</p>
        </div>
      </div>
      {request.error ? (
        <Notice onRetry={request.retry}>{request.error}</Notice>
      ) : !form ? (
        <p className="muted small">正在读取网络设置…</p>
      ) : (
        <form
          className="network-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit('save');
          }}
        >
          {proxyRows.map(({ key, label, help }) => (
            <div className="setting-row" key={key}>
              <div>
                <h3>{label}</h3>
                <p>{help}</p>
              </div>
              <button
                type="button"
                className={`switch ${form[key] ? 'on' : ''}`}
                role="switch"
                aria-checked={form[key]}
                aria-label={label}
                disabled={disabled}
                onClick={() => change(key, !form[key])}
              >
                <span />
              </button>
            </div>
          ))}
          <fieldset disabled={disabled} className="network-fields">
            <label>
              <span>代理地址</span>
              <input
                type="text"
                value={form.url}
                placeholder="http://127.0.0.1:7890"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => change('url', event.target.value)}
                aria-describedby="proxy-address-help"
              />
            </label>
            <p id="proxy-address-help" className="muted small">
              五类请求共用此代理地址和认证信息，开关分别生效。支持 http://、https:// 和
              socks5://。Docker 中的本机地址指向容器自身，访问宿主机可使用 host.docker.internal。
            </p>
            <div className="network-credentials">
              <label>
                <span>代理用户名（可选）</span>
                <input
                  value={form.username}
                  autoComplete="off"
                  onChange={(event) => change('username', event.target.value)}
                />
              </label>
              <label>
                <span>代理密码（可选）</span>
                <input
                  type="password"
                  value={form.password}
                  autoComplete="new-password"
                  placeholder={
                    form.hasPassword && !passwordChanged ? '已保存密码，留空保持不变' : '未设置密码'
                  }
                  onChange={(event) => change('password', event.target.value)}
                />
              </label>
            </div>
            {form.hasPassword && (
              <button type="button" className="text-button" onClick={() => change('password', '')}>
                {passwordChanged && !form.password ? '保存后清除密码' : '清除已保存密码'}
              </button>
            )}
          </fieldset>
          <div className="setting-row">
            <div>
              <h3>启用 Bangumi API ECH</h3>
              <p>API 代理关闭时按此开关连接。封面单独设置，ECH 失败时会报告错误。</p>
            </div>
            <button
              type="button"
              className={`switch ${form.bangumiEch ? 'on' : ''}`}
              role="switch"
              aria-checked={form.bangumiEch}
              aria-label="启用 Bangumi API ECH"
              disabled={disabled}
              onClick={() => change('bangumiEch', !form.bangumiEch)}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <div>
              <h3 id="image-acceleration-label">封面请求方式</h3>
              <p id="image-acceleration-help">
                镜像通过 wsrv.nl 加载，ECH 加密握手，直连加载原图。图片代理开启时优先使用代理。
              </p>
            </div>
            <select
              aria-labelledby="image-acceleration-label"
              aria-describedby="image-acceleration-help"
              value={form.imageAcceleration}
              disabled={disabled}
              onChange={(event) => change('imageAcceleration', event.target.value)}
            >
              {Object.entries(imageModes).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <fieldset disabled={disabled} className="network-fields">
            <label>
              <span>ECH DNS 地址</span>
              <input
                type="url"
                value={form.echDohUrl}
                placeholder="https://1.1.1.1/dns-query"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => change('echDohUrl', event.target.value)}
                aria-describedby="ech-dns-help"
              />
            </label>
            <p id="ech-dns-help" className="muted small">
              API 和封面 ECH 共用此 DNS 地址。Docker 已内置 ECH 工具；本地开发需先运行 npm run
              build:ech。
            </p>
            <label>
              <span>测试请求类型</span>
              <select
                value={testScope}
                onChange={(event) => {
                  setTestScope(event.target.value);
                  setResult('');
                  setError('');
                }}
              >
                {proxyRows.map(({ scope, label }) => (
                  <option key={scope} value={scope}>
                    {label.replace(/代理$/, '')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>测试地址</span>
              <input
                type="url"
                value={testUrl}
                placeholder="填写要测试的视频源或视频地址"
                onChange={(event) => {
                  setTestUrls((previous) => ({ ...previous, [testScope]: event.target.value }));
                  setResult('');
                  setError('');
                }}
              />
            </label>
            <p className="muted small">
              按所选类型和当前表单设置测试，无需先保存。可修改测试地址，各类型分别保留。 Bangumi
              图片测试遵循封面方式；归档默认检查版本接口，不下载完整归档。
            </p>
          </fieldset>
          <p className="muted small">
            保存后新请求即时生效，无需重启，已有连接可能继续使用原设置，封面缓存继续复用。
            右上角仅控制视频请求代理。
          </p>
          <div className="button-group">
            <button type="submit" className="button primary" disabled={disabled}>
              <Save size={15} />
              {busy === 'save' ? '正在保存…' : '保存网络设置'}
            </button>
            <button
              type="button"
              className="button quiet"
              disabled={disabled || !testUrl.trim()}
              onClick={() => submit('test')}
            >
              <Wifi size={15} />
              {busy === 'test' ? '正在测试…' : '测试连接'}
            </button>
          </div>
          {result && (
            <p className="network-result muted small" role="status">
              {result === 'saved'
                ? `已保存。${proxyRows.map(({ key, label }) => `${label}：${request.data[key] ? '开' : '关'}`).join('；')}。`
                : result}
            </p>
          )}
          {error && <Notice>{error}</Notice>}
        </form>
      )}
    </section>
  );
}
