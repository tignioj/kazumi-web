import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

export function useNetworkSettings() {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true, error: '' }));
    api('/network-settings', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ loading: false, data, error: '' });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState((previous) => ({ ...previous, loading: false, error: error.message }));
      });
    return () => controller.abort();
  }, [attempt]);

  const save = useCallback(async (settings) => {
    if (savingRef.current) throw new Error('正在保存网络设置，请稍候');
    savingRef.current = true;
    setSaving(true);
    try {
      const data = await api('/network-settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setState({ loading: false, data, error: '' });
      return data;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  return { ...state, saving, retry, save };
}
