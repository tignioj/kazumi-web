import React, { useEffect, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useRequest } from '../../hooks/use-request.js';
import { Notice } from '../../components/feedback.jsx';
import { bytesLabel } from '../../lib/format.js';

export function MetadataSettings({ notify }) {
  const request = useRequest('/metadata/status');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = request.data;
  useEffect(() => {
    const timer = setInterval(request.retry, status?.updating ? 2000 : 30000);
    return () => clearInterval(timer);
  }, [request.retry, status?.updating]);
  const phases = {
    idle: '等待首次导入',
    checking: '正在检查新资料',
    downloading: '正在下载资料包',
    verifying: '正在校验资料包',
    subjects: '正在整理番剧',
    episodes: '正在整理章节',
    indexing: '正在建立搜索索引',
    current: '资料已就绪',
    error: '更新未完成',
  };
  const update = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/metadata/update', { method: 'POST', body: '{}' });
      request.retry();
      notify('已开始检查番剧资料更新');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-card" aria-label="本地番剧资料">
      <div className="settings-card-heading">
        <BookOpen size={19} />
        <div>
          <h2>本地番剧资料</h2>
          <p>番剧浏览、热门榜单与放送日历使用本地资料</p>
        </div>
      </div>
      {request.error ? (
        <Notice onRetry={request.retry}>{request.error}</Notice>
      ) : !status ? (
        <p className="muted small">正在读取资料状态…</p>
      ) : status.mode === 'remote' ? (
        <p className="muted small">当前使用远程资料服务。</p>
      ) : (
        <>
          <p className="metadata-state" role="status" aria-live="polite">
            {phases[status.phase] || '正在更新资料'}
            {status.ready && (
              <span className="muted small">
                {' '}
                · {status.current.subjects.toLocaleString()} 部动画
              </span>
            )}
          </p>
          {status.current && (
            <p className="muted small metadata-version">
              资料版本：{status.current.version}
              <br />
              导入时间：{new Date(status.current.importedAt).toLocaleString('zh-CN')}
            </p>
          )}
          {status.phase === 'downloading' && status.progress?.totalBytes > 0 && (
            <div className="metadata-progress">
              <progress
                value={status.progress.bytes}
                max={status.progress.totalBytes}
                aria-label="归档下载进度"
              />
              <span className="muted small">
                {bytesLabel(status.progress.bytes)} / {bytesLabel(status.progress.totalBytes)}
              </span>
            </div>
          )}
          {['subjects', 'episodes'].includes(status.phase) && status.progress?.processed > 0 && (
            <p className="muted small">
              已处理 {status.progress.processed.toLocaleString()} 条记录
            </p>
          )}
          <p className="muted small">
            {status.autoUpdate
              ? `每 ${status.intervalHours} 小时自动检查更新。`
              : '自动更新已关闭，可手动检查。'}
            官方归档每周更新，更新期间仍可浏览已有资料。热门按近一年开播作品的累计收藏人数排序，日历依据已记录的章节日期；封面按需加载并缓存。
          </p>
          {(error || status.lastError) && (
            <Notice>
              {status.ready ? '更新失败，已有资料仍可使用。' : ''}
              {error || status.lastError}
            </Notice>
          )}
          <div className="button-group">
            <button className="button quiet" disabled={busy || status.updating} onClick={update}>
              <RefreshCw size={15} />
              {busy || status.updating
                ? '正在更新…'
                : status.ready
                  ? '检查资料更新'
                  : '下载番剧资料'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
