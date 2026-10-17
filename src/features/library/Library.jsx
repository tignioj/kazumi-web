import React, { useState } from 'react';
import { WATCH_STATUSES as STATUSES } from '../../../shared/watch-data.js';
import { ArrowRight, Heart, Search } from 'lucide-react';
import { titleOf } from '../../lib/format.js';
import { Empty } from '../../components/feedback.jsx';
import { PageHeading } from '../../components/PageHeading.jsx';
import { PosterGrid } from '../catalog/PosterGrid.jsx';

export function Library({ library, onOpen, navigate }) {
  const [filter, setFilter] = useState('全部');
  const [text, setText] = useState('');
  const all = Object.values(library).sort((a, b) => b.addedAt - a.addedAt);
  const items = all.filter(
    (i) =>
      (filter === '全部' || i.status === filter) &&
      titleOf(i.subject).toLowerCase().includes(text.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        eyebrow="YOUR PERSONAL COLLECTION"
        title="把喜欢，留在身边"
        description={`这里收藏着你的 ${all.length} 个故事。收藏与进度保存在服务器，所有设备共享。`}
      />
      <div className="collection-toolbar">
        <div className="filter-tabs">
          {['全部', ...STATUSES].map((s) => (
            <button key={s} onClick={() => setFilter(s)} className={filter === s ? 'selected' : ''}>
              {s}
              <span>{s === '全部' ? all.length : all.filter((i) => i.status === s).length}</span>
            </button>
          ))}
        </div>
        <label className="inline-search">
          <Search size={16} />
          <input
            aria-label="搜索收藏"
            placeholder="搜索我的收藏"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </div>
      {items.length ? (
        <PosterGrid items={items.map((i) => i.subject)} library={library} onOpen={onOpen} />
      ) : (
        <Empty
          icon={Heart}
          title={all.length ? '这里还没有收藏' : '为喜欢的故事，留一个位置'}
          action={
            <button className="button primary" onClick={() => navigate('/discover')}>
              去发现动画
              <ArrowRight size={16} />
            </button>
          }
        >
          在动画详情页标记观看状态，它就会出现在这里。
        </Empty>
      )}
    </>
  );
}
