import React, { useState } from 'react';
import { LoaderCircle, Pause, Play } from 'lucide-react';
import { api } from '../../lib/api.js';

export function CacheTransferControl({ item, onChanged, notify }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const paused = item.status === 'paused';
  const action = paused ? 'resume' : 'pause';
  const label = paused ? '继续下载' : '暂停下载';
  return (
    <div className="cache-retry">
      <button
        className="button quiet"
        disabled={busy}
        aria-label={`${label} ${item.title} ${item.episodeName || '当前剧集'}`}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const changed = await api(`/downloads/${encodeURIComponent(item.id)}/${action}`, {
              method: 'POST',
              body: '{}',
            });
            onChanged(changed);
            notify(
              changed.status === 'complete'
                ? '当前集已缓存完成'
                : paused
                  ? '已继续下载'
                  : '下载已暂停，已下载进度已保留',
            );
          } catch (error) {
            setError(error.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <LoaderCircle size={15} className="spin" />
        ) : paused ? (
          <Play size={15} />
        ) : (
          <Pause size={15} />
        )}
        {busy ? (paused ? '正在继续…' : '正在暂停…') : label}
      </button>
      {error && (
        <span className="cache-help cache-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
