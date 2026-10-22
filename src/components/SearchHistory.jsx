import React from 'react';
import { History, Trash2, X } from 'lucide-react';

export function SearchHistory({ history, onSelect, disabled = false }) {
  return (
    <section className="search-history" aria-label="搜索历史">
      <div className="search-history-heading">
        <span>
          <History size={14} />
          搜索历史
        </span>
        {history.entries.length > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={history.clear}
            aria-label="清空搜索历史"
          >
            <Trash2 size={13} />
            清空
          </button>
        )}
      </div>
      {history.entries.length ? (
        <ul className="search-history-items">
          {history.entries.map((keyword) => (
            <li key={keyword}>
              <button
                type="button"
                className="search-history-keyword"
                onClick={() => onSelect(keyword)}
                disabled={disabled}
                title={keyword}
                aria-label={`搜索：${keyword}`}
              >
                {keyword}
              </button>
              <button
                type="button"
                className="search-history-remove"
                onClick={() => history.remove(keyword)}
                aria-label={`删除搜索记录：${keyword}`}
                title="删除这条记录"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="search-history-empty">暂无搜索历史</p>
      )}
    </section>
  );
}
