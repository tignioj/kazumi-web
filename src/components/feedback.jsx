import React from 'react';
import { CircleAlert, Film, LoaderCircle, RefreshCw } from 'lucide-react';

export function Notice({ children, onRetry }) {
  return (
    <div className="notice" role="alert">
      <CircleAlert size={19} />
      <span>{children}</span>
      {onRetry && (
        <button className="text-button" onClick={onRetry}>
          重试 <RefreshCw size={14} />
        </button>
      )}
    </div>
  );
}

export function Empty({ icon: Icon = Film, title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={30} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Spinner({ text = '正在加载…' }) {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={23} />
      <span>{text}</span>
    </div>
  );
}
