import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export function useRequest(path, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!path) {
      setState({ loading: false, data: null, error: '' });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: '' }));
    api(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ loading: false, data, error: '' });
      })
      .catch((error) => {
        if (!controller.signal.aborted && error.name !== 'AbortError')
          setState({ loading: false, data: null, error: error.message });
      });
    return () => controller.abort();
  }, [path, attempt, ...deps]);
  return { ...state, retry };
}
