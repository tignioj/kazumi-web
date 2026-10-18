import React, { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Save } from 'lucide-react';
import { useRequest } from '../../hooks/use-request.js';
import { api } from '../../lib/api.js';
import { Notice } from '../../components/feedback.jsx';
import { MAX_DOWNLOAD_THREADS } from '../../../shared/download-settings.js';

export function DownloadSettings({ notify, navigate }) {
  const request = useRequest('/download-settings');
  const [threads, setThreads] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (request.data) setThreads(request.data.threads);
  }, [request.data]);
  return (
    <section className="settings-card" aria-label="视频下载与缓存">
      <div className="settings-card-heading">
        <ArrowDownToLine size={19} />
        <div>
          <h2>视频下载与缓存</h2>
          <p>服务器共享设置，适用于所有连接此服务器的设备</p>
        </div>
      </div>
      {request.error ? (
        <Notice onRetry={request.retry}>{request.error}</Notice>
      ) : threads === null ? (
        <p className="muted small">正在读取下载设置…</p>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            try {
              const saved = await api('/download-settings', {
                method: 'PUT',
                body: JSON.stringify({ threads }),
              });
              setThreads(saved.threads);
              notify('下载设置已保存，新开始或重试的任务将使用此线程数');
            } catch (error) {
              setError(error.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="setting-row">
            <div>
              <h3>单集下载线程数</h3>
              <p>普通视频并行下载字节范围，HLS 并行下载分片；源站不支持范围请求时使用单连接。</p>
            </div>
            <select
              aria-label="单集下载线程数"
              value={threads}
              disabled={busy || request.loading}
              onChange={(event) => setThreads(Number(event.target.value))}
            >
              {Array.from({ length: MAX_DOWNLOAD_THREADS }, (_, i) => i + 1).map((value) => (
                <option key={value} value={value}>
                  {value} 线程
                </option>
              ))}
            </select>
          </div>
          <p className="muted small">
            在下载缓存中可随时暂停或继续，暂停后保留已下载进度。下载中断后也会保留可续传内容。普通视频需源站支持范围请求和文件版本校验；HLS
            复用已完成分片。来源或文件发生变化时会重新下载。
          </p>
          <div className="button-group">
            <button type="submit" className="button primary" disabled={busy || request.loading}>
              <Save size={15} />
              {busy ? '正在保存…' : '保存下载设置'}
            </button>
          </div>
          {error && <Notice>{error}</Notice>}
        </form>
      )}
      <p className="muted small">视频缓存及下载设置保存在服务器，不包含在浏览器数据备份中。</p>
      <div className="button-group">
        <button className="button quiet" onClick={() => navigate('/downloads')}>
          管理视频缓存 <ArrowRight size={15} />
        </button>
      </div>
    </section>
  );
}
