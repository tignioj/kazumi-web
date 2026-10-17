import React, { useEffect, useState } from 'react';
import { imageSource } from '../../../shared/images.js';
import { CachedImage } from '../../components/CachedImage.jsx';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Play,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { timeLabel } from '../../lib/format.js';
import { useRequest } from '../../hooks/use-request.js';
import { Notice, Empty } from '../../components/feedback.jsx';
import { PageHeading } from '../../components/PageHeading.jsx';
import { PosterGrid } from '../../components/PosterGrid.jsx';

export function Discover({ query, library, history, onOpen, onResume, navigate }) {
  const [sort, setSort] = useState('trending');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [sort, query]);
  const request = useRequest(
    query
      ? `/search?q=${encodeURIComponent(query)}&page=${page}`
      : `/catalog?sort=${sort}&page=${page}`,
  );
  const items = request.data?.items || [];
  return (
    <>
      <PageHeading
        eyebrow={query ? 'SEARCH RESULTS' : 'EXPLORE THE ANIME WORLD'}
        title={query ? `关于「${query}」` : '动画，自在一点'}
        description={
          query ? '从一个名字，遇见一个新世界。' : '发现心动的故事，把喜欢的世界留在身边。'
        }
      >
        <div className="heading-stamp">
          <span>日々、アニメ。</span>
          <Sparkles size={20} strokeWidth={1.3} />
        </div>
      </PageHeading>
      {!query && history.length > 0 && (
        <section className="continue-section">
          <div className="section-label">
            <Clock3 size={15} />
            <span>接着上次的故事</span>
            <button className="text-button" onClick={() => navigate('/history')}>
              全部记录 <ArrowRight size={14} />
            </button>
          </div>
          <div className="continue-grid">
            {history.slice(0, 3).map((item) => (
              <button className="continue-card" key={item.key} onClick={() => onResume(item)}>
                <div className="continue-image">
                  {item.image && (
                    <CachedImage
                      referrerPolicy="no-referrer"
                      src={imageSource(item.image)}
                      alt=""
                    />
                  )}
                  <Play size={19} fill="currentColor" />
                </div>
                <div>
                  <h3>{item.title}</h3>
                  <p>
                    {item.episodeName} <span>· {timeLabel(item.position)}</span>
                  </p>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${Math.min(100, item.duration ? (item.position / item.duration) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                </div>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </section>
      )}
      <section>
        <div className="catalog-toolbar">
          <div className="section-title">
            <span className="section-number">01</span>
            <h2>{query ? '搜索结果' : '发现好动画'}</h2>
          </div>
          {query ? (
            <button className="text-button" onClick={() => navigate('/discover')}>
              清除搜索 <X size={14} />
            </button>
          ) : (
            <div className="segmented">
              <button
                onClick={() => setSort('trending')}
                className={sort === 'trending' ? 'selected' : ''}
              >
                最近热门
              </button>
              <button onClick={() => setSort('rank')} className={sort === 'rank' ? 'selected' : ''}>
                高分佳作
              </button>
              <button onClick={() => navigate('/categories')}>番剧分类</button>
            </div>
          )}
        </div>
        {!query && sort === 'trending' && request.data?.basis === 'recent-favorites' && (
          <p className="muted small catalog-note">
            近一年开播的动画，按归档中的累计收藏人数排序。榜单随资料更新。
          </p>
        )}
        {request.error ? (
          <Notice onRetry={request.retry}>{request.error}</Notice>
        ) : !request.loading && !items.length ? (
          <Empty icon={Search} title="还没有找到相关动画">
            试试日文原名或更短的关键词，也可以前往片源搜索。
          </Empty>
        ) : (
          <PosterGrid items={items} loading={request.loading} library={library} onOpen={onOpen} />
        )}
        {!request.loading && items.length > 0 && (
          <div className="pagination">
            <button
              className="button quiet"
              disabled={page === 1}
              onClick={() => {
                setPage((p) => p - 1);
                window.scrollTo({ top: 0 });
              }}
            >
              <ChevronLeft size={17} />
              上一页
            </button>
            <span>第 {page} 页</span>
            <button
              className="button quiet"
              disabled={request.data?.total ? page * 24 >= request.data.total : items.length < 24}
              onClick={() => {
                setPage((p) => p + 1);
                window.scrollTo({ top: 0 });
              }}
            >
              下一页
              <ChevronRight size={17} />
            </button>
          </div>
        )}
      </section>
    </>
  );
}
