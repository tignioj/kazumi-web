import { useCallback, useRef, useState } from 'react';

export function useStored(key, initial) {
  const [value, setState] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? initial;
    } catch {
      return initial;
    }
  });
  const valueRef = useRef(value);
  const setValue = useCallback(
    (next) => {
      const resolved = typeof next === 'function' ? next(valueRef.current) : next;
      valueRef.current = resolved;
      try {
        localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        /* Browsers with disabled or full storage can still browse. */
      }
      setState(resolved);
    },
    [key],
  );
  return [value, setValue];
}
