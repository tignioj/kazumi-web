import React, { useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useSearchHistory } from '../hooks/use-search-history.js';
import { SearchHistory } from './SearchHistory.jsx';

export function GlobalSearch({ navigate }) {
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const history = useSearchHistory('catalog');
  const search = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    history.add(trimmed);
    setKeyword(trimmed);
    setOpen(false);
    navigate(`/discover?q=${encodeURIComponent(trimmed)}`);
  };
  return (
    <form
      className="global-search"
      onSubmit={(event) => {
        event.preventDefault();
        search(keyword);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onMouseDown={(event) => {
        // Keep the input focused until history clicks finish, including in Safari.
        if (event.target.closest('.search-history')) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          inputRef.current?.focus();
          setOpen(false);
        }
      }}
    >
      <Search size={17} />
      <input
        ref={inputRef}
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
        }}
        placeholder="搜索动画，发现下一个故事"
        aria-label="搜索动画"
        autoComplete="off"
      />
      <kbd>↵</kbd>
      {open && <SearchHistory history={history} onSelect={search} />}
    </form>
  );
}
