import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { cacheActive, sameCacheEpisode } from './utils.js';

export function useDownloads(identity) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef(null);
  const timerRef = useRef(null);
  const stop = useCallback(() => {
    controllerRef.current?.abort();
    clearTimeout(timerRef.current);
  }, []);
  const reload = useCallback(() => {
    stop();
    setAttempt((value) => value + 1);
  }, [stop]);
  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const load = async () => {
      if (document.hidden) return;
      try {
        const next = await api('/downloads', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(next);
        setError('');
        if (
          next.items?.some(
            (item) => cacheActive(item) && (identity === 'all' || item.episodeUrl === identity),
          )
        )
          timerRef.current = setTimeout(load, 1500);
      } catch (e) {
        if (!controller.signal.aborted) setError(e.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    load();
    const refresh = () => {
      if (!document.hidden) reload();
      else stop();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      clearTimeout(timerRef.current);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [identity, attempt, reload, stop]);
  const accept = (incoming) => {
    const items = Array.isArray(incoming) ? incoming : [incoming];
    setData((previous) => ({
      ...previous,
      items: [
        ...items,
        ...(previous?.items || []).filter(
          (entry) =>
            !items.some(
              (item) =>
                entry.id === item.id || sameCacheEpisode(entry, item.ruleName, item.episodeUrl),
            ),
        ),
      ],
    }));
    reload();
  };
  const forget = (id) => {
    const ids = new Set(Array.isArray(id) ? id : [id]);
    setData((previous) => {
      if (!previous) return previous;
      const removed = previous.items.filter((item) => id === 'all' || ids.has(item.id));
      return {
        ...previous,
        items: previous.items.filter((item) => !removed.includes(item)),
        usedBytes: Math.max(
          0,
          (previous.usedBytes || 0) - removed.reduce((sum, item) => sum + (item.bytes || 0), 0),
        ),
      };
    });
    reload();
  };
  return { items: data?.items || [], data, loading, error, reload, accept, forget };
}
