import React, { useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  CircleAlert,
  Download,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { downloadJSON } from '../../lib/download-json.js';
import { useRequest } from '../../hooks/use-request.js';
import { Notice, Empty, Spinner } from '../../components/feedback.jsx';
import { PageHeading } from '../../components/PageHeading.jsx';
import { Modal } from '../../components/Modal.jsx';

export function Rules({
  rules,
  error,
  reload,
  notify,
  availableUpdates,
  compatibility = [],
  blockedUpdates = [],
}) {
  const [tab, setTab] = useState('installed');
  const [modal, setModal] = useState(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteRule, setDeleteRule] = useState(null);
  const fileRef = useRef();
  const catalog = useRequest(tab === 'catalog' ? '/rules/catalog' : null);
  const [installing, setInstalling] = useState('');
  const [updateResults, setUpdateResults] = useState([]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const compatibilityByName = new Map(compatibility.map((rule) => [rule.name.toLowerCase(), rule]));
  const blockedByName = new Map(blockedUpdates.map((rule) => [rule.name.toLowerCase(), rule]));
  const openImport = () => {
    setModal({ type: 'import' });
    setContent('');
    setFormError('');
  };
  const save = async () => {
    if (!content.trim()) return;
    setBusy(true);
    setFormError('');
    try {
      if (modal.type === 'edit')
        await api(`/rules/${encodeURIComponent(modal.rule.name)}`, {
          method: 'PUT',
          body: JSON.stringify(JSON.parse(content)),
        });
      else await api('/rules/import', { method: 'POST', body: JSON.stringify({ content }) });
      await reload();
      setModal(null);
      notify(modal.type === 'edit' ? '规则已更新' : '规则已导入');
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const validate = async () => {
    setBusy(true);
    setFormError('');
    try {
      await api('/rules/validate', { method: 'POST', body: JSON.stringify({ content }) });
      notify('规则配置与兼容性检查通过');
    } catch (error) {
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  };
  const install = async (name) => {
    setInstalling(name);
    try {
      await api('/rules/install', { method: 'POST', body: JSON.stringify({ name }) });
      await reload();
      notify(`已安装「${name}」`);
    } catch (e) {
      notify(e.message);
    } finally {
      setInstalling('');
    }
  };
  const update = async (name) => {
    setInstalling(name || '*');
    setUpdateResults([]);
    try {
      const { results } = await api('/rules/update', {
        method: 'POST',
        body: JSON.stringify(name ? { name } : {}),
      });
      await reload();
      if (tab === 'catalog') catalog.retry();
      setUpdateResults(results.filter((result) => !['updated', 'latest'].includes(result.status)));
      const updated = results.filter((result) => result.status === 'updated').length;
      const latest = results.filter((result) => result.status === 'latest').length;
      notify(
        updated
          ? `已更新 ${updated} 条规则`
          : latest === results.length
            ? '规则已是最新版本'
            : '规则更新完成，请查看更新结果',
      );
    } catch (e) {
      notify(e.message);
    } finally {
      setInstalling('');
    }
  };
  const readFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setContent(await file.text());
      setFormError('');
    } catch {
      setFormError('文件读取失败，请重新选择。');
    }
    e.target.value = '';
  };
  const remoteRules = catalog.data?.rules || [];
  return (
    <>
      <PageHeading
        eyebrow="MAKE KAZUMI YOUR OWN"
        title="规则，连接故事"
        description="管理用于搜索与播放的站点规则。已安装规则由部署服务共享。"
      >
        <button className="button primary" onClick={openImport}>
          <Plus size={17} />
          导入规则
        </button>
      </PageHeading>
      <div className="collection-toolbar">
        <div className="filter-tabs">
          <button
            className={tab === 'installed' ? 'selected' : ''}
            onClick={() => setTab('installed')}
          >
            已安装<span>{rules.length}</span>
          </button>
          <button className={tab === 'catalog' ? 'selected' : ''} onClick={() => setTab('catalog')}>
            在线目录
            <ArrowDownToLine size={14} />
          </button>
        </div>
        {rules.length > 0 && tab === 'installed' && (
          <div className="button-group">
            <button className="text-button" disabled={!!installing} onClick={() => update()}>
              <RefreshCw size={15} className={installing === '*' ? 'spin' : ''} />
              {installing === '*' ? '正在更新…' : '更新全部'}
              {installing !== '*' && availableUpdates.size > 0 && `（${availableUpdates.size}）`}
            </button>
            <button
              className="text-button"
              onClick={() => downloadJSON(rules, 'kazumi-rules.json')}
            >
              <Download size={15} />
              导出全部规则
            </button>
          </div>
        )}
      </div>
      {error && <Notice onRetry={reload}>{error}</Notice>}
      {updateResults.length > 0 && (
        <Notice>
          {updateResults.map((result) => (
            <span key={result.name}>
              {result.name}：{result.message}
              <br />
            </span>
          ))}
        </Notice>
      )}
      {tab === 'installed' &&
        (rules.length ? (
          <div className="rule-grid">
            {rules.map((rule) => {
              const compatibility = compatibilityByName.get(rule.name.toLowerCase());
              const blocked = blockedByName.get(rule.name.toLowerCase());
              return (
                <article className="rule-card" key={rule.name}>
                  <div className="rule-card-top">
                    <span className="rule-symbol">{rule.name?.slice(0, 1)}</span>
                    {blocked ? (
                      <span className="rule-badge rule-update-badge">更新受阻</span>
                    ) : availableUpdates.has(rule.name.toLowerCase()) ? (
                      <span
                        className="rule-badge rule-update-badge"
                        title={`可更新至 ${availableUpdates.get(rule.name.toLowerCase())}`}
                      >
                        可更新
                      </span>
                    ) : (
                      <span className="rule-badge">已安装</span>
                    )}
                  </div>
                  <h3>{rule.name}</h3>
                  <p>{rule.baseURL || rule.baseUrl || '自定义站点规则'}</p>
                  <div className="rule-details">
                    <span>版本 {rule.version || '—'}</span>
                    <span>API {rule.api || '1'}</span>
                    <span>{rule.author || '社区规则'}</span>
                  </div>
                  {(blocked || compatibility?.compatible === false) && (
                    <p className="rule-compatibility" role="status">
                      {blocked
                        ? `已保留当前规则：${blocked.message}`
                        : compatibility.issues.map((issue) => issue.message).join('；')}
                    </p>
                  )}
                  <div className="rule-card-actions">
                    <button
                      className="text-button"
                      onClick={() => {
                        setModal({ type: 'edit', rule });
                        setContent(JSON.stringify(rule, null, 2));
                        setFormError('');
                      }}
                    >
                      <SlidersHorizontal size={14} />
                      编辑规则
                    </button>
                    <div>
                      <button
                        className="icon-button"
                        aria-label={`更新 ${rule.name}`}
                        title="从官方目录更新规则"
                        disabled={!!installing}
                        onClick={() => update(rule.name)}
                      >
                        <RefreshCw size={16} className={installing === rule.name ? 'spin' : ''} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`导出 ${rule.name}`}
                        onClick={() => downloadJSON(rule, `${rule.name}.json`)}
                      >
                        <Download size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`删除 ${rule.name}`}
                        onClick={() => setDeleteRule(rule)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={SlidersHorizontal}
            title="让故事，有迹可循"
            action={
              <div className="button-group">
                <button className="button primary" onClick={() => setTab('catalog')}>
                  浏览在线规则
                  <ArrowRight size={15} />
                </button>
                <button className="button quiet" onClick={openImport}>
                  手动导入
                </button>
              </div>
            }
          >
            安装一个规则，即可搜索相应站点的片源。
            <br />
            支持 Kazumi JSON 和 kazumi:// 分享链接。
          </Empty>
        ))}
      {tab === 'catalog' && (
        <>
          {catalog.error ? (
            <Notice onRetry={catalog.retry}>{catalog.error}</Notice>
          ) : catalog.loading ? (
            <Spinner text="正在获取在线规则目录…" />
          ) : (
            <>
              <label className="inline-search catalog-search">
                <Search size={16} />
                <input
                  placeholder="筛选规则名称"
                  aria-label="筛选在线规则"
                  value={catalogFilter}
                  onChange={(e) => setCatalogFilter(e.target.value)}
                />
              </label>
              <div className="catalog-rules">
                {remoteRules
                  .filter((r) => r.name.toLowerCase().includes(catalogFilter.toLowerCase()))
                  .map((rule) => {
                    const installed = rules.some(
                      (r) => r.name.toLowerCase() === rule.name.toLowerCase(),
                    );
                    return (
                      <article key={rule.name}>
                        <span className="rule-symbol">{rule.name.slice(0, 1)}</span>
                        <div>
                          <h3>{rule.name}</h3>
                          <p>
                            {rule.author || rule.baseURL || 'Kazumi 社区规则'}
                            {rule.version ? ` · v${rule.version}` : ''}
                          </p>
                        </div>
                        <button
                          className={`button ${installed ? 'quiet' : 'primary'}`}
                          disabled={!!installing}
                          onClick={() => (installed ? update(rule.name) : install(rule.name))}
                        >
                          {installing === rule.name ? (
                            <LoaderCircle size={15} className="spin" />
                          ) : installed ? (
                            <RefreshCw size={14} />
                          ) : (
                            <Plus size={15} />
                          )}
                          {installed ? '检查更新' : '安装'}
                        </button>
                      </article>
                    );
                  })}
              </div>
              {!remoteRules.length && (
                <Empty title="目录暂时没有规则">你仍然可以通过 JSON 文件手动导入规则。</Empty>
              )}
            </>
          )}
        </>
      )}
      <div className="info-footnote">
        <CircleAlert size={16} />
        <p>
          规则描述了如何读取来源站点，并不包含视频内容。请仅使用你有权访问的片源；来源失效时可编辑或更新规则。
        </p>
      </div>
      {modal && (
        <Modal
          wide
          title={modal.type === 'edit' ? `编辑规则 · ${modal.rule.name}` : '导入 Kazumi 规则'}
          onClose={() => !busy && setModal(null)}
        >
          <p className="muted">
            {modal.type === 'edit'
              ? '编辑完整的规则 JSON，保存后立即生效。'
              : '粘贴完整规则、规则数组或 kazumi:// 分享链接，也可以选择本地 JSON 文件。保存前可检查兼容性。'}
          </p>
          {modal.type === 'import' && (
            <>
              <input
                type="file"
                accept=".json,.txt,application/json"
                ref={fileRef}
                hidden
                onChange={readFile}
              />
              <button
                className="button quiet upload-button"
                onClick={() => fileRef.current.click()}
              >
                <Upload size={16} />
                选择本地文件
              </button>
            </>
          )}
          <textarea
            className="code-input"
            spellCheck="false"
            aria-label="规则 JSON 或分享链接"
            placeholder={'{\n  "name": "我的规则",\n  "baseURL": "https://…"\n}'}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          {formError && <Notice>{formError}</Notice>}
          <div className="modal-actions">
            <button className="button quiet" disabled={busy || !content.trim()} onClick={validate}>
              检查兼容性
            </button>
            <button className="button quiet" disabled={busy} onClick={() => setModal(null)}>
              取消
            </button>
            <button className="button primary" disabled={busy || !content.trim()} onClick={save}>
              {busy && <LoaderCircle size={15} className="spin" />}
              {modal.type === 'edit' ? '保存规则' : '导入规则'}
            </button>
          </div>
        </Modal>
      )}
      {deleteRule && (
        <Modal title="删除规则" onClose={() => !busy && setDeleteRule(null)}>
          <p>
            删除「{deleteRule.name}
            」后，使用本部署的所有浏览器将无法再通过它搜索片源。之后可以重新导入。
          </p>
          {formError && <Notice>{formError}</Notice>}
          <div className="modal-actions">
            <button className="button quiet" disabled={busy} onClick={() => setDeleteRule(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFormError('');
                try {
                  await api(`/rules/${encodeURIComponent(deleteRule.name)}`, { method: 'DELETE' });
                  await reload();
                  setDeleteRule(null);
                  notify('规则已删除');
                } catch (e) {
                  setFormError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              删除规则
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
