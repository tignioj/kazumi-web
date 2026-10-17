import React, { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useRequest } from '../../hooks/use-request.js';
import { Notice, Empty } from '../../components/feedback.jsx';
import { PageHeading } from '../../components/PageHeading.jsx';
import { PosterGrid } from '../../components/PosterGrid.jsx';

export function Calendar({ library, onOpen }) {
  const request = useRequest('/calendar');
  const groups = Array.isArray(request.data) ? request.data : request.data?.items || [];
  const local = request.data?.source === 'archive';
  const today =
    (local && groups.find((group) => group.date === request.data.today)?.weekday.id) ||
    new Date().getDay() ||
    7;
  const [day, setDay] = useState(today);
  useEffect(() => setDay(today), [today]);
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const selected = groups.find((g) => Number(g.weekday?.id) === day);
  const items = selected?.items || [];
  return (
    <>
      <PageHeading
        eyebrow="A LITTLE SOMETHING TO LOOK FORWARD TO"
        title="每天，都有期待"
        description={
          local
            ? '按本地资料记录的章节日期，查看本周放送。'
            : '一周新番放送，在喜欢的日子准时相遇。'
        }
      />
      {local && (
        <p className="muted small catalog-note">
          {request.data.weekStart} — {request.data.weekEnd} · 北京时间
          <br />
          日期随官方归档更新，临时调整或尚未收录的安排可能缺失。
        </p>
      )}
      <div className="week-tabs">
        {weekdays.map((name, i) => (
          <button
            key={name}
            className={day === i + 1 ? 'selected' : ''}
            onClick={() => setDay(i + 1)}
          >
            <span>
              {i + 1 === today ? 'TODAY' : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][i]}
            </span>
            <strong>周{name}</strong>
            {i + 1 === today && <i />}
          </button>
        ))}
      </div>
      <div className="catalog-toolbar calendar-toolbar">
        <div className="section-title">
          <span className="section-number">ON AIR</span>
          <h2>星期{weekdays[day - 1]}放送</h2>
        </div>
        <span className="muted small">
          {selected?.date ? `${selected.date} · ` : ''}
          {items.length} 部动画{!local && ' · 日期以资料源为准'}
        </span>
      </div>
      {request.error ? (
        <Notice onRetry={request.retry}>{request.error}</Notice>
      ) : !request.loading && !items.length ? (
        <Empty
          icon={CalendarDays}
          title={local ? '资料中暂未收录这一天的放送' : '今天暂时没有放送安排'}
        >
          {local ? '可在偏好设置中检查资料更新。' : '留一点时间，重温收藏里的好故事。'}
        </Empty>
      ) : (
        <PosterGrid items={items} loading={request.loading} library={library} onOpen={onOpen} />
      )}
    </>
  );
}
