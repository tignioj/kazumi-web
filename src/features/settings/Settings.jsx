import React, { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Download, Sun, Upload } from 'lucide-react';
import { downloadJSON } from '../../lib/download-json.js';
import { useRequest } from '../../hooks/use-request.js';
import { Notice } from '../../components/feedback.jsx';
import { PageHeading } from '../../components/PageHeading.jsx';
import { Modal } from '../../components/Modal.jsx';
import { normalizeBackup } from './backup.js';
import { MetadataSettings } from './MetadataSettings.jsx';
import { NetworkSettings } from './NetworkSettings.jsx';

export function Settings({ settings, setSettings, library, history, watchData, notify, navigate }) {
  const fileRef = useRef();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const health = useRequest('/health');
  const importData = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      setPending(normalizeBackup(JSON.parse(await file.text())));
    } catch (e) {
      setError(e.message);
    }
    e.target.value = '';
  };
  return (
    <>
      <PageHeading
        eyebrow="A SPACE THAT FEELS LIKE YOU"
        title="按你的方式"
        description="让每一次打开，都更合心意。"
      />
      <div className="settings-layout">
        <section className="settings-card">
          <div className="settings-card-heading">
            <Sun size={19} />
            <div>
              <h2>外观与播放</h2>
              <p>这些偏好只保存在当前浏览器</p>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <h3>显示主题</h3>
              <p>为白天与深夜，选择舒适的背景。</p>
            </div>
            <select
              value={settings.theme}
              onChange={(e) => setSettings((p) => ({ ...p, theme: e.target.value }))}
              aria-label="显示主题"
            >
              <option value="system">跟随系统</option>
              <option value="light">明亮</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <h3>自动播放下一话</h3>
              <p>直接播放的视频结束后，继续下一话。</p>
            </div>
            <button
              className={`switch ${settings.autoNext ? 'on' : ''}`}
              role="switch"
              aria-checked={settings.autoNext}
              aria-label="自动播放下一话"
              onClick={() => setSettings((p) => ({ ...p, autoNext: !p.autoNext }))}
            >
              <span />
            </button>
          </div>
        </section>
        <section className="settings-card">
          <div className="settings-card-heading">
            <Download size={19} />
            <div>
              <h2>你的数据，随身带走</h2>
              <p>收藏、观看进度与偏好设置</p>
            </div>
          </div>
          <div className="data-counts">
            <div>
              <strong>{Object.keys(library).length}</strong>
              <span>部收藏</span>
            </div>
            <div>
              <strong>{history.length}</strong>
              <span>条观看记录</span>
            </div>
          </div>
          <p className="muted small">
            收藏与观看记录保存在服务器，连接同一服务器的所有设备共享。偏好设置按浏览器保存。
            备份包含收藏、观看进度与本机偏好；站点规则请在规则管理页导出。
          </p>
          <div className="button-group">
            <button
              className="button primary"
              onClick={() => {
                downloadJSON(
                  {
                    format: 'kazumi-web-backup',
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    library,
                    history,
                    settings,
                  },
                  `kazumi-backup-${new Date().toISOString().slice(0, 10)}.json`,
                );
                notify('备份已导出');
              }}
            >
              <Download size={15} />
              导出备份
            </button>
            <button
              className="button quiet"
              disabled={busy}
              onClick={() => fileRef.current.click()}
            >
              <Upload size={15} />
              恢复备份
            </button>
            <input
              hidden
              type="file"
              accept=".json,application/json"
              ref={fileRef}
              onChange={importData}
            />
          </div>
          {watchData.legacy && (
            <>
              <p className="muted small">
                {watchData.legacy.error ||
                  '检测到此浏览器的旧收藏或观看记录。迁移会合并到服务器，保留服务器已有收藏和较新的进度。'}
              </p>
              {!watchData.legacy.error && (
                <button
                  className="button quiet"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      await watchData.migrate();
                      notify('浏览器旧数据已迁移到服务器');
                    } catch (error) {
                      setError(`迁移失败，浏览器旧数据已保留：${error.message}`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Upload size={15} />
                  {busy ? '正在保存…' : '迁移浏览器旧数据'}
                </button>
              )}
            </>
          )}
          {error && <Notice>{error}</Notice>}
        </section>
        <section className="settings-card">
          <div className="settings-card-heading">
            <ArrowDownToLine size={19} />
            <div>
              <h2>视频下载与缓存</h2>
              <p>缓存视频，查看下载进度，释放服务器空间</p>
            </div>
          </div>
          <p className="muted small">
            视频缓存保存在服务器，与所有访问者共享；不包含在浏览器数据备份中。
          </p>
          <div className="button-group">
            <button className="button quiet" onClick={() => navigate('/downloads')}>
              管理视频缓存 <ArrowRight size={15} />
            </button>
          </div>
        </section>
        <NetworkSettings notify={notify} />
        <MetadataSettings notify={notify} />
        <section className="settings-card about-card">
          <div className="about-brand">
            kazumi<span>.</span>
            <small>WEB EDITION</small>
          </div>
          <p>在浏览器里，拥有自己的动画空间。</p>
          <div className="about-status">
            <span className={`status-light ${health.error ? 'offline' : ''}`} />
            {health.loading ? '正在连接服务…' : health.error ? '服务暂时不可用' : '服务运行正常'}
            <span>Docker Compose ready</span>
          </div>
          <div className="muted small">元数据由 Bangumi 提供 · 收藏与观看记录保存在服务器</div>
        </section>
      </div>
      {pending && (
        <Modal title="恢复数据备份" onClose={() => !busy && setPending(null)}>
          <p>
            将恢复 {Object.keys(pending.library).length} 部收藏与 {pending.history.length}{' '}
            条观看记录，并覆盖服务器的共享记录及当前浏览器的偏好设置。所有设备都会受影响。
          </p>
          <div className="modal-actions">
            <button className="button quiet" disabled={busy} onClick={() => setPending(null)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await watchData.restore({ library: pending.library, history: pending.history });
                  setSettings(pending.settings);
                  setPending(null);
                  notify('备份已恢复到服务器');
                } catch (error) {
                  setError(`恢复失败：${error.message}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '正在恢复…' : '恢复备份'}
            </button>
          </div>
          {error && <Notice>{error}</Notice>}
        </Modal>
      )}
    </>
  );
}
