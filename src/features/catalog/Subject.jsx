import React, { useState } from 'react';
import { imageSource } from '../../../shared/images.js';
import { CachedImage } from '../../components/CachedImage.jsx';
import { WATCH_STATUSES as STATUSES } from '../../../shared/watch-data.js';
import { ArrowLeft, ChevronDown, ExternalLink, Film, Heart, Star } from 'lucide-react';
import { titleOf } from '../../lib/format.js';
import { useRequest } from '../../hooks/use-request.js';
import { Notice, Spinner } from '../../components/feedback.jsx';
import { SourceSearch } from '../sources/SourceSearch.jsx';
import { SubjectComments } from '../comments/Comments.jsx';

export function Subject({
  id,
  library,
  updateLibrary,
  rules,
  onPlay,
  navigate,
  onBack,
  backLabel,
}) {
  const request = useRequest(`/subjects/${encodeURIComponent(id)}`);
  const [expanded, setExpanded] = useState(false);
  if (request.loading) return <Spinner text="正在展开这个故事…" />;
  if (request.error) return <Notice onRetry={request.retry}>{request.error}</Notice>;
  const subject = request.data;
  const status = library[subject.id]?.status || '';
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={17} />
        {backLabel}
      </button>
      <section className="subject-hero">
        <div className="subject-poster">
          {subject.image ? (
            <CachedImage
              referrerPolicy="no-referrer"
              src={imageSource(subject.image)}
              alt={titleOf(subject)}
            />
          ) : (
            <Film size={50} />
          )}
        </div>
        <div className="subject-content">
          <div className="eyebrow">THE STORY BEGINS HERE</div>
          <h1>{titleOf(subject)}</h1>
          {subject.name_cn && subject.name !== subject.name_cn && (
            <p className="subject-original">{subject.name}</p>
          )}
          <div className="subject-facts">
            {Number(subject.score) > 0 && (
              <span className="subject-rating">
                <Star size={19} fill="currentColor" />
                <b>{Number(subject.score).toFixed(1)}</b>
                <small>Bangumi</small>
              </span>
            )}
            {Number(subject.rank) > 0 && <span>排名 #{subject.rank}</span>}
            <span>{subject.date || '日期待定'}</span>
            <span>{subject.eps > 0 ? `全 ${subject.eps} 话` : '话数待定'}</span>
          </div>
          {subject.tags?.length > 0 && (
            <div className="tags">
              {subject.tags.slice(0, 8).map((tag, i) => (
                <a
                  key={i}
                  href={`#/categories?tag=${encodeURIComponent(typeof tag === 'string' ? tag : tag.name)}`}
                >
                  {typeof tag === 'string' ? tag : tag.name}
                </a>
              ))}
            </div>
          )}
          <div className={`subject-summary ${expanded ? 'expanded' : ''}`}>
            {subject.summary || '暂无剧情简介。留一点想象，在故事里寻找答案。'}
          </div>
          {subject.summary?.length > 180 && (
            <button className="text-button summary-toggle" onClick={() => setExpanded((p) => !p)}>
              {expanded ? '收起简介' : '展开简介'}
              <ChevronDown size={14} />
            </button>
          )}
          <div className="subject-actions">
            <label className={`status-select ${status ? 'saved' : ''}`}>
              <Heart size={16} fill={status ? 'currentColor' : 'none'} />
              <select
                value={status}
                onChange={(e) => updateLibrary(subject, e.target.value)}
                aria-label="收藏状态"
              >
                <option value="">加入我的收藏</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <a
              className="button quiet"
              href={`https://bgm.tv/subject/${subject.id}`}
              target="_blank"
              rel="noreferrer"
            >
              Bangumi
              <ExternalLink size={14} />
            </a>
          </div>
        </div>
      </section>
      <section className="source-section">
        <div className="catalog-toolbar">
          <div className="section-title">
            <span className="section-number">PLAY</span>
            <h2>寻找可观看的片源</h2>
          </div>
          <span className="muted small">通过已安装的规则搜索</span>
        </div>
        <SourceSearch
          defaultQuery={titleOf(subject)}
          subject={subject}
          rules={rules}
          onPlay={onPlay}
          navigate={navigate}
        />
      </section>
      <SubjectComments key={subject.id} subject={subject} />
    </>
  );
}
