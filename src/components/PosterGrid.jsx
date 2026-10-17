import React from 'react';
import { imageSource } from '../../shared/images.js';
import { CachedImage } from './CachedImage.jsx';
import { ArrowRight, Film, Star } from 'lucide-react';
import { titleOf } from '../lib/format.js';

function Poster({ subject, onOpen, library }) {
  const status = library?.[subject.id]?.status;
  return (
    <button
      className="poster-card"
      onClick={() => onOpen(subject.id)}
      aria-label={`查看 ${titleOf(subject)}`}
    >
      <div className="poster-image">
        {subject.image ? (
          <CachedImage
            referrerPolicy="no-referrer"
            src={imageSource(subject.image)}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden';
            }}
          />
        ) : (
          <Film size={36} />
        )}
        <div className="poster-shade" />
        <span className="poster-open">
          <ArrowRight size={22} />
        </span>
        {Number(subject.score) > 0 && (
          <span className="score">
            <Star size={11} fill="currentColor" />
            {Number(subject.score).toFixed(1)}
          </span>
        )}
        {status && <span className="poster-status">{status}</span>}
      </div>
      <h3>{titleOf(subject)}</h3>
      <div className="poster-meta">
        <span>{subject.date?.slice(0, 4) || '待定'}</span>
        <span>{Number(subject.eps) > 0 ? `${subject.eps} 话` : '动画'}</span>
      </div>
    </button>
  );
}

export function PosterGrid({ items = [], loading, onOpen, library }) {
  return (
    <div className="poster-grid">
      {loading
        ? Array.from({ length: 12 }, (_, i) => (
            <div className="skeleton-card" key={i}>
              <div />
              <span />
              <small />
            </div>
          ))
        : items.map((s) => <Poster key={s.id} subject={s} onOpen={onOpen} library={library} />)}
    </div>
  );
}
