import React, { useState } from 'react';
import {
  CATEGORY_FIRST_YEAR,
  CATEGORY_FORMATS,
  CATEGORY_MAX_TAGS,
  CATEGORY_SEASONS,
  CATEGORY_SORTS,
  CATEGORY_TAGS,
} from '../../../shared/categories.js';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useRequest } from '../../hooks/use-request.js';
import { Notice, Empty } from '../../components/feedback.jsx';
import { PageHeading } from '../../components/PageHeading.jsx';
import { PosterGrid } from '../../components/PosterGrid.jsx';

export function Categories({ route, library, onOpen, navigate }) {
  const params = new URLSearchParams(route.split('?')[1] || '');
  const tags = params.getAll('tag');
  const format = params.get('format') || '';
  const year = params.get('year') || '';
  const season = params.get('season') || '';
  const sort = params.get('sort') || 'heat';
  const page = Number(params.get('page') || 1);
  const [customTag, setCustomTag] = useState('');
  const request = useRequest(`/categories?${params.toString()}`);
  const items = request.data?.items || [];
  const total = request.data?.total || 0;
  const currentYear = new Date().getFullYear();
  const filtered = tags.length > 0 || !!format || !!year || !!season;
  const update = (changes, nextPage = 1) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item) next.append(key, item);
      }
    }
    if (nextPage > 1) next.set('page', String(nextPage));
    const search = next.toString();
    navigate(`/categories${search ? `?${search}` : ''}`);
  };
  const toggleTag = (tag) =>
    update({ tag: tags.includes(tag) ? tags.filter((value) => value !== tag) : [...tags, tag] });
  const reset = () => {
    setCustomTag('');
    navigate('/categories');
  };
  return (
    <>
      <PageHeading
        eyebrow="FIND YOUR KIND OF STORY"
        title="番剧分类"
        description="按喜欢的题材，找到下一部想看的动画。"
      />
      <section className="category-filters" aria-label="番剧筛选">
        <div className="category-filter-heading">
          <span>
            <SlidersHorizontal size={15} /> 筛选番剧
          </span>
          <button
            className="text-button"
            onClick={reset}
            disabled={!filtered && sort === 'heat' && page === 1}
          >
            重置筛选 <RefreshCw size={13} />
          </button>
        </div>
        <fieldset className="category-filter-row">
          <legend>题材</legend>
          <div className="category-options">
            <button
              className={!tags.length ? 'selected' : ''}
              aria-pressed={!tags.length}
              onClick={() => update({ tag: [] })}
            >
              全部
            </button>
            {[...new Set([...CATEGORY_TAGS, ...tags])].map((tag) => (
              <button
                key={tag}
                className={tags.includes(tag) ? 'selected' : ''}
                aria-pressed={tags.includes(tag)}
                disabled={!tags.includes(tag) && tags.length >= CATEGORY_MAX_TAGS}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="category-custom-tag">
          <p>题材可多选，同时匹配所选标签。</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const tag = customTag.trim();
              if (tag && tags.length < CATEGORY_MAX_TAGS && !tags.includes(tag)) toggleTag(tag);
              setCustomTag('');
            }}
          >
            <input
              aria-label="自定义题材标签"
              placeholder="自定义标签"
              value={customTag}
              maxLength={40}
              onChange={(event) => setCustomTag(event.target.value)}
            />
            <button
              className="icon-button"
              aria-label="添加题材标签"
              disabled={!customTag.trim() || tags.length >= CATEGORY_MAX_TAGS}
            >
              <Plus size={15} />
            </button>
          </form>
        </div>
        <fieldset className="category-filter-row">
          <legend>类型</legend>
          <div className="category-options">
            {['', ...CATEGORY_FORMATS].map((value) => (
              <button
                key={value}
                className={format === value ? 'selected' : ''}
                aria-pressed={format === value}
                onClick={() => update({ format: value })}
              >
                {value || '全部'}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="category-filter-row category-date-row">
          <label htmlFor="category-year">年份</label>
          <select
            id="category-year"
            value={year}
            onChange={(event) =>
              update({ year: event.target.value, season: event.target.value ? season : '' })
            }
          >
            <option value="">全部年份</option>
            {Array.from(
              { length: currentYear + 2 - CATEGORY_FIRST_YEAR },
              (_, index) => currentYear + 1 - index,
            ).map((value) => (
              <option key={value} value={value}>
                {value} 年
              </option>
            ))}
          </select>
        </div>
        <fieldset className="category-filter-row">
          <legend>季度</legend>
          <div className="category-options">
            <button
              className={!season ? 'selected' : ''}
              aria-pressed={!season}
              onClick={() => update({ season: '' })}
            >
              全年
            </button>
            {CATEGORY_SEASONS.map(({ value, label }) => (
              <button
                key={value}
                className={season === value ? 'selected' : ''}
                aria-pressed={season === value}
                onClick={() => update({ season: value, year: year || String(currentYear) })}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        <p className="category-filter-note">
          类型按 Bangumi 标签筛选；未选年份时，选择季度将查看当年动画。
        </p>
      </section>
      <section aria-label="分类结果" aria-busy={request.loading}>
        <div className="catalog-toolbar category-results-toolbar">
          <div className="section-title">
            <span className="section-number">EXPLORE</span>
            <h2>{filtered ? '筛选结果' : '全部番剧'}</h2>
            {!request.loading && !request.error && (
              <span className="muted small">共 {total.toLocaleString()} 部</span>
            )}
          </div>
          <select
            className="category-sort"
            aria-label="番剧排序"
            value={sort}
            onChange={(event) => update({ sort: event.target.value })}
          >
            {CATEGORY_SORTS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {request.error ? (
          <Notice onRetry={request.retry}>{request.error}</Notice>
        ) : !request.loading && !items.length ? (
          <Empty
            icon={Search}
            title="没有符合条件的番剧"
            action={
              <button className="button quiet" onClick={reset}>
                重置筛选
              </button>
            }
          >
            试试减少题材标签，或选择其他年份和类型。
          </Empty>
        ) : (
          <PosterGrid items={items} loading={request.loading} library={library} onOpen={onOpen} />
        )}
        {!request.loading && !request.error && items.length > 0 && (
          <div className="pagination">
            <button
              className="button quiet"
              disabled={page <= 1}
              onClick={() => update({}, page - 1)}
            >
              <ChevronLeft size={17} />
              上一页
            </button>
            <span>
              第 {page} 页{total > 0 ? ` / ${Math.min(1000, Math.ceil(total / 24))} 页` : ''}
            </span>
            <button
              className="button quiet"
              disabled={page >= 1000 || (total ? page * 24 >= total : items.length < 24)}
              onClick={() => update({}, page + 1)}
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
