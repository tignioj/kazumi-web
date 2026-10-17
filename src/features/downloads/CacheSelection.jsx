import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, LoaderCircle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Notice, Spinner } from '../../components/feedback.jsx';
import { Modal } from '../../components/Modal.jsx';
import { sameCacheEpisode, cacheStatus } from './utils.js';

export function CacheSelection({ context, episodes, roadName, downloads, onClose, onCreated }) {
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectAllRef = useRef(null);
  const entries = [...new Map(episodes.map((ep) => [ep.url, ep])).values()].map((ep) => ({
    episode: ep,
    item: downloads.items.find((entry) => sameCacheEpisode(entry, context.ruleName, ep.url)),
  }));
  const available = entries.filter(({ item }) => !item || item.status === 'error');
  const chosen = available.filter(({ episode }) => selected.has(episode.url));
  const allSelected = available.length > 0 && chosen.length === available.length;
  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = chosen.length > 0 && !allSelected;
  }, [chosen.length, allSelected]);
  const submit = async () => {
    if (!chosen.length || chosen.length > 200 || busy || downloads.loading || downloads.error)
      return;
    setBusy(true);
    setError('');
    try {
      const result = await api('/downloads/batch', {
        method: 'POST',
        body: JSON.stringify({
          ruleName: context.ruleName,
          sourceUrl: context.sourceUrl,
          title: context.title,
          image: context.image,
          subjectId: context.subjectId,
          episodes: chosen.map(({ episode }) => episode),
        }),
      });
      onCreated(result);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="选择缓存剧集" onClose={() => !busy && onClose()} wide>
      <p>
        {roadName} · 共 {entries.length} 集。勾选指定剧集，或全选当前线路。
      </p>
      <p className="cache-help">已缓存或已加入任务的剧集会自动跳过，缓存失败的剧集可重新选择。</p>
      {downloads.error && <Notice onRetry={downloads.reload}>{downloads.error}</Notice>}
      {error && <Notice>{error}</Notice>}
      {downloads.loading ? (
        <Spinner text="正在读取缓存状态…" />
      ) : (
        <>
          <div className="cache-selection-toolbar">
            <label>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                disabled={busy || !available.length || !!downloads.error}
                onChange={(e) =>
                  setSelected(
                    new Set(e.target.checked ? available.map(({ episode }) => episode.url) : []),
                  )
                }
              />
              全选
            </label>
            <span aria-live="polite">
              已选 {chosen.length} / {available.length} 集可缓存剧集
            </span>
          </div>
          <div className="cache-selection-grid" role="group" aria-label="可选缓存剧集">
            {entries.map(({ episode: ep, item }, index) => {
              const blocked = !!item && item.status !== 'error';
              return (
                <label
                  className={`cache-episode-option ${!blocked && selected.has(ep.url) ? 'selected' : ''}`}
                  key={ep.url}
                >
                  <input
                    type="checkbox"
                    checked={!blocked && selected.has(ep.url)}
                    disabled={busy || blocked || !!downloads.error}
                    aria-label={ep.name || `第 ${index + 1} 集`}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(ep.url);
                        else next.delete(ep.url);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <span>{ep.name || `第 ${index + 1} 集`}</span>
                    {item && (
                      <small className={`cache-status-${item.status}`}>{cacheStatus(item)}</small>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
      {chosen.length > 200 && <Notice>一次最多选择 200 集，请取消部分剧集后再缓存。</Notice>}
      <div className="modal-actions">
        <button className="button quiet" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={
            busy || !chosen.length || chosen.length > 200 || downloads.loading || !!downloads.error
          }
          onClick={submit}
        >
          {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}
          {busy ? '正在加入缓存…' : `缓存所选（${chosen.length} 集）`}
        </button>
      </div>
    </Modal>
  );
}
