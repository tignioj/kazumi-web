import React, { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { awaitVerification, ensureVerificationSession, VerificationHost } from './verification.jsx';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Compass,
  Download,
  ExternalLink,
  Film,
  Heart,
  History,
  LoaderCircle,
  Menu,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

const STATUSES = ['想看', '在看', '看过', '搁置', '抛弃'];
const NAV = [
  { id: 'discover', label: '发现', sub: 'DISCOVER', icon: Compass },
  { id: 'calendar', label: '放送日历', sub: 'ON AIR', icon: CalendarDays },
  { id: 'library', label: '我的收藏', sub: 'COLLECTION', icon: BookOpen },
  { id: 'history', label: '观看记录', sub: 'HISTORY', icon: History },
];
const titleOf = (s) => s?.name_cn || s?.name || '未命名动画';
const timeLabel = (n) =>
  `${Math.floor((n || 0) / 60)}:${String(Math.floor((n || 0) % 60)).padStart(2, '0')}`;
const prettyDate = (d) =>
  d ? new Date(d).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '时间未知';
const watchKey = (rule, url) => `${rule}:${url}`;

async function api(path, options = {}) {
  if (['/rules/search', '/rules/chapters', '/resolve'].includes(path)) {
    await ensureVerificationSession();
    options.signal?.throwIfAborted();
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('服务返回了无法识别的内容，请稍后重试。');
  }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  if (response.status === 202 && data.type === 'verification')
    return awaitVerification(data, options.signal);
  return data;
}

function useStored(key, initial) {
  const [value, setState] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? initial;
    } catch {
      return initial;
    }
  });
  const valueRef = useRef(value);
  const setValue = useCallback(
    (next) => {
      const resolved = typeof next === 'function' ? next(valueRef.current) : next;
      valueRef.current = resolved;
      try {
        localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        /* Browsers with disabled or full storage can still browse. */
      }
      setState(resolved);
    },
    [key],
  );
  return [value, setValue];
}

function normalizeBackup(data) {
  if (
    data?.format !== 'kazumi-web-backup' ||
    !data.library ||
    Array.isArray(data.library) ||
    typeof data.library !== 'object' ||
    !Array.isArray(data.history)
  )
    throw new Error('这不是有效的 Kazumi Web 备份文件。');
  const string = (value) => (typeof value === 'string' ? value : '');
  const image = (value) => (/^https?:\/\//i.test(string(value)) ? value : '');
  const library = {};
  for (const item of Object.values(data.library)) {
    const s = item?.subject;
    if (
      !s ||
      !Number.isSafeInteger(Number(s.id)) ||
      Number(s.id) <= 0 ||
      !STATUSES.includes(item.status) ||
      typeof s.name !== 'string'
    )
      throw new Error('备份中的收藏格式不完整。');
    const subject = {
      id: Number(s.id),
      name: s.name,
      name_cn: string(s.name_cn),
      image: image(s.image),
      date: string(s.date),
      summary: string(s.summary),
      score: Number(s.score) || 0,
      rank: Number(s.rank) || 0,
      eps: Number(s.eps) || 0,
      tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string') : [],
    };
    library[subject.id] = {
      subject,
      status: item.status,
      addedAt: Number(item.addedAt) || Date.now(),
    };
  }
  const history = data.history.slice(0, 200).map((item) => {
    if (
      !item ||
      typeof item.ruleName !== 'string' ||
      !item.ruleName ||
      typeof item.sourceUrl !== 'string' ||
      !item.sourceUrl ||
      typeof item.title !== 'string' ||
      typeof item.episodeUrl !== 'string'
    )
      throw new Error('备份中的观看记录格式不完整。');
    const nonnegative = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
    return {
      key: watchKey(item.ruleName, item.sourceUrl),
      subjectId: Number(item.subjectId) || undefined,
      title: item.title,
      image: image(item.image),
      ruleName: item.ruleName,
      sourceUrl: item.sourceUrl,
      episodeUrl: item.episodeUrl,
      episodeName: string(item.episodeName),
      roadIndex: Math.floor(nonnegative(item.roadIndex)),
      episodeIndex: Math.floor(nonnegative(item.episodeIndex)),
      position: nonnegative(item.position),
      duration: nonnegative(item.duration),
      updatedAt: Number(item.updatedAt) || Date.now(),
    };
  });
  return {
    library,
    history,
    settings: {
      theme: ['system', 'light', 'dark'].includes(data.settings?.theme)
        ? data.settings.theme
        : 'system',
      autoNext: !!data.settings?.autoNext,
    },
  };
}

function useRequest(path, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) {
      setState({ loading: false, data: null, error: '' });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: '' }));
    api(path, { signal: controller.signal })
      .then((data) => setState({ loading: false, data, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError')
          setState({ loading: false, data: null, error: error.message });
      });
    return () => controller.abort();
  }, [path, attempt, ...deps]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

function downloadJSON(data, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Notice({ children, onRetry }) {
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
function Empty({ icon: Icon = Film, title, children, action }) {
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
function Spinner({ text = '正在加载…' }) {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={23} />
      <span>{text}</span>
    </div>
  );
}
function PageHeading({ eyebrow, title, description, children }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>
          {title}
          <span className="title-dot">.</span>
        </h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
function Modal({ title, children, onClose, wide }) {
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const focused = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab') {
        const focusable = [
          ...dialogRef.current.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      focused?.focus?.();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={dialogRef}
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button ref={closeRef} className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

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
          <img
            referrerPolicy="no-referrer"
            src={subject.image}
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
function PosterGrid({ items = [], loading, onOpen, library }) {
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

export default function App() {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/discover');
  const [library, setLibrary] = useStored('kazumi.library.v1', {});
  const [history, setHistory] = useStored('kazumi.history.v1', []);
  const [settings, setSettings] = useStored('kazumi.settings.v1', {
    theme: 'system',
    autoNext: false,
  });
  const [rules, setRules] = useState([]);
  const [rulesError, setRulesError] = useState('');
  const [toast, setToast] = useState('');
  const [player, setPlayer] = useState(null);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const notify = useCallback((text) => setToast(text), []);
  const navigate = useCallback((path) => {
    location.hash = path;
    setSidebarOpen(false);
    setPlayer(null);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  const reloadRules = useCallback(async () => {
    try {
      const data = await api('/rules');
      setRules(data.rules || []);
      setRulesError('');
    } catch (e) {
      setRulesError(e.message);
    }
  }, []);
  useEffect(() => {
    const fn = () => {
      setRoute(location.hash.slice(1) || '/discover');
      setPlayer(null);
    };
    addEventListener('hashchange', fn);
    reloadRules();
    return () => removeEventListener('hashchange', fn);
  }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () =>
      (document.documentElement.dataset.theme =
        settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [settings.theme]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const section = route.split('/')[1]?.split('?')[0] || 'discover';
  const query = new URLSearchParams(route.split('?')[1] || '').get('q') || '';
  const openSubject = (id) => navigate(`/subject/${id}`);
  const updateLibrary = (subject, status) => {
    setLibrary((prev) => {
      const next = { ...prev };
      if (status)
        next[subject.id] = { subject, status, addedAt: prev[subject.id]?.addedAt || Date.now() };
      else delete next[subject.id];
      return next;
    });
    notify(status ? `已标记为「${status}」` : '已从收藏中移除');
  };
  const startPlayer = (context) => {
    setPlayer(context);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const saveProgress = useCallback(
    (record) =>
      setHistory((prev) => [record, ...prev.filter((i) => i.key !== record.key)].slice(0, 200)),
    [setHistory],
  );
  const resume = (record) => startPlayer({ ...record, resume: record.position });
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <div
          className="sidebar-scrim"
          onClick={() => {
            setSidebarOpen(false);
          }}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <a
          className="brand"
          href="#/discover"
          onClick={() => {
            setSidebarOpen(false);
            setPlayer(null);
          }}
        >
          <span className="brand-mark">
            k<span>。</span>
          </span>
          <span>
            kazumi<small>WEB EDITION</small>
          </span>
        </a>
        <div className="sidebar-label">你的动画空间</div>
        <nav>
          {NAV.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#/${id}`}
              onClick={() => {
                setSidebarOpen(false);
                setPlayer(null);
              }}
              className={`nav-item ${section === id ? 'active' : ''}`}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{label}</span>
              {id === 'library' && Object.keys(library).length > 0 && (
                <small>{Object.keys(library).length}</small>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-label">工作台</div>
        <nav>
          <a
            className={`nav-item ${section === 'sources' ? 'active' : ''}`}
            href="#/sources"
            onClick={() => {
              setSidebarOpen(false);
              setPlayer(null);
            }}
          >
            <Search size={19} strokeWidth={1.7} />
            <span>片源搜索</span>
          </a>
          <a
            className={`nav-item ${section === 'rules' ? 'active' : ''}`}
            href="#/rules"
            onClick={() => {
              setSidebarOpen(false);
              setPlayer(null);
            }}
          >
            <SlidersHorizontal size={19} strokeWidth={1.7} />
            <span>规则管理</span>
          </a>
          <a
            className={`nav-item ${section === 'settings' ? 'active' : ''}`}
            href="#/settings"
            onClick={() => {
              setSidebarOpen(false);
              setPlayer(null);
            }}
          >
            <Settings2 size={19} strokeWidth={1.7} />
            <span>偏好设置</span>
          </a>
        </nav>
        <div className="sidebar-bottom">
          <span className="little-line" />
          <p>
            好故事，
            <br />
            值得慢慢看。
          </p>
          <div className="sidebar-foot">
            <span>KAZUMI WEB</span>
            <span className="status-light" title="个人动画空间" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开导航"
          >
            <Menu size={22} />
          </button>
          <div className="topbar-location">
            {NAV.find((i) => i.id === section)?.sub || 'YOUR ANIME SPACE'}
          </div>
          <form
            className="global-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) navigate(`/discover?q=${encodeURIComponent(search.trim())}`);
            }}
          >
            <Search size={17} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索动画，发现下一个故事"
              aria-label="搜索动画"
            />
            <kbd>↵</kbd>
          </form>
          <button
            className="theme-toggle icon-button"
            onClick={() =>
              setSettings((p) => ({
                ...p,
                theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark',
              }))
            }
            aria-label="切换明暗主题"
          >
            {settings.theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
          </button>
        </header>
        <main>
          {player ? (
            <Player
              context={player}
              settings={settings}
              onClose={() => setPlayer(null)}
              onProgress={saveProgress}
              notify={notify}
            />
          ) : (
            <>
              {section === 'discover' && (
                <Discover
                  query={query}
                  library={library}
                  history={history}
                  onOpen={openSubject}
                  onResume={resume}
                  navigate={navigate}
                />
              )}
              {section === 'calendar' && <Calendar library={library} onOpen={openSubject} />}
              {section === 'library' && (
                <Library library={library} onOpen={openSubject} navigate={navigate} />
              )}
              {section === 'history' && (
                <HistoryPage
                  history={history}
                  onResume={resume}
                  onRemove={(key) => setHistory((p) => p.filter((x) => x.key !== key))}
                  onClear={() => {
                    setHistory([]);
                    notify('观看记录已清空');
                  }}
                />
              )}
              {section === 'subject' && (
                <Subject
                  key={route.split('/')[2]}
                  id={route.split('/')[2]?.split('?')[0]}
                  library={library}
                  updateLibrary={updateLibrary}
                  rules={rules}
                  onPlay={startPlayer}
                  navigate={navigate}
                />
              )}
              {section === 'sources' && (
                <Sources rules={rules} onPlay={startPlayer} navigate={navigate} />
              )}
              {section === 'rules' && (
                <Rules rules={rules} error={rulesError} reload={reloadRules} notify={notify} />
              )}
              {section === 'settings' && (
                <Settings
                  settings={settings}
                  setSettings={setSettings}
                  library={library}
                  history={history}
                  setLibrary={setLibrary}
                  setHistory={setHistory}
                  notify={notify}
                />
              )}
              {![
                'discover',
                'calendar',
                'library',
                'history',
                'subject',
                'sources',
                'rules',
                'settings',
              ].includes(section) && (
                <Empty
                  title="这一页还没有故事"
                  action={
                    <button className="button primary" onClick={() => navigate('/discover')}>
                      返回发现
                    </button>
                  }
                />
              )}
            </>
          )}
        </main>
        <footer className="page-footer">
          <span>
            kazumi<span className="accent">.</span> 每一话，都是新世界
          </span>
          <span>番剧资料由 Bangumi 提供</span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      <VerificationHost />
    </div>
  );
}

function Discover({ query, library, history, onOpen, onResume, navigate }) {
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
                  {item.image && <img referrerPolicy="no-referrer" src={item.image} alt="" />}
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
            </div>
          )}
        </div>
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

function Calendar({ library, onOpen }) {
  const request = useRequest('/calendar');
  const today = new Date().getDay() || 7;
  const [day, setDay] = useState(today);
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const groups = Array.isArray(request.data) ? request.data : request.data?.items || [];
  const items = groups.find((g) => Number(g.weekday?.id) === day)?.items || [];
  return (
    <>
      <PageHeading
        eyebrow="A LITTLE SOMETHING TO LOOK FORWARD TO"
        title="每天，都有期待"
        description="一周新番放送，在喜欢的日子准时相遇。"
      />
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
      <div className="catalog-toolbar">
        <div className="section-title">
          <span className="section-number">ON AIR</span>
          <h2>星期{weekdays[day - 1]}放送</h2>
        </div>
        <span className="muted small">{items.length} 部动画 · 日期以资料源为准</span>
      </div>
      {request.error ? (
        <Notice onRetry={request.retry}>{request.error}</Notice>
      ) : !request.loading && !items.length ? (
        <Empty icon={CalendarDays} title="今天暂时没有放送安排">
          留一点时间，重温收藏里的好故事。
        </Empty>
      ) : (
        <PosterGrid items={items} loading={request.loading} library={library} onOpen={onOpen} />
      )}
    </>
  );
}

function Library({ library, onOpen, navigate }) {
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
        description={`这里收藏着你的 ${all.length} 个故事。进度与收藏保存在当前浏览器。`}
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

function HistoryPage({ history, onResume, onRemove, onClear }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <PageHeading
        eyebrow="PICK UP WHERE YOU LEFT OFF"
        title="故事，继续"
        description="记下每次相遇，也记得上次停下的地方。"
      >
        {history.length > 0 && (
          <button className="button quiet" onClick={() => setConfirm(true)}>
            <Trash2 size={15} />
            清空记录
          </button>
        )}
      </PageHeading>
      {history.length ? (
        <div className="history-list">
          {history.map((item) => (
            <article className="history-row" key={item.key}>
              <button className="history-cover" onClick={() => onResume(item)}>
                {item.image ? (
                  <img referrerPolicy="no-referrer" src={item.image} alt="" />
                ) : (
                  <Film size={24} />
                )}
                <span>
                  <Play size={20} fill="currentColor" />
                </span>
              </button>
              <div className="history-description">
                <h3>{item.title}</h3>
                <p>
                  {item.episodeName} <span>· {item.ruleName}</span>
                </p>
                <div className="progress-track">
                  <span
                    style={{
                      width: `${item.duration ? Math.min(100, (item.position / item.duration) * 100) : 0}%`,
                    }}
                  />
                </div>
                <small>
                  观看至 {timeLabel(item.position)}
                  {item.duration ? ` / ${timeLabel(item.duration)}` : ''}
                  <span>{prettyDate(item.updatedAt)}</span>
                </small>
              </div>
              <button className="button quiet resume-button" onClick={() => onResume(item)}>
                <Play size={15} />
                继续观看
              </button>
              <button
                className="icon-button"
                aria-label={`删除 ${item.title} 的观看记录`}
                onClick={() => onRemove(item.key)}
              >
                <X size={17} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <Empty icon={History} title="还没有开始的故事">
          播放动画后，观看记录和进度会自动保存在这里。
        </Empty>
      )}
      {confirm && (
        <Modal title="清空观看记录" onClose={() => setConfirm(false)}>
          <p>将移除当前浏览器中的全部观看记录，收藏会保留。</p>
          <div className="modal-actions">
            <button className="button quiet" onClick={() => setConfirm(false)}>
              取消
            </button>
            <button
              className="button danger"
              onClick={() => {
                onClear();
                setConfirm(false);
              }}
            >
              清空记录
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Subject({ id, library, updateLibrary, rules, onPlay, navigate }) {
  const request = useRequest(`/subjects/${encodeURIComponent(id)}`);
  const [expanded, setExpanded] = useState(false);
  if (request.loading) return <Spinner text="正在展开这个故事…" />;
  if (request.error) return <Notice onRetry={request.retry}>{request.error}</Notice>;
  const subject = request.data;
  const status = library[subject.id]?.status || '';
  return (
    <>
      <button className="back-link" onClick={() => navigate('/discover')}>
        <ArrowLeft size={17} />
        返回发现
      </button>
      <section className="subject-hero">
        <div className="subject-poster">
          {subject.image ? (
            <img referrerPolicy="no-referrer" src={subject.image} alt={titleOf(subject)} />
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
                <span key={i}>{typeof tag === 'string' ? tag : tag.name}</span>
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
    </>
  );
}

function Sources({ rules, onPlay, navigate }) {
  return (
    <>
      <PageHeading
        eyebrow="FIND YOUR NEXT EPISODE"
        title="故事的另一扇门"
        description="直接搜索已安装规则中的片源，找到后即可选择线路与剧集。"
      />
      <SourceSearch rules={rules} onPlay={onPlay} navigate={navigate} />
    </>
  );
}

function SourceSearch({ defaultQuery = '', subject, rules, onPlay, navigate }) {
  const [keyword, setKeyword] = useState(defaultQuery);
  const [selected, setSelected] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState('');
  const mounted = useRef(true);
  const requestsRef = useRef(new Set());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of requestsRef.current) controller.abort();
      requestsRef.current.clear();
    };
  }, []);
  const submit = async (e) => {
    e?.preventDefault();
    if (!keyword.trim() || loading) return;
    setLoading(true);
    setError('');
    setResults(null);
    const controller = new AbortController();
    requestsRef.current.add(controller);
    try {
      const data = await api('/rules/search', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          keyword: keyword.trim(),
          ...(selected ? { ruleNames: [selected] } : {}),
        }),
      });
      if (mounted.current) setResults(data.results || []);
    } catch (e) {
      if (mounted.current && e.name !== 'AbortError') setError(e.message);
    } finally {
      requestsRef.current.delete(controller);
      if (mounted.current) setLoading(false);
    }
  };
  const open = async (ruleName, item) => {
    const key = `${ruleName}:${item.url}`;
    setOpening(key);
    setError('');
    const controller = new AbortController();
    requestsRef.current.add(controller);
    try {
      const data = await api('/rules/chapters', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ ruleName, url: item.url }),
      });
      if (!data.roads?.some((r) => r.episodes?.length))
        throw new Error('此片源没有解析到剧集，可以尝试其他搜索结果。');
      if (mounted.current)
        onPlay({
          subjectId: subject?.id,
          title: titleOf(subject || item),
          image: subject?.image || '',
          ruleName,
          sourceUrl: item.url,
          roads: data.roads,
          roadIndex: Math.max(
            0,
            data.roads.findIndex((r) => r.episodes?.length),
          ),
          episodeIndex: 0,
        });
    } catch (e) {
      if (mounted.current && e.name !== 'AbortError') setError(e.message);
    } finally {
      requestsRef.current.delete(controller);
      if (mounted.current) setOpening('');
    }
  };
  if (!rules.length)
    return (
      <Empty
        icon={SlidersHorizontal}
        title="先为 Kazumi 添加一条规则"
        action={
          <button className="button primary" onClick={() => navigate('/rules')}>
            <Plus size={16} />
            管理规则
          </button>
        }
      >
        规则负责搜索片源和解析剧集。可从在线目录安装，也可导入 Kazumi 规则。
      </Empty>
    );
  return (
    <div className="source-search">
      <form className="source-form" onSubmit={submit}>
        <label>
          <Search size={19} />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="输入动画名称搜索片源"
            aria-label="片源关键词"
          />
        </label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="选择搜索规则"
        >
          <option value="">全部规则（{rules.length}）</option>
          {rules.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        <button className="button primary" disabled={loading || !keyword.trim()} type="submit">
          {loading ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}搜索片源
        </button>
      </form>
      {error && <Notice>{error}</Notice>}
      {loading && <Spinner text="正在各个片源中寻找，请稍候…" />}
      {results && (
        <div className="source-results">
          {results.map((group) => (
            <section key={group.ruleName} className="source-group">
              <header>
                <span className="source-initial">{group.ruleName?.slice(0, 1)}</span>
                <h3>{group.ruleName}</h3>
                <small>{group.items?.length || 0} 个结果</small>
              </header>
              {group.error ? (
                <Notice>{group.error}</Notice>
              ) : group.items?.length ? (
                <div className="source-items">
                  {group.items.map((item, i) => (
                    <button
                      key={`${item.url}:${i}`}
                      disabled={!!opening}
                      onClick={() => open(group.ruleName, item)}
                    >
                      <span>{item.name}</span>
                      {opening === `${group.ruleName}:${item.url}` ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <Play size={15} />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted small">这个片源暂时没有匹配结果。</p>
              )}
            </section>
          ))}
          {results.length === 0 && (
            <Empty icon={Search} title="没有找到可用结果">
              试试其他关键词，或在规则管理中添加片源。
            </Empty>
          )}
        </div>
      )}
      {!results && !loading && !error && (
        <div className="search-hint">
          <span className="decorative-asterisk">✳</span>
          <p>
            从一个名字，开始下一段旅程。
            <small>片源由各规则对应的网站提供，可用性取决于来源站点。</small>
          </p>
        </div>
      )}
    </div>
  );
}

function Rules({ rules, error, reload, notify }) {
  const [tab, setTab] = useState('installed');
  const [modal, setModal] = useState(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteRule, setDeleteRule] = useState(null);
  const fileRef = useRef();
  const catalog = useRequest(tab === 'catalog' ? '/rules/catalog' : null);
  const [installing, setInstalling] = useState('');
  const [catalogFilter, setCatalogFilter] = useState('');
  const openImport = () => {
    setModal({ type: 'import' });
    setContent('');
    setFormError('');
  };
  const save = async () => {
    if (!content.trim()) return;
    setBusy(true);
    setFormError('');
    try {
      if (modal.type === 'edit')
        await api(`/rules/${encodeURIComponent(modal.rule.name)}`, {
          method: 'PUT',
          body: JSON.stringify(JSON.parse(content)),
        });
      else await api('/rules/import', { method: 'POST', body: JSON.stringify({ content }) });
      await reload();
      setModal(null);
      notify(modal.type === 'edit' ? '规则已更新' : '规则已导入');
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const install = async (name) => {
    setInstalling(name);
    try {
      await api('/rules/install', { method: 'POST', body: JSON.stringify({ name }) });
      await reload();
      notify(`已安装「${name}」`);
    } catch (e) {
      notify(e.message);
    } finally {
      setInstalling('');
    }
  };
  const readFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setContent(await file.text());
      setFormError('');
    } catch {
      setFormError('文件读取失败，请重新选择。');
    }
    e.target.value = '';
  };
  const remoteRules = catalog.data?.rules || [];
  return (
    <>
      <PageHeading
        eyebrow="MAKE KAZUMI YOUR OWN"
        title="规则，连接故事"
        description="管理用于搜索与播放的站点规则。已安装规则由部署服务共享。"
      >
        <button className="button primary" onClick={openImport}>
          <Plus size={17} />
          导入规则
        </button>
      </PageHeading>
      <div className="collection-toolbar">
        <div className="filter-tabs">
          <button
            className={tab === 'installed' ? 'selected' : ''}
            onClick={() => setTab('installed')}
          >
            已安装<span>{rules.length}</span>
          </button>
          <button className={tab === 'catalog' ? 'selected' : ''} onClick={() => setTab('catalog')}>
            在线目录
            <ArrowDownToLine size={14} />
          </button>
        </div>
        {rules.length > 0 && tab === 'installed' && (
          <button className="text-button" onClick={() => downloadJSON(rules, 'kazumi-rules.json')}>
            <Download size={15} />
            导出全部规则
          </button>
        )}
      </div>
      {error && <Notice onRetry={reload}>{error}</Notice>}
      {tab === 'installed' &&
        (rules.length ? (
          <div className="rule-grid">
            {rules.map((rule) => (
              <article className="rule-card" key={rule.name}>
                <div className="rule-card-top">
                  <span className="rule-symbol">{rule.name?.slice(0, 1)}</span>
                  <span className="rule-badge">已安装</span>
                </div>
                <h3>{rule.name}</h3>
                <p>{rule.baseURL || rule.baseUrl || '自定义站点规则'}</p>
                <div className="rule-details">
                  <span>版本 {rule.version || '—'}</span>
                  <span>{rule.author || '社区规则'}</span>
                </div>
                <div className="rule-card-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      setModal({ type: 'edit', rule });
                      setContent(JSON.stringify(rule, null, 2));
                      setFormError('');
                    }}
                  >
                    <SlidersHorizontal size={14} />
                    编辑规则
                  </button>
                  <div>
                    <button
                      className="icon-button"
                      aria-label={`导出 ${rule.name}`}
                      onClick={() => downloadJSON(rule, `${rule.name}.json`)}
                    >
                      <Download size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`删除 ${rule.name}`}
                      onClick={() => setDeleteRule(rule)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={SlidersHorizontal}
            title="让故事，有迹可循"
            action={
              <div className="button-group">
                <button className="button primary" onClick={() => setTab('catalog')}>
                  浏览在线规则
                  <ArrowRight size={15} />
                </button>
                <button className="button quiet" onClick={openImport}>
                  手动导入
                </button>
              </div>
            }
          >
            安装一个规则，即可搜索相应站点的片源。
            <br />
            支持 Kazumi JSON 和 kazumi:// 分享链接。
          </Empty>
        ))}
      {tab === 'catalog' && (
        <>
          {catalog.error ? (
            <Notice onRetry={catalog.retry}>{catalog.error}</Notice>
          ) : catalog.loading ? (
            <Spinner text="正在获取在线规则目录…" />
          ) : (
            <>
              <label className="inline-search catalog-search">
                <Search size={16} />
                <input
                  placeholder="筛选规则名称"
                  aria-label="筛选在线规则"
                  value={catalogFilter}
                  onChange={(e) => setCatalogFilter(e.target.value)}
                />
              </label>
              <div className="catalog-rules">
                {remoteRules
                  .filter((r) => r.name.toLowerCase().includes(catalogFilter.toLowerCase()))
                  .map((rule) => {
                    const installed = rules.some((r) => r.name === rule.name);
                    return (
                      <article key={rule.name}>
                        <span className="rule-symbol">{rule.name.slice(0, 1)}</span>
                        <div>
                          <h3>{rule.name}</h3>
                          <p>
                            {rule.author || rule.baseURL || 'Kazumi 社区规则'}
                            {rule.version ? ` · v${rule.version}` : ''}
                          </p>
                        </div>
                        <button
                          className={`button ${installed ? 'quiet' : 'primary'}`}
                          disabled={!!installing}
                          onClick={() => install(rule.name)}
                        >
                          {installing === rule.name ? (
                            <LoaderCircle size={15} className="spin" />
                          ) : installed ? (
                            <RefreshCw size={14} />
                          ) : (
                            <Plus size={15} />
                          )}
                          {installed ? '重新安装' : '安装'}
                        </button>
                      </article>
                    );
                  })}
              </div>
              {!remoteRules.length && (
                <Empty title="目录暂时没有规则">你仍然可以通过 JSON 文件手动导入规则。</Empty>
              )}
            </>
          )}
        </>
      )}
      <div className="info-footnote">
        <CircleAlert size={16} />
        <p>
          规则描述了如何读取来源站点，并不包含视频内容。请仅使用你有权访问的片源；来源失效时可编辑或更新规则。
        </p>
      </div>
      {modal && (
        <Modal
          wide
          title={modal.type === 'edit' ? `编辑规则 · ${modal.rule.name}` : '导入 Kazumi 规则'}
          onClose={() => !busy && setModal(null)}
        >
          <p className="muted">
            {modal.type === 'edit'
              ? '编辑完整的规则 JSON，保存后立即生效。'
              : '粘贴单条规则、规则数组或 kazumi:// 分享链接，也可以选择本地 JSON 文件。'}
          </p>
          {modal.type === 'import' && (
            <>
              <input
                type="file"
                accept=".json,.txt,application/json"
                ref={fileRef}
                hidden
                onChange={readFile}
              />
              <button
                className="button quiet upload-button"
                onClick={() => fileRef.current.click()}
              >
                <Upload size={16} />
                选择本地文件
              </button>
            </>
          )}
          <textarea
            className="code-input"
            spellCheck="false"
            aria-label="规则 JSON 或分享链接"
            placeholder={'{\n  "name": "我的规则",\n  "baseURL": "https://…"\n}'}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          {formError && <Notice>{formError}</Notice>}
          <div className="modal-actions">
            <button className="button quiet" disabled={busy} onClick={() => setModal(null)}>
              取消
            </button>
            <button className="button primary" disabled={busy || !content.trim()} onClick={save}>
              {busy && <LoaderCircle size={15} className="spin" />}
              {modal.type === 'edit' ? '保存规则' : '导入规则'}
            </button>
          </div>
        </Modal>
      )}
      {deleteRule && (
        <Modal title="删除规则" onClose={() => !busy && setDeleteRule(null)}>
          <p>
            删除「{deleteRule.name}
            」后，使用本部署的所有浏览器将无法再通过它搜索片源。之后可以重新导入。
          </p>
          {formError && <Notice>{formError}</Notice>}
          <div className="modal-actions">
            <button className="button quiet" disabled={busy} onClick={() => setDeleteRule(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setFormError('');
                try {
                  await api(`/rules/${encodeURIComponent(deleteRule.name)}`, { method: 'DELETE' });
                  await reload();
                  setDeleteRule(null);
                  notify('规则已删除');
                } catch (e) {
                  setFormError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              删除规则
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Settings({ settings, setSettings, library, history, setLibrary, setHistory, notify }) {
  const fileRef = useRef();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const health = useRequest('/health');
  const importData = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      setPending(normalizeBackup(JSON.parse(await file.text())));
    } catch (e) {
      setError(e.message);
    }
    e.target.value = '';
  };
  return (
    <>
      <PageHeading
        eyebrow="A SPACE THAT FEELS LIKE YOU"
        title="按你的方式"
        description="让每一次打开，都更合心意。"
      />
      <div className="settings-layout">
        <section className="settings-card">
          <div className="settings-card-heading">
            <Sun size={19} />
            <div>
              <h2>外观与播放</h2>
              <p>这些偏好只保存在当前浏览器</p>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <h3>显示主题</h3>
              <p>为白天与深夜，选择舒适的背景。</p>
            </div>
            <select
              value={settings.theme}
              onChange={(e) => setSettings((p) => ({ ...p, theme: e.target.value }))}
              aria-label="显示主题"
            >
              <option value="system">跟随系统</option>
              <option value="light">明亮</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <h3>自动播放下一话</h3>
              <p>直接播放的视频结束后，继续下一话。</p>
            </div>
            <button
              className={`switch ${settings.autoNext ? 'on' : ''}`}
              role="switch"
              aria-checked={settings.autoNext}
              aria-label="自动播放下一话"
              onClick={() => setSettings((p) => ({ ...p, autoNext: !p.autoNext }))}
            >
              <span />
            </button>
          </div>
        </section>
        <section className="settings-card">
          <div className="settings-card-heading">
            <Download size={19} />
            <div>
              <h2>你的数据，随身带走</h2>
              <p>收藏、观看进度与偏好设置</p>
            </div>
          </div>
          <div className="data-counts">
            <div>
              <strong>{Object.keys(library).length}</strong>
              <span>部收藏</span>
            </div>
            <div>
              <strong>{history.length}</strong>
              <span>条观看记录</span>
            </div>
          </div>
          <p className="muted small">
            导出备份可在其他浏览器恢复。站点规则单独存储在服务器，请在规则管理页导出。
          </p>
          <div className="button-group">
            <button
              className="button primary"
              onClick={() => {
                downloadJSON(
                  {
                    format: 'kazumi-web-backup',
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    library,
                    history,
                    settings,
                  },
                  `kazumi-backup-${new Date().toISOString().slice(0, 10)}.json`,
                );
                notify('备份已导出');
              }}
            >
              <Download size={15} />
              导出备份
            </button>
            <button className="button quiet" onClick={() => fileRef.current.click()}>
              <Upload size={15} />
              恢复备份
            </button>
            <input
              hidden
              type="file"
              accept=".json,application/json"
              ref={fileRef}
              onChange={importData}
            />
          </div>
          {error && <Notice>{error}</Notice>}
        </section>
        <section className="settings-card about-card">
          <div className="about-brand">
            kazumi<span>.</span>
            <small>WEB EDITION</small>
          </div>
          <p>在浏览器里，拥有自己的动画空间。</p>
          <div className="about-status">
            <span className={`status-light ${health.error ? 'offline' : ''}`} />
            {health.loading ? '正在连接服务…' : health.error ? '服务暂时不可用' : '服务运行正常'}
            <span>Docker Compose ready</span>
          </div>
          <div className="muted small">元数据由 Bangumi 提供 · 收藏保存在当前浏览器</div>
        </section>
      </div>
      {pending && (
        <Modal title="恢复本地备份" onClose={() => setPending(null)}>
          <p>
            将恢复 {Object.keys(pending.library).length} 部收藏与 {pending.history.length}{' '}
            条观看记录，并覆盖当前浏览器的数据。
          </p>
          <div className="modal-actions">
            <button className="button quiet" onClick={() => setPending(null)}>
              取消
            </button>
            <button
              className="button primary"
              onClick={() => {
                setLibrary(pending.library);
                setHistory(pending.history.slice(0, 200));
                if (pending.settings)
                  setSettings({
                    theme: ['system', 'light', 'dark'].includes(pending.settings.theme)
                      ? pending.settings.theme
                      : 'system',
                    autoNext: !!pending.settings.autoNext,
                  });
                setPending(null);
                notify('备份已恢复');
              }}
            >
              恢复备份
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Player({ context, settings, onClose, onProgress, notify }) {
  const [roads, setRoads] = useState(context.roads || []);
  const [roadIndex, setRoadIndex] = useState(context.roadIndex || 0);
  const [episodeIndex, setEpisodeIndex] = useState(context.episodeIndex || 0);
  const [resolved, setResolved] = useState(null);
  const [loading, setLoading] = useState(true);
  const [slowResolve, setSlowResolve] = useState(false);
  const [error, setError] = useState('');
  const [playError, setPlayError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [speed, setSpeed] = useState(1);
  const videoRef = useRef();
  const positionRef = useRef(context.resume || 0);
  const lastSaveRef = useRef(0);
  const resumedRef = useRef(false);
  const autoPlayRef = useRef(false);
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  const episodes = roads[roadIndex]?.episodes || [];
  const episode = episodes[episodeIndex];
  const hasNext = episodeIndex < episodes.length - 1;
  useEffect(() => {
    setSlowResolve(false);
    if (!loading) return;
    const timer = setTimeout(() => setSlowResolve(true), 5000);
    return () => clearTimeout(timer);
  }, [loading, episode?.url, attempt]);
  useEffect(() => {
    if (roads.length) return;
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api('/rules/chapters', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ ruleName: context.ruleName, url: context.sourceUrl }),
    })
      .then((data) => {
        if (!alive) return;
        if (!data.roads?.some((r) => r.episodes?.length))
          throw new Error('此片源没有可播放的剧集。');
        setRoads(data.roads);
        const oldRoad = data.roads[context.roadIndex || 0];
        const index = oldRoad?.episodes?.findIndex((e) => e.url === context.episodeUrl);
        if (index >= 0) setEpisodeIndex(index);
        else {
          setRoadIndex(
            Math.max(
              0,
              data.roads.findIndex((r) => r.episodes?.length),
            ),
          );
          setEpisodeIndex(0);
          positionRef.current = 0;
        }
      })
      .catch((e) => {
        if (alive && e.name !== 'AbortError') {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [context, attempt]);
  useEffect(() => {
    if (!episode) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPlayError('');
    setResolved(null);
    resumedRef.current = false;
    api('/resolve', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ ruleName: context.ruleName, url: episode.url }),
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setResolved(data);
        setLoading(false);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [episode?.url, context.ruleName, attempt]);
  const record = useCallback(
    (position, duration = 0) => {
      if (!episode) return;
      progressRef.current({
        key: watchKey(context.ruleName, context.sourceUrl),
        subjectId: context.subjectId,
        title: context.title,
        image: context.image,
        ruleName: context.ruleName,
        sourceUrl: context.sourceUrl,
        episodeUrl: episode.url,
        episodeName: episode.name,
        roadIndex,
        episodeIndex,
        position: Number.isFinite(position) ? position : 0,
        duration: Number.isFinite(duration) ? duration : 0,
        updatedAt: Date.now(),
      });
    },
    [episode?.url, episode?.name, roadIndex, episodeIndex, context],
  );
  useEffect(() => {
    if (!resolved || resolved.type === 'iframe') {
      if (resolved?.type === 'iframe') record(positionRef.current);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    let hls;
    const resume = () => {
      video.playbackRate = speed;
      if (!resumedRef.current && positionRef.current > 0 && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(positionRef.current, Math.max(0, video.duration - 1));
        resumedRef.current = true;
      }
      if (autoPlayRef.current) {
        autoPlayRef.current = false;
        video.play().catch(() => notify('已切换剧集，点击播放继续观看'));
      }
    };
    const save = (remember = true) => {
      if (remember !== false && video.readyState > 0) positionRef.current = video.currentTime;
      record(video.readyState > 0 ? video.currentTime : positionRef.current, video.duration);
    };
    const update = () => {
      if (Date.now() - lastSaveRef.current > 5000) {
        save();
        lastSaveRef.current = Date.now();
      }
    };
    const failure = () => setPlayError('浏览器无法播放此视频。可重试、切换线路，或打开来源页面。');
    video.addEventListener('loadedmetadata', resume);
    video.addEventListener('timeupdate', update);
    video.addEventListener('pause', save);
    video.addEventListener('error', failure);
    window.addEventListener('pagehide', save);
    if (
      resolved.type === 'hls' &&
      Hls.isSupported() &&
      !video.canPlayType('application/vnd.apple.mpegurl')
    ) {
      hls = new Hls();
      hls.loadSource(resolved.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) failure();
      });
    } else {
      video.src = resolved.url;
    }
    record(positionRef.current);
    return () => {
      save(false);
      video.removeEventListener('loadedmetadata', resume);
      video.removeEventListener('timeupdate', update);
      video.removeEventListener('pause', save);
      video.removeEventListener('error', failure);
      window.removeEventListener('pagehide', save);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [resolved]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);
  useEffect(() => {
    const fn = (e) => {
      if (
        ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(document.activeElement?.tagName) ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey
      )
        return;
      const video = videoRef.current;
      if (!video) return;
      if (e.code === 'Space') {
        e.preventDefault();
        video.paused ? video.play().catch(() => {}) : video.pause();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        video.currentTime = Math.max(
          0,
          Math.min(
            video.duration || Infinity,
            video.currentTime + (e.key === 'ArrowRight' ? 10 : -10),
          ),
        );
      } else if (e.key.toLowerCase() === 'f') {
        if (!document.fullscreenElement) video.requestFullscreen?.().catch(() => {});
        else document.exitFullscreen?.();
      }
    };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, []);
  const select = (index, road = roadIndex) => {
    if (index === episodeIndex && road === roadIndex) return;
    positionRef.current = 0;
    resumedRef.current = false;
    autoPlayRef.current = true;
    setEpisodeIndex(index);
    setRoadIndex(road);
  };
  return (
    <div className="player-page">
      <button className="back-link" onClick={onClose}>
        <ArrowLeft size={17} />
        返回浏览
      </button>
      <div className="player-heading">
        <div>
          <div className="eyebrow">NOW PLAYING · {context.ruleName}</div>
          <h1>{context.title}</h1>
          <p>{episode?.name || '正在获取剧集'}</p>
        </div>
        {episode && (
          <a
            className="button quiet"
            href={resolved?.originalUrl || episode.url}
            target="_blank"
            rel="noreferrer"
          >
            来源页面
            <ExternalLink size={14} />
          </a>
        )}
      </div>
      <div className="video-stage">
        {loading ? (
          <Spinner text={slowResolve ? '片源响应较慢，正在继续解析并验证视频…' : '正在解析片源…'} />
        ) : error ? (
          <div className="player-error">
            <CircleAlert size={32} />
            <h3>暂时无法播放</h3>
            <p>{error}</p>
            <button className="button primary" onClick={() => setAttempt((p) => p + 1)}>
              <RefreshCw size={15} />
              重新解析
            </button>
          </div>
        ) : resolved?.type === 'iframe' ? (
          <iframe
            key={resolved.url}
            title={`${context.title} ${episode?.name || ''} 站点播放器`}
            src={resolved.url}
            referrerPolicy="no-referrer"
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
          />
        ) : resolved ? (
          <video
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            onEnded={() => {
              if (settings.autoNext && hasNext) {
                notify('正在播放下一话');
                select(episodeIndex + 1);
              }
            }}
          />
        ) : null}
      </div>
      {playError && <Notice onRetry={() => setAttempt((p) => p + 1)}>{playError}</Notice>}
      {resolved?.type === 'iframe' && (
        <div className="iframe-note">
          <CircleAlert size={16} />
          <span>
            当前使用来源站点播放器，无法同步视频进度。若页面空白，请打开来源页面或切换线路。
          </span>
          <a href={resolved.url} target="_blank" rel="noreferrer">
            新窗口打开
            <ExternalLink size={13} />
          </a>
        </div>
      )}
      <div className="player-control-bar">
        <span>
          <Clock3 size={14} />
          {resolved?.type === 'iframe' ? '已记录当前剧集' : '观看进度自动保存'}
          <small>空格 播放/暂停 · ← → 快进/后退 · F 全屏</small>
        </span>
        <label className="playback-speed">
          <span>倍速</span>
          <select
            aria-label="播放速度"
            value={speed}
            disabled={resolved?.type === 'iframe'}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
              <option key={rate} value={rate}>
                {rate}×
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={!hasNext || loading}
          onClick={() => select(episodeIndex + 1)}
        >
          下一话
          <ChevronRight size={16} />
        </button>
      </div>
      <section className="episode-section">
        <div className="catalog-toolbar">
          <div className="section-title">
            <span className="section-number">EPISODES</span>
            <h2>选集</h2>
          </div>
          <span className="muted small">共 {episodes.length} 话</span>
        </div>
        <div className="road-tabs">
          {roads.map((road, index) => (
            <button
              key={index}
              className={roadIndex === index ? 'selected' : ''}
              disabled={!road.episodes?.length}
              onClick={() =>
                select(Math.min(episodeIndex, (road.episodes?.length || 1) - 1), index)
              }
            >
              {road.name || `线路 ${index + 1}`}
              <span>{road.episodes?.length || 0}</span>
            </button>
          ))}
        </div>
        <div className="episode-grid">
          {episodes.map((ep, index) => (
            <button
              key={`${ep.url}:${index}`}
              onClick={() => select(index)}
              className={episodeIndex === index ? 'selected' : ''}
            >
              {episodeIndex === index && <Play size={12} fill="currentColor" />}
              {ep.name || `第 ${index + 1} 话`}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
