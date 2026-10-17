import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeWatchData } from '../shared/watch-data.js';

function browserLegacy() {
  let rawLibrary;
  let rawHistory;
  try {
    rawLibrary = localStorage.getItem('kazumi.library.v1');
    rawHistory = localStorage.getItem('kazumi.history.v1');
  } catch {
    return null;
  }
  try {
    const data = normalizeWatchData({
      library: JSON.parse(rawLibrary) ?? {},
      history: JSON.parse(rawHistory) ?? [],
    });
    return Object.keys(data.library).length || data.history.length
      ? { data, rawLibrary, rawHistory }
      : null;
  } catch {
    return { error: '浏览器旧数据无法读取，尚未迁移，原数据已保留。' };
  }
}

export function useWatchData(request) {
  const [data, setData] = useState({ library: {}, history: [] });
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [legacy, setLegacy] = useState(browserLegacy);
  const version = useRef(0);
  const applied = useRef(0);
  const pending = useRef(0);
  const reading = useRef(null);
  const writes = useRef(new Map());
  const failures = useRef(new Map());

  const refresh = useCallback(async () => {
    if (reading.current || pending.current) return;
    const controller = new AbortController();
    reading.current = controller;
    const started = version.current;
    try {
      const next = await request('/watch-data', {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!controller.signal.aborted && started === version.current && !pending.current) {
        setData(next);
        setReadError('');
      }
    } catch (error) {
      if (!controller.signal.aborted && started === version.current)
        setReadError(`无法读取服务器收藏与观看记录：${error.message}`);
    } finally {
      if (reading.current === controller) reading.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    refresh();
    const visible = () => {
      if (!document.hidden) refresh();
    };
    const interval = setInterval(visible, 15000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
      reading.current?.abort();
      reading.current = null;
    };
  }, [refresh]);

  const mutate = useCallback(
    async (path, options) => {
      const current = ++version.current;
      writes.current.set(path, current);
      pending.current++;
      try {
        const next = await request(`/watch-data${path}`, options);
        // An older response must not replace a newer server snapshot.
        if (current >= applied.current) {
          applied.current = current;
          setData(next);
        }
        if (writes.current.get(path) === current) {
          failures.current.delete(path);
          setWriteError(failures.current.values().next().value || '');
        }
        setLoading(false);
        return next;
      } catch (error) {
        if (writes.current.get(path) === current) {
          failures.current.set(path, `有更改未能保存到服务器，请重新操作：${error.message}`);
          setWriteError(failures.current.values().next().value);
        }
        throw error;
      } finally {
        pending.current--;
      }
    },
    [request],
  );
  const saveLibrary = useCallback(
    (subject, status) =>
      mutate(`/library/${subject.id}`, {
        method: status ? 'PUT' : 'DELETE',
        ...(status ? { body: JSON.stringify({ subject, status }) } : {}),
        keepalive: true,
      }),
    [mutate],
  );
  const saveProgress = useCallback(
    (record) =>
      mutate('/history', {
        method: 'PUT',
        body: JSON.stringify(record),
        // Finish the final progress write when the page closes or reloads.
        keepalive: true,
      }).catch(() => {}),
    [mutate],
  );
  const removeHistory = useCallback(
    (key) =>
      mutate(`/history${key === undefined ? '' : `?key=${encodeURIComponent(key)}`}`, {
        method: 'DELETE',
      }),
    [mutate],
  );
  const restore = useCallback(
    (next) => mutate('', { method: 'PUT', body: JSON.stringify(next) }),
    [mutate],
  );
  const migrate = async () => {
    if (!legacy?.data) return;
    await mutate('/migrate', { method: 'POST', body: JSON.stringify(legacy.data) });
    // Remove local records only after the server confirms a successful save.
    try {
      if (localStorage.getItem('kazumi.library.v1') === legacy.rawLibrary)
        localStorage.removeItem('kazumi.library.v1');
      if (localStorage.getItem('kazumi.history.v1') === legacy.rawHistory)
        localStorage.removeItem('kazumi.history.v1');
    } catch {
      // The server copy is already durable if browser storage is unavailable.
    }
    setLegacy(browserLegacy());
  };
  return {
    ...data,
    loading,
    error: writeError || readError,
    writeError,
    refresh,
    legacy,
    migrate,
    saveLibrary,
    saveProgress,
    removeHistory,
    restore,
  };
}
