import { useStored } from './use-stored.js';

const HISTORY_LIMIT = 20;

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim())),
  ]
    .filter(Boolean)
    .slice(0, HISTORY_LIMIT);
}

export function useSearchHistory(scope) {
  const key = `kazumi.search-history.${scope}.v1`;
  const [stored, setStored] = useStored(key, []);
  const latest = (fallback) => {
    try {
      // Another tab may have cleared history since this view was mounted.
      return normalizeHistory(JSON.parse(localStorage.getItem(key)));
    } catch {
      return normalizeHistory(fallback);
    }
  };
  return {
    entries: normalizeHistory(stored),
    add(keyword) {
      const trimmed = keyword.trim();
      if (trimmed) setStored((current) => normalizeHistory([trimmed, ...latest(current)]));
    },
    remove(keyword) {
      setStored((current) => latest(current).filter((entry) => entry !== keyword));
    },
    clear() {
      setStored([]);
    },
  };
}
