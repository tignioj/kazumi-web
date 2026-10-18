import React, { useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api.js';

export function CacheRetry({ item, onRetried, notify }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = async () => {
    if (busy || item.status !== 'error') return;
    setBusy(true);
    setError('');
    try {
      const result = await api('/downloads/batch', {
        method: 'POST',
        body: JSON.stringify({
          ruleName: item.ruleName,
          sourceUrl: item.sourceUrl,
          title: item.title,
          image: item.image,
          subjectId: item.subjectId,
          episodes: [{ name: item.episodeName, url: item.episodeUrl }],
        }),
      });
      onRetried(result.items);
      notify(result.added ? '已重新加入缓存任务，关闭页面后仍会继续' : '当前剧集已缓存或加入任务');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cache-retry">
      <button
        className="button quiet"
        disabled={busy}
        onClick={retry}
        aria-label={`重试下载 ${item.title} ${item.episodeName || '当前剧集'}`}
      >
        {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
        {busy ? '正在重试…' : '重试下载'}
      </button>
      {error && (
        <span className="cache-help cache-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
