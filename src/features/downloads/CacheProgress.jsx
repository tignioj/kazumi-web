import React from 'react';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { bytesLabel } from '../../lib/format.js';
import { cacheActive, cacheStatus } from './utils.js';

export function CacheProgress({ item }) {
  const total = item.type === 'hls' ? item.totalFiles : item.totalBytes;
  const done = Number(item.type === 'hls' ? item.completedFiles : item.bytes) || 0;
  const percentage =
    item.status === 'complete' ? 100 : total > 0 ? Math.min(100, (done / total) * 100) : null;
  return (
    <div className="cache-progress">
      <div className="cache-progress-label">
        <span className={`cache-status cache-status-${item.status}`}>
          {cacheActive(item) && <LoaderCircle size={13} className="spin" />}
          {item.status === 'complete' && <Check size={13} />}
          {item.status === 'error' && <CircleAlert size={13} />}
          {cacheStatus(item)}
        </span>
        <span>
          {bytesLabel(item.bytes)}
          {item.type !== 'hls' && item.totalBytes > 0 && item.status !== 'complete'
            ? ` / ${bytesLabel(item.totalBytes)}`
            : ''}
          {item.type === 'hls' && item.totalFiles > 0 && item.status !== 'complete'
            ? ` · ${item.completedFiles || 0}/${item.totalFiles} 个文件`
            : ''}
        </span>
      </div>
      {cacheActive(item) && (
        <div
          className={`progress-track ${percentage === null ? 'cache-indeterminate' : ''}`}
          role="progressbar"
          aria-label="视频缓存进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage === null ? undefined : Math.round(percentage)}
          aria-valuetext={percentage === null ? '正在下载，大小未知' : `${Math.round(percentage)}%`}
        >
          <span style={{ width: `${percentage === null ? 35 : percentage}%` }} />
        </div>
      )}
      {item.error && <p className="cache-error">{item.error}</p>}
    </div>
  );
}
