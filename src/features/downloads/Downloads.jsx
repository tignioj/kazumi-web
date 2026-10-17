import React, { useState } from 'react';
import { imageSource } from '../../../shared/images.js';
import { CachedImage } from '../../components/CachedImage.jsx';
import {
  ArrowDownToLine,
  ChevronDown,
  Download,
  Film,
  Play,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { Notice, Empty, Spinner } from '../../components/feedback.jsx';
import { PageHeading } from '../../components/PageHeading.jsx';
import { bytesLabel } from '../../lib/format.js';
import { cacheActive, groupDownloads } from './utils.js';
import { useDownloads } from './use-downloads.js';
import { CacheProgress } from './CacheProgress.jsx';
import { CacheRemoval } from './CacheRemoval.jsx';

function DownloadGroup({ items, onPlay, onRemove }) {
  const item = items[0];
  const image = items.find((entry) => entry.image)?.image;
  const complete = items.filter((entry) => entry.status === 'complete').length;
  const active = items.filter(cacheActive).length;
  const failed = items.filter((entry) => entry.status === 'error').length;
  const bytes = items.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
  return (
    <details className="cache-group" open>
      <summary className="cache-group-heading">
        <div className="cache-cover">
          {image ? (
            <CachedImage
              referrerPolicy="no-referrer"
              src={imageSource(image)}
              alt=""
              loading="lazy"
            />
          ) : (
            <Film size={24} />
          )}
        </div>
        <div className="cache-group-description">
          <h3>{item.title}</h3>
          <p>
            {item.ruleName} · {items.length} 集
          </p>
          <div className="cache-group-stats">
            {complete > 0 && <span className="cache-status-complete">已缓存 {complete} 集</span>}
            {active > 0 && <span>下载中 {active} 集</span>}
            {failed > 0 && <span className="cache-status-error">失败 {failed} 集</span>}
            <span>{bytesLabel(bytes)}</span>
          </div>
        </div>
        <button
          className="text-button cache-group-remove"
          aria-label={`删除整组缓存 ${item.title} ${item.ruleName}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove({ title: item.title, ruleName: item.ruleName, items });
          }}
        >
          <Trash2 size={14} />
          删除整组
        </button>
        <ChevronDown size={18} className="cache-group-toggle" aria-hidden="true" />
      </summary>
      <ul className="cache-episodes" aria-label={`${item.title} · ${item.ruleName}的缓存剧集`}>
        {items.map((episode) => (
          <li className="cache-row" key={episode.id}>
            <div className="cache-description">
              <div className="cache-episode-heading">
                <h4>{episode.episodeName || '当前剧集'}</h4>
                <span>{episode.type === 'hls' ? 'HLS' : '视频'}</span>
              </div>
              <CacheProgress item={episode} />
            </div>
            <div className="cache-actions">
              {episode.status === 'complete' && (
                <>
                  <button
                    className="button primary"
                    onClick={() => onPlay(episode, items)}
                    aria-label={`播放缓存 ${episode.title} ${episode.episodeName}`}
                  >
                    <Play size={15} />
                    播放
                  </button>
                  <a
                    className="button quiet"
                    href={episode.downloadUrl}
                    download
                    aria-label={`保存到设备 ${episode.title} ${episode.episodeName}`}
                  >
                    <Download size={15} />
                    {episode.type === 'hls' ? '保存压缩包' : '保存视频'}
                  </a>
                </>
              )}
              <button
                className="icon-button"
                onClick={() => onRemove(episode)}
                aria-label={`删除缓存 ${episode.title} ${episode.episodeName}`}
                title={cacheActive(episode) ? '取消下载并删除缓存' : '删除缓存'}
              >
                {cacheActive(episode) ? <X size={17} /> : <Trash2 size={17} />}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Downloads({ onPlay, notify }) {
  const downloads = useDownloads('all');
  const [removing, setRemoving] = useState(null);
  const groups = groupDownloads(downloads.items);
  const active = downloads.items.filter(cacheActive).length;
  const maxBytes = Number(downloads.data?.maxBytes) || 0;
  const usedBytes = Number(downloads.data?.usedBytes) || 0;
  return (
    <>
      <PageHeading
        eyebrow="KEEP THE NEXT EPISODE CLOSE"
        title="下载缓存"
        description="先缓存，再安心观看。已缓存的视频可直接播放，也可保存到设备。"
      >
        <button
          className="button quiet"
          disabled={!downloads.items.length}
          onClick={() => setRemoving('all')}
        >
          <Trash2 size={15} />
          清空缓存
        </button>
      </PageHeading>
      <section className="cache-storage">
        <div className="cache-storage-heading">
          <span className="cache-storage-icon">
            <ArrowDownToLine size={22} />
          </span>
          <div>
            <h2>服务器视频缓存</h2>
            <p>
              {downloads.data
                ? `${bytesLabel(usedBytes)}${maxBytes ? ` / ${bytesLabel(maxBytes)}` : ''}`
                : '正在读取容量…'}
            </p>
          </div>
          <button className="text-button" onClick={downloads.reload}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
        {maxBytes > 0 && (
          <div className="progress-track cache-storage-track" aria-label="缓存空间使用量">
            <span style={{ width: `${Math.min(100, (usedBytes / maxBytes) * 100)}%` }} />
          </div>
        )}
        <p className="cache-help">
          缓存保存在部署服务器上，所有访问者共享；关闭页面后任务继续。播放仍需连接此服务器。 HLS
          保存到设备时为包含播放列表与分片的压缩包，不会合并为 MP4。
        </p>
      </section>
      <div className="catalog-toolbar">
        <div className="section-title">
          <span className="section-number">SAVED</span>
          <h2>缓存任务</h2>
        </div>
        <span className="muted small">
          {groups.length} 个片源列表 · {downloads.items.length} 个任务
          {active ? ` · ${active} 个正在下载` : ''}
        </span>
      </div>
      {downloads.error && <Notice onRetry={downloads.reload}>{downloads.error}</Notice>}
      {downloads.loading ? (
        <Spinner text="正在读取视频缓存…" />
      ) : downloads.items.length ? (
        <div className="cache-list">
          {groups.map((group) => (
            <DownloadGroup
              key={group.key}
              items={group.items}
              onPlay={onPlay}
              onRemove={setRemoving}
            />
          ))}
        </div>
      ) : (
        !downloads.error && (
          <Empty icon={ArrowDownToLine} title="把下一话，提前准备好">
            播放视频时点击「缓存当前集」，即可在这里管理下载进度与已缓存的视频。
          </Empty>
        )
      )}
      {removing && (
        <CacheRemoval
          item={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            downloads.forget(
              removing === 'all' ? 'all' : removing.items?.map((item) => item.id) || removing.id,
            );
            notify(
              removing === 'all'
                ? '全部视频缓存已清空'
                : removing.items
                  ? '本片源的整组缓存已删除'
                  : '视频缓存已删除',
            );
          }}
        />
      )}
    </>
  );
}
