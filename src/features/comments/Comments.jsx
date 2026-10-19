import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Star } from 'lucide-react';
import { useRequest } from '../../hooks/use-request.js';
import { Notice, Spinner } from '../../components/feedback.jsx';
import { episodeLabel, matchCommentEpisode } from '../../lib/episode-comments.js';

const dateLabel = (value) =>
  new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function CommentCard({ comment }) {
  const [expanded, setExpanded] = useState(false);
  const username = comment.user.username;
  const name = comment.user.nickname || username || '已注销用户';
  return (
    <article className="comment-card">
      <div className="comment-avatar" aria-hidden="true">
        {Array.from(name)[0]}
      </div>
      <div className="comment-body">
        <div className="comment-meta">
          {username ? (
            <a
              href={`https://bgm.tv/user/${encodeURIComponent(username)}`}
              target="_blank"
              rel="noreferrer"
            >
              {name}
            </a>
          ) : (
            <span>{name}</span>
          )}
          {comment.rate > 0 && (
            <span className="comment-rating">
              <Star size={12} />
              {comment.rate} 分
            </span>
          )}
          {comment.timestamp > 0 && (
            <time dateTime={new Date(comment.timestamp * 1000).toISOString()}>
              {dateLabel(comment.timestamp * 1000)}
            </time>
          )}
        </div>
        <p
          className={`comment-text ${expanded || comment.content.length <= 280 ? 'expanded' : ''}`}
        >
          {comment.content || '暂无内容'}
        </p>
        {comment.content.length > 280 && (
          <button
            className="text-button comment-expand"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : '展开全文'}
          </button>
        )}
        {comment.replies.length > 0 && (
          <details className="comment-replies">
            <summary>查看 {comment.replies.length} 条回复</summary>
            {comment.replies.map((reply) => (
              <CommentCard key={reply.id} comment={reply} />
            ))}
          </details>
        )}
      </div>
    </article>
  );
}

function CommentPage({ kind, id, page, refresh, onPage }) {
  const request = useRequest(`/${kind}/${id}/comments?page=${page}${refresh ? '&refresh=1' : ''}`);
  if (request.loading) return <Spinner text="正在获取 Bangumi 评论…" />;
  if (request.error) return <Notice onRetry={request.retry}>{request.error}</Notice>;
  const { items, total, pageSize, cache } = request.data;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <>
      <div className="comment-info">
        <span>
          共 {total} 条{kind === 'subjects' ? '短评' : '讨论'}
        </span>
        <p className={cache.stale ? 'comment-stale' : ''} role="status">
          {cache.stale
            ? '暂时无法连接 Bangumi，正在显示本地缓存'
            : cache.persisted === false
              ? '本次评论未能保存到本地'
              : cache.cached
                ? '本地缓存'
                : '已更新'}
          <span> · {dateLabel(cache.updatedAt)}</span>
        </p>
      </div>
      {items.length ? (
        <div className="comment-list">
          {items.map((comment) => (
            <CommentCard key={comment.id} comment={comment} />
          ))}
        </div>
      ) : (
        <p className="comment-empty">
          {page > 1 ? '这一页暂时没有评论，请返回上一页。' : '还没有评论，去 Bangumi 看看吧。'}
        </p>
      )}
      {(page > 1 || pages > 1) && (
        <nav className="comment-pagination" aria-label="评论分页">
          <button className="button quiet" disabled={page === 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft size={15} />
            上一页
          </button>
          <span>
            第 {page} / {pages} 页
          </span>
          <button
            className="button quiet"
            disabled={page >= pages || page >= 1000}
            onClick={() => onPage(page + 1)}
          >
            下一页
            <ChevronRight size={15} />
          </button>
        </nav>
      )}
    </>
  );
}

function CommentThread({ kind, id }) {
  const [request, setRequest] = useState({ page: 1, revision: 0, refresh: false });
  return (
    <div className="comment-thread">
      <div className="comment-actions">
        <a
          className="text-button"
          href={`https://bgm.tv/${kind === 'subjects' ? 'subject' : 'ep'}/${id}`}
          target="_blank"
          rel="noreferrer"
        >
          在 Bangumi 查看
          <ExternalLink size={13} />
        </a>
        <button
          className="text-button"
          onClick={() =>
            setRequest((value) => ({ ...value, revision: value.revision + 1, refresh: true }))
          }
        >
          <RefreshCw size={13} />
          刷新评论
        </button>
      </div>
      <CommentPage
        key={`${request.page}:${request.revision}`}
        kind={kind}
        id={id}
        {...request}
        onPage={(page) => setRequest({ page, revision: 0, refresh: false })}
      />
    </div>
  );
}

export function Comments({ kind, id }) {
  return <CommentThread key={`${kind}:${id}`} kind={kind} id={id} />;
}

export function EpisodeDiscussion({ episodes, defaultId = '', playing = false }) {
  const [selected, setSelected] = useState(defaultId);
  return (
    <div className="episode-discussion">
      {episodes.length ? (
        <label className="comment-episode-select">
          {playing ? '查看剧集评论' : '选择剧集'}
          <select
            aria-label="评论剧集"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">请选择 Bangumi 剧集</option>
            {episodes.map((episode) => (
              <option key={episode.id} value={episode.id}>
                {episodeLabel(episode)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="comment-empty">暂无 Bangumi 剧集资料。</p>
      )}
      {selected ? (
        <Comments kind="episodes" id={selected} />
      ) : (
        episodes.length > 0 && (
          <p className="comment-empty">
            {playing
              ? '未能确定当前集数，请手动选择对应剧集。'
              : '选择剧集后查看讨论，评论可能包含剧透。'}
          </p>
        )
      )}
    </div>
  );
}

export function SubjectComments({ subject }) {
  const [tab, setTab] = useState('subjects');
  return (
    <section className="comments-section" aria-label="番剧讨论">
      <div className="catalog-toolbar">
        <div className="section-title">
          <span className="section-number">DISCUSSION</span>
          <h2>番剧讨论</h2>
        </div>
        <span className="muted small">来自 Bangumi</span>
      </div>
      <div
        className="comment-tabs"
        role="tablist"
        aria-label="评论类型"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'subjects'
              : event.key === 'End'
                ? 'episodes'
                : tab === 'subjects'
                  ? 'episodes'
                  : 'subjects';
          setTab(next);
          event.currentTarget
            .querySelector(`#${next === 'subjects' ? 'subject' : 'episode'}-comments-tab`)
            .focus();
        }}
      >
        <button
          id="subject-comments-tab"
          role="tab"
          tabIndex={tab === 'subjects' ? 0 : -1}
          aria-selected={tab === 'subjects'}
          aria-controls="subject-comments-panel"
          onClick={() => setTab('subjects')}
        >
          番剧短评
        </button>
        <button
          id="episode-comments-tab"
          role="tab"
          tabIndex={tab === 'episodes' ? 0 : -1}
          aria-selected={tab === 'episodes'}
          aria-controls="episode-comments-panel"
          onClick={() => setTab('episodes')}
        >
          剧集评论
        </button>
      </div>
      <div
        id={`${tab === 'subjects' ? 'subject' : 'episode'}-comments-panel`}
        role="tabpanel"
        aria-labelledby={`${tab === 'subjects' ? 'subject' : 'episode'}-comments-tab`}
      >
        {tab === 'subjects' ? (
          <Comments kind="subjects" id={subject.id} />
        ) : (
          <EpisodeDiscussion episodes={subject.episodes || []} />
        )}
      </div>
    </section>
  );
}

export function PlayerComments({ subjectId, episodeName }) {
  const request = useRequest(subjectId ? `/subjects/${encodeURIComponent(subjectId)}` : null);
  return (
    <section className="comments-section" aria-label="当前剧集评论">
      <details className="player-comments">
        <summary>
          <span>剧集评论</span>
          <small>来自 Bangumi · 可能包含剧透</small>
        </summary>
        {!subjectId ? (
          <p className="comment-empty">此片源尚未关联 Bangumi 条目，无法查看剧集评论。</p>
        ) : request.loading ? (
          <Spinner text="正在读取剧集资料…" />
        ) : request.error ? (
          <Notice onRetry={request.retry}>{request.error}</Notice>
        ) : (
          <EpisodeDiscussion
            episodes={request.data.episodes || []}
            defaultId={matchCommentEpisode(request.data.episodes || [], episodeName)}
            playing
          />
        )}
      </details>
    </section>
  );
}
