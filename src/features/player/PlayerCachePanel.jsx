import React, { useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Download,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { Notice } from '../../components/feedback.jsx';
import { cacheActive, sameCacheEpisode } from '../downloads/utils.js';
import { useDownloads } from '../downloads/use-downloads.js';
import { CacheProgress } from '../downloads/CacheProgress.jsx';
import { CacheRemoval } from '../downloads/CacheRemoval.jsx';
import { CacheSelection } from '../downloads/CacheSelection.jsx';
import { CacheRetry } from '../downloads/CacheRetry.jsx';

export function PlayerCachePanel({
  context,
  episode,
  episodes,
  roadName,
  resolved,
  onCacheRemoved,
  navigate,
  notify,
}) {
  const downloads = useDownloads('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const item = downloads.items.find((entry) =>
    sameCacheEpisode(entry, context.ruleName, episode.url),
  );
  const canCache = resolved && ['video', 'hls'].includes(resolved.type) && !resolved.cached;
  const create = async () => {
    if (!canCache || busy) return;
    setBusy('current');
    setError('');
    try {
      const created = await api('/downloads', {
        method: 'POST',
        body: JSON.stringify({
          ruleName: context.ruleName,
          episodeUrl: episode.url,
          sourceUrl: context.sourceUrl,
          title: context.title,
          episodeName: episode.name,
          image: context.image,
          subjectId: context.subjectId,
          mediaUrl: resolved.url,
          type: resolved.type,
        }),
      });
      downloads.accept(created);
      notify(created.status === 'complete' ? '当前集已缓存' : '已加入缓存任务，关闭页面后仍会继续');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="player-cache-panel" aria-label="剧集缓存">
      <div className="player-cache-heading">
        <div>
          <h2>
            <ArrowDownToLine size={17} />
            剧集缓存
          </h2>
          <p>
            {resolved?.cached ? '正在播放服务器缓存。' : '缓存到服务器，关闭页面后仍会继续下载。'}
          </p>
        </div>
        <button className="text-button" onClick={() => navigate('/downloads')}>
          管理缓存 <ArrowRight size={14} />
        </button>
      </div>
      {item && <CacheProgress item={item} />}
      {downloads.error && (
        <Notice onRetry={downloads.reload}>无法读取缓存状态：{downloads.error}</Notice>
      )}
      {error && <Notice>{error}</Notice>}
      <div className="player-cache-actions">
        {item?.status === 'error' && (
          <CacheRetry key={item.id} item={item} onRetried={downloads.accept} notify={notify} />
        )}
        {!item && !resolved?.cached && (
          <button className="button quiet" disabled={!canCache || busy} onClick={create}>
            {busy === 'current' ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <ArrowDownToLine size={15} />
            )}
            缓存当前集
          </button>
        )}
        {!context.cacheOnly && (
          <button
            className="button quiet"
            disabled={!!busy || !episodes.length}
            onClick={() => setSelecting(true)}
          >
            <ArrowDownToLine size={15} />
            选择剧集缓存
          </button>
        )}
        {item?.status === 'complete' && (
          <a className="button quiet" href={item.downloadUrl} download>
            <Download size={15} />
            {item.type === 'hls' ? '保存压缩包到设备' : '保存视频到设备'}
          </a>
        )}
        {item && (
          <button className="text-button" onClick={() => setRemoving(item)}>
            <Trash2 size={14} />
            {cacheActive(item) ? '取消下载' : '清理当前缓存'}
          </button>
        )}
        {!item && resolved?.cached && !downloads.loading && !downloads.error && (
          <button className="button quiet" onClick={onCacheRemoved}>
            <RefreshCw size={15} />
            缓存已被移除，重新解析
          </button>
        )}
        {resolved?.type === 'iframe' && (
          <span className="cache-help">站点内嵌播放器无法缓存，请切换可直接播放的视频线路。</span>
        )}
        {!context.cacheOnly && (
          <span className="cache-help">
            支持全选当前线路或勾选指定剧集，自动跳过已缓存或正在下载的剧集。
          </span>
        )}
        {item?.status === 'complete' && item.type === 'hls' && (
          <span className="cache-help">HLS 压缩包包含播放列表与分片，不会合并为 MP4。</span>
        )}
      </div>
      {selecting && (
        <CacheSelection
          context={context}
          episodes={episodes}
          roadName={roadName}
          downloads={downloads}
          onClose={() => setSelecting(false)}
          onCreated={(result) => {
            downloads.accept(result.items);
            setSelecting(false);
            notify(
              result.added
                ? `已加入 ${result.added} 集缓存任务${result.skipped ? `，跳过 ${result.skipped} 集已有任务` : ''}，关闭页面后仍会继续`
                : '所选剧集均已缓存或加入任务',
            );
          }}
        />
      )}
      {removing && (
        <CacheRemoval
          item={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            downloads.forget(removing.id);
            if (resolved?.cached) onCacheRemoved();
            notify('当前剧集缓存已删除');
          }}
        />
      )}
    </section>
  );
}
