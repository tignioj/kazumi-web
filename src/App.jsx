import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { startPlayback } from './playback.js';
import { PlaybackDiagnostics } from './playback-diagnostics.jsx';
import { imageSource } from '../shared/images.js';
import { CachedImage } from './cached-image.jsx';
import { useWatchData } from './watch-data.js';
import { WATCH_STATUSES as STATUSES, normalizeWatchData, watchKey } from '../shared/watch-data.js';
import { awaitVerification, ensureVerificationSession, VerificationHost } from './verification.jsx';
import {
  CATEGORY_FIRST_YEAR,
  CATEGORY_FORMATS,
  CATEGORY_MAX_TAGS,
  CATEGORY_SEASONS,
  CATEGORY_SORTS,
  CATEGORY_TAGS,
} from '../shared/categories.js';
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
  LayoutGrid,
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

const NAV = [
  { id: 'discover', label: '发现', sub: 'DISCOVER', icon: Compass },
  { id: 'categories', label: '番剧分类', sub: 'CATEGORIES', icon: LayoutGrid },
  { id: 'calendar', label: '放送日历', sub: 'ON AIR', icon: CalendarDays },
  { id: 'library', label: '我的收藏', sub: 'COLLECTION', icon: BookOpen },
  { id: 'history', label: '观看记录', sub: 'HISTORY', icon: History },
  { id: 'downloads', label: '下载缓存', sub: 'DOWNLOADS', icon: ArrowDownToLine },
];
const titleOf = (s) => s?.name_cn || s?.name || '未命名动画';
const timeLabel = (n) =>
  `${Math.floor((n || 0) / 60)}:${String(Math.floor((n || 0) % 60)).padStart(2, '0')}`;
const prettyDate = (d) =>
  d ? new Date(d).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '时间未知';

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
  let records;
  try {
    records = normalizeWatchData(data);
  } catch (error) {
    throw new Error(`备份中的${error.message.replace('数据格式', '格式')}`);
  }
  return {
    ...records,
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
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!path) {
      setState({ loading: false, data: null, error: '' });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: '' }));
    api(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ loading: false, data, error: '' });
      })
      .catch((error) => {
        if (!controller.signal.aborted && error.name !== 'AbortError')
          setState({ loading: false, data: null, error: error.message });
      });
    return () => controller.abort();
  }, [path, attempt, ...deps]);
  return { ...state, retry };
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

const cacheActive = (item) => ['queued', 'downloading'].includes(item.status);
const sameCacheEpisode = (item, ruleName, episodeUrl) =>
  item.ruleName?.trim().toLowerCase() === ruleName?.trim().toLowerCase() &&
  item.episodeUrl === episodeUrl;
const bytesLabel = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent - 1]}`;
};
const cacheStatus = (item) =>
  item.status === 'downloading' && item.type === 'pending'
    ? '正在解析'
    : { queued: '等待下载', downloading: '正在缓存', complete: '已缓存', error: '缓存失败' }[
        item.status
      ] || '未知状态';

function useDownloads(identity) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef(null);
  const timerRef = useRef(null);
  const stop = useCallback(() => {
    controllerRef.current?.abort();
    clearTimeout(timerRef.current);
  }, []);
  const reload = useCallback(() => {
    stop();
    setAttempt((value) => value + 1);
  }, [stop]);
  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const load = async () => {
      if (document.hidden) return;
      try {
        const next = await api('/downloads', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(next);
        setError('');
        if (
          next.items?.some(
            (item) => cacheActive(item) && (identity === 'all' || item.episodeUrl === identity),
          )
        )
          timerRef.current = setTimeout(load, 1500);
      } catch (e) {
        if (!controller.signal.aborted) setError(e.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    load();
    const refresh = () => {
      if (!document.hidden) reload();
      else stop();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      clearTimeout(timerRef.current);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [identity, attempt, reload, stop]);
  const accept = (incoming) => {
    const items = Array.isArray(incoming) ? incoming : [incoming];
    const ids = new Set(items.map((item) => item.id));
    setData((previous) => ({
      ...previous,
      items: [...items, ...(previous?.items || []).filter((entry) => !ids.has(entry.id))],
    }));
    reload();
  };
  const forget = (id) => {
    setData((previous) => {
      if (!previous) return previous;
      const removed = previous.items.filter((item) => id === 'all' || item.id === id);
      return {
        ...previous,
        items: previous.items.filter((item) => !removed.includes(item)),
        usedBytes: Math.max(
          0,
          (previous.usedBytes || 0) - removed.reduce((sum, item) => sum + (item.bytes || 0), 0),
        ),
      };
    });
    reload();
  };
  return { items: data?.items || [], data, loading, error, reload, accept, forget };
}

function CacheProgress({ item }) {
  const total = item.type === 'hls' ? item.totalFiles : item.totalBytes;
  const done = Number(item.type === 'hls' ? item.completedFiles : item.bytes) || 0;
  const percentage =
    item.status === 'complete' ? 100 : total > 0 ? Math.min(100, (done / total) * 100) : null;
  return (
    <div className="cache-progress">
      <div className="cache-progress-label">
        <span className={`cache-status cache-status-${item.status}`}>
          {cacheActive(item) && <LoaderCircle size={13} className="spin" />}
          {item.status === 'complete' && <Check size={13} />}
          {item.status === 'error' && <CircleAlert size={13} />}
          {cacheStatus(item)}
        </span>
        <span>
          {bytesLabel(item.bytes)}
          {item.type !== 'hls' && item.totalBytes > 0 && item.status !== 'complete'
            ? ` / ${bytesLabel(item.totalBytes)}`
            : ''}
          {item.type === 'hls' && item.totalFiles > 0 && item.status !== 'complete'
            ? ` · ${item.completedFiles || 0}/${item.totalFiles} 个文件`
            : ''}
        </span>
      </div>
      {cacheActive(item) && (
        <div
          className={`progress-track ${percentage === null ? 'cache-indeterminate' : ''}`}
          role="progressbar"
          aria-label="视频缓存进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage === null ? undefined : Math.round(percentage)}
          aria-valuetext={percentage === null ? '正在下载，大小未知' : `${Math.round(percentage)}%`}
        >
          <span style={{ width: `${percentage === null ? 35 : percentage}%` }} />
        </div>
      )}
      {item.error && <p className="cache-error">{item.error}</p>}
    </div>
  );
}

function CacheRemoval({ item, onClose, onRemoved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const all = item === 'all';
  return (
    <Modal title={all ? '清空全部视频缓存' : '删除视频缓存'} onClose={() => !busy && onClose()}>
      <p>
        {all
          ? '将停止所有下载任务，并删除服务器上的全部视频缓存。'
          : `将删除「${item.title} · ${item.episodeName || '当前剧集'}」的缓存${cacheActive(item) ? '，并停止下载' : ''}。`}
        此操作会影响使用此服务器的所有人；收藏与观看记录会保留。
      </p>
      {error && <Notice>{error}</Notice>}
      <div className="modal-actions">
        <button className="button quiet" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="button danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api(all ? '/downloads' : `/downloads/${encodeURIComponent(item.id)}`, {
                method: 'DELETE',
              });
              onRemoved();
            } catch (e) {
              setError(e.message);
              setBusy(false);
            }
          }}
        >
          {busy && <LoaderCircle size={15} className="spin" />}
          {all ? '清空全部缓存' : '确认删除'}
        </button>
      </div>
    </Modal>
  );
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
  const [navigation, setNavigation] = useState(() => ({
    route: location.hash.slice(1) || '/discover',
    origin: null,
    scrollY: null,
  }));
  const { route, origin } = navigation;
  const watchData = useWatchData(api);
  const { library, history, saveProgress } = watchData;
  const [settings, setSettings] = useStored('kazumi.settings.v1', {
    theme: 'system',
    autoNext: false,
  });
  const [rules, setRules] = useState([]);
  const [rulesError, setRulesError] = useState('');
  const { data: ruleUpdates, retry: checkRuleUpdates } = useRequest(
    rules.length ? '/rules/updates' : null,
    [rules],
  );
  const availableUpdates = new Map(
    (ruleUpdates?.updates || []).map((rule) => [rule.name.toLowerCase(), rule.version]),
  );
  const [toast, setToast] = useState('');
  const [player, setPlayer] = useState(null);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const notify = useCallback((text) => setToast(text), []);
  const navigate = useCallback((path) => {
    location.hash = path;
    setSidebarOpen(false);
    setPlayer(null);
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
    const check = () => {
      if (!document.hidden) checkRuleUpdates();
    };
    const interval = setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', check);
    };
  }, [checkRuleUpdates]);
  useEffect(() => {
    const fn = () => {
      const nextRoute = location.hash.slice(1) || '/discover';
      const scrollY = window.scrollY;
      setNavigation((previous) => {
        const wasSubject = previous.route.startsWith('/subject/');
        const isSubject = nextRoute.startsWith('/subject/');
        return {
          route: nextRoute,
          origin: isSubject
            ? wasSubject
              ? previous.origin
              : { route: previous.route, scrollY }
            : null,
          scrollY: wasSubject && previous.origin?.route === nextRoute ? previous.origin.scrollY : 0,
        };
      });
      setPlayer(null);
      setSidebarOpen(false);
    };
    const scrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    addEventListener('hashchange', fn);
    reloadRules();
    return () => {
      removeEventListener('hashchange', fn);
      window.history.scrollRestoration = scrollRestoration;
    };
  }, []);
  useLayoutEffect(() => {
    if (navigation.scrollY !== null)
      window.scrollTo({ top: navigation.scrollY, behavior: 'instant' });
  }, [navigation]);
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
  const listRoute = section === 'subject' ? origin?.route : route;
  const listSection = listRoute?.split('/')[1]?.split('?')[0] || '';
  const query = new URLSearchParams(listRoute?.split('?')[1] || '').get('q') || '';
  const openSubject = (id) => navigate(`/subject/${id}`);
  const updateLibrary = async (subject, status) => {
    try {
      await watchData.saveLibrary(subject, status);
      notify(status ? `已标记为「${status}」` : '已从收藏中移除');
    } catch (error) {
      notify(`收藏未保存：${error.message}`);
    }
  };
  const startPlayer = (context) => {
    setPlayer(context);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const resume = (record) => startPlayer({ ...record, resume: record.position });
  const playCached = (item) => {
    const previous = history.find((record) =>
      sameCacheEpisode(record, item.ruleName, item.episodeUrl),
    );
    startPlayer({
      ...item,
      roads: [{ name: '已缓存', episodes: [{ name: item.episodeName, url: item.episodeUrl }] }],
      roadIndex: 0,
      episodeIndex: 0,
      cacheOnly: true,
      originalRoadIndex: previous?.roadIndex || 0,
      originalEpisodeIndex: previous?.episodeIndex || 0,
      resume: previous?.position || 0,
    });
  };
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
            {availableUpdates.size > 0 && (
              <small
                className="rule-update-count"
                aria-label={`${availableUpdates.size} 条规则可更新`}
                title={`${availableUpdates.size} 条规则可更新`}
              >
                {availableUpdates.size}
              </small>
            )}
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
          {watchData.error && (
            <Notice onRetry={watchData.writeError ? undefined : watchData.refresh}>
              {watchData.error}
            </Notice>
          )}
          {watchData.legacy?.data && section !== 'settings' && (
            <Notice>
              此浏览器有旧收藏或观看记录，可在偏好设置中迁移到服务器。
              <button className="text-button" onClick={() => navigate('/settings')}>
                前往迁移 <ArrowRight size={15} />
              </button>
            </Notice>
          )}
          {!watchData.loading && player && (
            <Player
              key={`${player.ruleName}:${player.sourceUrl}:${player.cacheOnly ? player.id : 'source'}`}
              context={player}
              settings={settings}
              onClose={() => setPlayer(null)}
              onProgress={saveProgress}
              notify={notify}
              navigate={navigate}
            />
          )}
          {watchData.loading ? (
            <Spinner text="正在读取服务器收藏与观看记录…" />
          ) : (
            // Keep browsing state, including source search results, while the player is open.
            <div hidden={!!player}>
              {/* Keep the originating list mounted while its subject details are open. */}
              <div hidden={section === 'subject'}>
                {listSection === 'discover' && (
                  <Discover
                    query={query}
                    library={library}
                    history={history}
                    onOpen={openSubject}
                    onResume={resume}
                    navigate={navigate}
                  />
                )}
                {listSection === 'calendar' && <Calendar library={library} onOpen={openSubject} />}
                {listSection === 'categories' && (
                  <Categories
                    route={listRoute}
                    library={library}
                    onOpen={openSubject}
                    navigate={navigate}
                  />
                )}
                {listSection === 'library' && (
                  <Library library={library} onOpen={openSubject} navigate={navigate} />
                )}
              </div>
              {section === 'history' && (
                <HistoryPage
                  history={history}
                  onResume={resume}
                  onRemove={(key) => watchData.removeHistory(key).catch(() => {})}
                  onClear={async () => {
                    try {
                      await watchData.removeHistory();
                      notify('观看记录已清空');
                    } catch {
                      // The persistent notice includes the server failure.
                    }
                  }}
                />
              )}
              {section === 'downloads' && <Downloads onPlay={playCached} notify={notify} />}
              {section === 'subject' && (
                <Subject
                  key={route.split('/')[2]}
                  id={route.split('/')[2]?.split('?')[0]}
                  library={library}
                  updateLibrary={updateLibrary}
                  rules={rules}
                  onPlay={startPlayer}
                  navigate={navigate}
                  onBack={() => (origin ? window.history.back() : navigate('/discover'))}
                  backLabel={
                    origin?.route.includes('?q=')
                      ? '返回搜索结果'
                      : `返回${NAV.find((item) => item.id === listSection)?.label || '发现'}`
                  }
                />
              )}
              {section === 'sources' && (
                <Sources rules={rules} onPlay={startPlayer} navigate={navigate} />
              )}
              {section === 'rules' && (
                <Rules
                  rules={rules}
                  error={rulesError}
                  reload={reloadRules}
                  notify={notify}
                  availableUpdates={availableUpdates}
                />
              )}
              {section === 'settings' && (
                <Settings
                  settings={settings}
                  setSettings={setSettings}
                  library={library}
                  history={history}
                  watchData={watchData}
                  notify={notify}
                  navigate={navigate}
                />
              )}
              {![
                'discover',
                'categories',
                'calendar',
                'library',
                'history',
                'downloads',
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
            </div>
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

function Categories({ route, library, onOpen, navigate }) {
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

function Calendar({ library, onOpen }) {
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
                  <CachedImage referrerPolicy="no-referrer" src={imageSource(item.image)} alt="" />
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
          <p>将移除服务器中的全部观看记录，所有设备都会受影响，收藏会保留。</p>
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

function Downloads({ onPlay, notify }) {
  const downloads = useDownloads('all');
  const [removing, setRemoving] = useState(null);
  const active = downloads.items.filter(cacheActive).length;
  const maxBytes = Number(downloads.data?.maxBytes) || 0;
  const usedBytes = Number(downloads.data?.usedBytes) || 0;
  return (
    <>
      <PageHeading
        eyebrow="KEEP THE NEXT EPISODE CLOSE"
        title="下载缓存"
        description="先缓存，再安心观看。已缓存的视频可直接播放，也可保存到设备。"
      >
        <button
          className="button quiet"
          disabled={!downloads.items.length}
          onClick={() => setRemoving('all')}
        >
          <Trash2 size={15} />
          清空缓存
        </button>
      </PageHeading>
      <section className="cache-storage">
        <div className="cache-storage-heading">
          <span className="cache-storage-icon">
            <ArrowDownToLine size={22} />
          </span>
          <div>
            <h2>服务器视频缓存</h2>
            <p>
              {downloads.data
                ? `${bytesLabel(usedBytes)}${maxBytes ? ` / ${bytesLabel(maxBytes)}` : ''}`
                : '正在读取容量…'}
            </p>
          </div>
          <button className="text-button" onClick={downloads.reload}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
        {maxBytes > 0 && (
          <div className="progress-track cache-storage-track" aria-label="缓存空间使用量">
            <span style={{ width: `${Math.min(100, (usedBytes / maxBytes) * 100)}%` }} />
          </div>
        )}
        <p className="cache-help">
          缓存保存在部署服务器上，所有访问者共享；关闭页面后任务继续。播放仍需连接此服务器。 HLS
          保存到设备时为包含播放列表与分片的压缩包，不会合并为 MP4。
        </p>
      </section>
      <div className="catalog-toolbar">
        <div className="section-title">
          <span className="section-number">SAVED</span>
          <h2>缓存任务</h2>
        </div>
        <span className="muted small">
          {downloads.items.length} 个任务{active ? ` · ${active} 个正在下载` : ''}
        </span>
      </div>
      {downloads.error && <Notice onRetry={downloads.reload}>{downloads.error}</Notice>}
      {downloads.loading ? (
        <Spinner text="正在读取视频缓存…" />
      ) : downloads.items.length ? (
        <div className="cache-list">
          {downloads.items.map((item) => (
            <article className="cache-row" key={item.id}>
              <div className="cache-cover">
                {item.image ? (
                  <CachedImage
                    referrerPolicy="no-referrer"
                    src={imageSource(item.image)}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <Film size={24} />
                )}
              </div>
              <div className="cache-description">
                <h3>{item.title}</h3>
                <p>
                  {item.episodeName || '当前剧集'} · {item.ruleName} ·{' '}
                  {item.type === 'hls' ? 'HLS' : '视频'}
                </p>
                <CacheProgress item={item} />
              </div>
              <div className="cache-actions">
                {item.status === 'complete' && (
                  <>
                    <button
                      className="button primary"
                      onClick={() => onPlay(item)}
                      aria-label={`播放缓存 ${item.title} ${item.episodeName}`}
                    >
                      <Play size={15} />
                      播放
                    </button>
                    <a
                      className="button quiet"
                      href={item.downloadUrl}
                      download
                      aria-label={`保存到设备 ${item.title} ${item.episodeName}`}
                    >
                      <Download size={15} />
                      {item.type === 'hls' ? '保存压缩包' : '保存视频'}
                    </a>
                  </>
                )}
                <button
                  className="icon-button"
                  onClick={() => setRemoving(item)}
                  aria-label={`删除缓存 ${item.title} ${item.episodeName}`}
                  title={cacheActive(item) ? '取消下载并删除缓存' : '删除缓存'}
                >
                  {cacheActive(item) ? <X size={17} /> : <Trash2 size={17} />}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        !downloads.error && (
          <Empty icon={ArrowDownToLine} title="把下一话，提前准备好">
            播放视频时点击「缓存当前集」，即可在这里管理下载进度与已缓存的视频。
          </Empty>
        )
      )}
      {removing && (
        <CacheRemoval
          item={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            downloads.forget(removing === 'all' ? 'all' : removing.id);
            notify(removing === 'all' ? '全部视频缓存已清空' : '视频缓存已删除');
          }}
        />
      )}
    </>
  );
}

function Subject({ id, library, updateLibrary, rules, onPlay, navigate, onBack, backLabel }) {
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

function Rules({ rules, error, reload, notify, availableUpdates }) {
  const [tab, setTab] = useState('installed');
  const [modal, setModal] = useState(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteRule, setDeleteRule] = useState(null);
  const fileRef = useRef();
  const catalog = useRequest(tab === 'catalog' ? '/rules/catalog' : null);
  const [installing, setInstalling] = useState('');
  const [updateResults, setUpdateResults] = useState([]);
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
  const update = async (name) => {
    setInstalling(name || '*');
    setUpdateResults([]);
    try {
      const { results } = await api('/rules/update', {
        method: 'POST',
        body: JSON.stringify(name ? { name } : {}),
      });
      await reload();
      if (tab === 'catalog') catalog.retry();
      setUpdateResults(results.filter((result) => ['failed', 'unlisted'].includes(result.status)));
      const updated = results.filter((result) => result.status === 'updated').length;
      const latest = results.filter((result) => result.status === 'latest').length;
      notify(
        updated
          ? `已更新 ${updated} 条规则`
          : latest === results.length
            ? '规则已是最新版本'
            : '规则更新完成，请查看更新结果',
      );
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
          <div className="button-group">
            <button className="text-button" disabled={!!installing} onClick={() => update()}>
              <RefreshCw size={15} className={installing === '*' ? 'spin' : ''} />
              {installing === '*' ? '正在更新…' : '更新全部'}
              {installing !== '*' && availableUpdates.size > 0 && `（${availableUpdates.size}）`}
            </button>
            <button
              className="text-button"
              onClick={() => downloadJSON(rules, 'kazumi-rules.json')}
            >
              <Download size={15} />
              导出全部规则
            </button>
          </div>
        )}
      </div>
      {error && <Notice onRetry={reload}>{error}</Notice>}
      {updateResults.length > 0 && (
        <Notice>
          {updateResults.map((result) => (
            <span key={result.name}>
              {result.name}：{result.message}
              <br />
            </span>
          ))}
        </Notice>
      )}
      {tab === 'installed' &&
        (rules.length ? (
          <div className="rule-grid">
            {rules.map((rule) => (
              <article className="rule-card" key={rule.name}>
                <div className="rule-card-top">
                  <span className="rule-symbol">{rule.name?.slice(0, 1)}</span>
                  {availableUpdates.has(rule.name.toLowerCase()) ? (
                    <span
                      className="rule-badge rule-update-badge"
                      title={`可更新至 ${availableUpdates.get(rule.name.toLowerCase())}`}
                    >
                      可更新
                    </span>
                  ) : (
                    <span className="rule-badge">已安装</span>
                  )}
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
                      aria-label={`更新 ${rule.name}`}
                      title="从官方目录更新规则"
                      disabled={!!installing}
                      onClick={() => update(rule.name)}
                    >
                      <RefreshCw size={16} className={installing === rule.name ? 'spin' : ''} />
                    </button>
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
                    const installed = rules.some(
                      (r) => r.name.toLowerCase() === rule.name.toLowerCase(),
                    );
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
                          onClick={() => (installed ? update(rule.name) : install(rule.name))}
                        >
                          {installing === rule.name ? (
                            <LoaderCircle size={15} className="spin" />
                          ) : installed ? (
                            <RefreshCw size={14} />
                          ) : (
                            <Plus size={15} />
                          )}
                          {installed ? '检查更新' : '安装'}
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

function MetadataSettings({ notify }) {
  const request = useRequest('/metadata/status');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = request.data;
  useEffect(() => {
    const timer = setInterval(request.retry, status?.updating ? 2000 : 30000);
    return () => clearInterval(timer);
  }, [request.retry, status?.updating]);
  const phases = {
    idle: '等待首次导入',
    checking: '正在检查新资料',
    downloading: '正在下载资料包',
    verifying: '正在校验资料包',
    subjects: '正在整理番剧',
    episodes: '正在整理章节',
    indexing: '正在建立搜索索引',
    current: '资料已就绪',
    error: '更新未完成',
  };
  const update = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/metadata/update', { method: 'POST', body: '{}' });
      request.retry();
      notify('已开始检查番剧资料更新');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-card" aria-label="本地番剧资料">
      <div className="settings-card-heading">
        <BookOpen size={19} />
        <div>
          <h2>本地番剧资料</h2>
          <p>番剧浏览、热门榜单与放送日历使用本地资料</p>
        </div>
      </div>
      {request.error ? (
        <Notice onRetry={request.retry}>{request.error}</Notice>
      ) : !status ? (
        <p className="muted small">正在读取资料状态…</p>
      ) : status.mode === 'remote' ? (
        <p className="muted small">当前使用远程资料服务。</p>
      ) : (
        <>
          <p className="metadata-state" role="status" aria-live="polite">
            {phases[status.phase] || '正在更新资料'}
            {status.ready && (
              <span className="muted small">
                {' '}
                · {status.current.subjects.toLocaleString()} 部动画
              </span>
            )}
          </p>
          {status.current && (
            <p className="muted small metadata-version">
              资料版本：{status.current.version}
              <br />
              导入时间：{new Date(status.current.importedAt).toLocaleString('zh-CN')}
            </p>
          )}
          {status.phase === 'downloading' && status.progress?.totalBytes > 0 && (
            <div className="metadata-progress">
              <progress
                value={status.progress.bytes}
                max={status.progress.totalBytes}
                aria-label="归档下载进度"
              />
              <span className="muted small">
                {bytesLabel(status.progress.bytes)} / {bytesLabel(status.progress.totalBytes)}
              </span>
            </div>
          )}
          {['subjects', 'episodes'].includes(status.phase) && status.progress?.processed > 0 && (
            <p className="muted small">
              已处理 {status.progress.processed.toLocaleString()} 条记录
            </p>
          )}
          <p className="muted small">
            {status.autoUpdate
              ? `每 ${status.intervalHours} 小时自动检查更新。`
              : '自动更新已关闭，可手动检查。'}
            官方归档每周更新，更新期间仍可浏览已有资料。热门按近一年开播作品的累计收藏人数排序，日历依据已记录的章节日期；封面按需加载并缓存。
          </p>
          {(error || status.lastError) && (
            <Notice>
              {status.ready ? '更新失败，已有资料仍可使用。' : ''}
              {error || status.lastError}
            </Notice>
          )}
          <div className="button-group">
            <button className="button quiet" disabled={busy || status.updating} onClick={update}>
              <RefreshCw size={15} />
              {busy || status.updating
                ? '正在更新…'
                : status.ready
                  ? '检查资料更新'
                  : '下载番剧资料'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Settings({ settings, setSettings, library, history, watchData, notify, navigate }) {
  const fileRef = useRef();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
            收藏与观看记录保存在服务器，连接同一服务器的所有设备共享。偏好设置按浏览器保存。
            备份包含收藏、观看进度与本机偏好；站点规则请在规则管理页导出。
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
            <button
              className="button quiet"
              disabled={busy}
              onClick={() => fileRef.current.click()}
            >
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
          {watchData.legacy && (
            <>
              <p className="muted small">
                {watchData.legacy.error ||
                  '检测到此浏览器的旧收藏或观看记录。迁移会合并到服务器，保留服务器已有收藏和较新的进度。'}
              </p>
              {!watchData.legacy.error && (
                <button
                  className="button quiet"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      await watchData.migrate();
                      notify('浏览器旧数据已迁移到服务器');
                    } catch (error) {
                      setError(`迁移失败，浏览器旧数据已保留：${error.message}`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Upload size={15} />
                  {busy ? '正在保存…' : '迁移浏览器旧数据'}
                </button>
              )}
            </>
          )}
          {error && <Notice>{error}</Notice>}
        </section>
        <section className="settings-card">
          <div className="settings-card-heading">
            <ArrowDownToLine size={19} />
            <div>
              <h2>视频下载与缓存</h2>
              <p>缓存视频，查看下载进度，释放服务器空间</p>
            </div>
          </div>
          <p className="muted small">
            视频缓存保存在服务器，与所有访问者共享；不包含在浏览器数据备份中。
          </p>
          <div className="button-group">
            <button className="button quiet" onClick={() => navigate('/downloads')}>
              管理视频缓存 <ArrowRight size={15} />
            </button>
          </div>
        </section>
        <MetadataSettings notify={notify} />
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
          <div className="muted small">元数据由 Bangumi 提供 · 收藏与观看记录保存在服务器</div>
        </section>
      </div>
      {pending && (
        <Modal title="恢复数据备份" onClose={() => !busy && setPending(null)}>
          <p>
            将恢复 {Object.keys(pending.library).length} 部收藏与 {pending.history.length}{' '}
            条观看记录，并覆盖服务器的共享记录及当前浏览器的偏好设置。所有设备都会受影响。
          </p>
          <div className="modal-actions">
            <button className="button quiet" disabled={busy} onClick={() => setPending(null)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await watchData.restore({ library: pending.library, history: pending.history });
                  setSettings(pending.settings);
                  setPending(null);
                  notify('备份已恢复到服务器');
                } catch (error) {
                  setError(`恢复失败：${error.message}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '正在恢复…' : '恢复备份'}
            </button>
          </div>
          {error && <Notice>{error}</Notice>}
        </Modal>
      )}
    </>
  );
}

function CacheSelection({ context, episodes, roadName, downloads, onClose, onCreated }) {
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectAllRef = useRef(null);
  const entries = [...new Map(episodes.map((ep) => [ep.url, ep])).values()].map((ep) => ({
    episode: ep,
    item: downloads.items.find((entry) => sameCacheEpisode(entry, context.ruleName, ep.url)),
  }));
  const available = entries.filter(({ item }) => !item || item.status === 'error');
  const chosen = available.filter(({ episode }) => selected.has(episode.url));
  const allSelected = available.length > 0 && chosen.length === available.length;
  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = chosen.length > 0 && !allSelected;
  }, [chosen.length, allSelected]);
  const submit = async () => {
    if (!chosen.length || chosen.length > 200 || busy || downloads.loading || downloads.error)
      return;
    setBusy(true);
    setError('');
    try {
      const result = await api('/downloads/batch', {
        method: 'POST',
        body: JSON.stringify({
          ruleName: context.ruleName,
          sourceUrl: context.sourceUrl,
          title: context.title,
          image: context.image,
          subjectId: context.subjectId,
          episodes: chosen.map(({ episode }) => episode),
        }),
      });
      onCreated(result);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="选择缓存剧集" onClose={() => !busy && onClose()} wide>
      <p>
        {roadName} · 共 {entries.length} 集。勾选指定剧集，或全选当前线路。
      </p>
      <p className="cache-help">已缓存或已加入任务的剧集会自动跳过，缓存失败的剧集可重新选择。</p>
      {downloads.error && <Notice onRetry={downloads.reload}>{downloads.error}</Notice>}
      {error && <Notice>{error}</Notice>}
      {downloads.loading ? (
        <Spinner text="正在读取缓存状态…" />
      ) : (
        <>
          <div className="cache-selection-toolbar">
            <label>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                disabled={busy || !available.length || !!downloads.error}
                onChange={(e) =>
                  setSelected(
                    new Set(e.target.checked ? available.map(({ episode }) => episode.url) : []),
                  )
                }
              />
              全选
            </label>
            <span aria-live="polite">
              已选 {chosen.length} / {available.length} 集可缓存剧集
            </span>
          </div>
          <div className="cache-selection-grid" role="group" aria-label="可选缓存剧集">
            {entries.map(({ episode: ep, item }, index) => {
              const blocked = !!item && item.status !== 'error';
              return (
                <label
                  className={`cache-episode-option ${!blocked && selected.has(ep.url) ? 'selected' : ''}`}
                  key={ep.url}
                >
                  <input
                    type="checkbox"
                    checked={!blocked && selected.has(ep.url)}
                    disabled={busy || blocked || !!downloads.error}
                    aria-label={ep.name || `第 ${index + 1} 集`}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(ep.url);
                        else next.delete(ep.url);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <span>{ep.name || `第 ${index + 1} 集`}</span>
                    {item && (
                      <small className={`cache-status-${item.status}`}>{cacheStatus(item)}</small>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
      {chosen.length > 200 && <Notice>一次最多选择 200 集，请取消部分剧集后再缓存。</Notice>}
      <div className="modal-actions">
        <button className="button quiet" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={
            busy || !chosen.length || chosen.length > 200 || downloads.loading || !!downloads.error
          }
          onClick={submit}
        >
          {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}
          {busy ? '正在加入缓存…' : `缓存所选（${chosen.length} 集）`}
        </button>
      </div>
    </Modal>
  );
}

function PlayerCachePanel({
  context,
  episode,
  episodes,
  roadName,
  resolved,
  onCacheRemoved,
  navigate,
  notify,
}) {
  const downloads = useDownloads('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const item = downloads.items.find((entry) =>
    sameCacheEpisode(entry, context.ruleName, episode.url),
  );
  const canCache = resolved && ['video', 'hls'].includes(resolved.type) && !resolved.cached;
  const create = async () => {
    if (!canCache || busy) return;
    setBusy('current');
    setError('');
    try {
      const created = await api('/downloads', {
        method: 'POST',
        body: JSON.stringify({
          ruleName: context.ruleName,
          episodeUrl: episode.url,
          sourceUrl: context.sourceUrl,
          title: context.title,
          episodeName: episode.name,
          image: context.image,
          subjectId: context.subjectId,
          mediaUrl: resolved.url,
          type: resolved.type,
        }),
      });
      downloads.accept(created);
      notify(created.status === 'complete' ? '当前集已缓存' : '已加入缓存任务，关闭页面后仍会继续');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="player-cache-panel" aria-label="剧集缓存">
      <div className="player-cache-heading">
        <div>
          <h2>
            <ArrowDownToLine size={17} />
            剧集缓存
          </h2>
          <p>
            {resolved?.cached ? '正在播放服务器缓存。' : '缓存到服务器，关闭页面后仍会继续下载。'}
          </p>
        </div>
        <button className="text-button" onClick={() => navigate('/downloads')}>
          管理缓存 <ArrowRight size={14} />
        </button>
      </div>
      {item && <CacheProgress item={item} />}
      {downloads.error && (
        <Notice onRetry={downloads.reload}>无法读取缓存状态：{downloads.error}</Notice>
      )}
      {error && <Notice>{error}</Notice>}
      <div className="player-cache-actions">
        {(!item || item.status === 'error') && !resolved?.cached && (
          <button className="button quiet" disabled={!canCache || busy} onClick={create}>
            {busy === 'current' ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <ArrowDownToLine size={15} />
            )}
            {item?.status === 'error' ? '重新缓存当前集' : '缓存当前集'}
          </button>
        )}
        {!context.cacheOnly && (
          <button
            className="button quiet"
            disabled={!!busy || !episodes.length}
            onClick={() => setSelecting(true)}
          >
            <ArrowDownToLine size={15} />
            选择剧集缓存
          </button>
        )}
        {item?.status === 'complete' && (
          <a className="button quiet" href={item.downloadUrl} download>
            <Download size={15} />
            {item.type === 'hls' ? '保存压缩包到设备' : '保存视频到设备'}
          </a>
        )}
        {item && (
          <button className="text-button" onClick={() => setRemoving(item)}>
            <Trash2 size={14} />
            {cacheActive(item) ? '取消下载' : '清理当前缓存'}
          </button>
        )}
        {!item && resolved?.cached && !downloads.loading && !downloads.error && (
          <button className="button quiet" onClick={onCacheRemoved}>
            <RefreshCw size={15} />
            缓存已被移除，重新解析
          </button>
        )}
        {resolved?.type === 'iframe' && (
          <span className="cache-help">站点内嵌播放器无法缓存，请切换可直接播放的视频线路。</span>
        )}
        {!context.cacheOnly && (
          <span className="cache-help">
            支持全选当前线路或勾选指定剧集，自动跳过已缓存或正在下载的剧集。
          </span>
        )}
        {item?.status === 'complete' && item.type === 'hls' && (
          <span className="cache-help">HLS 压缩包包含播放列表与分片，不会合并为 MP4。</span>
        )}
      </div>
      {selecting && (
        <CacheSelection
          context={context}
          episodes={episodes}
          roadName={roadName}
          downloads={downloads}
          onClose={() => setSelecting(false)}
          onCreated={(result) => {
            downloads.accept(result.items);
            setSelecting(false);
            notify(
              result.added
                ? `已加入 ${result.added} 集缓存任务${result.skipped ? `，跳过 ${result.skipped} 集已有任务` : ''}，关闭页面后仍会继续`
                : '所选剧集均已缓存或加入任务',
            );
          }}
        />
      )}
      {removing && (
        <CacheRemoval
          item={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            downloads.forget(removing.id);
            if (resolved?.cached) onCacheRemoved();
            notify('当前剧集缓存已删除');
          }}
        />
      )}
    </section>
  );
}

function Player({ context, settings, onClose, onProgress, notify, navigate }) {
  const [roads, setRoads] = useState(context.roads || []);
  const [roadIndex, setRoadIndex] = useState(context.roadIndex || 0);
  const [episodeIndex, setEpisodeIndex] = useState(context.episodeIndex || 0);
  const [resolved, setResolved] = useState(null);
  const [loading, setLoading] = useState(true);
  const [slowResolve, setSlowResolve] = useState(false);
  const [error, setError] = useState('');
  const [playError, setPlayError] = useState('');
  const [playInfo, setPlayInfo] = useState(null);
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
    setPlayInfo(null);
    setResolved(null);
    resumedRef.current = false;
    api('/resolve', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ ruleName: context.ruleName, url: episode.url }),
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setResolved({ ...data, episodeUrl: episode.url });
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
        roadIndex: context.cacheOnly ? context.originalRoadIndex : roadIndex,
        episodeIndex: context.cacheOnly ? context.originalEpisodeIndex : episodeIndex,
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
    video.addEventListener('loadedmetadata', resume);
    video.addEventListener('timeupdate', update);
    video.addEventListener('pause', save);
    window.addEventListener('pagehide', save);
    const stopPlayback = startPlayback(video, resolved, {
      onError: setPlayError,
      onInfo: setPlayInfo,
    });
    record(positionRef.current);
    return () => {
      save(false);
      video.removeEventListener('loadedmetadata', resume);
      video.removeEventListener('timeupdate', update);
      video.removeEventListener('pause', save);
      window.removeEventListener('pagehide', save);
      stopPlayback();
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
      {playError && (
        <Notice onRetry={() => setAttempt((p) => p + 1)}>
          <strong>{playError.title}。</strong>
          {playError.message}
        </Notice>
      )}
      {!playError && playInfo?.status === 'unsupported' && (
        <Notice>当前浏览器报告不支持该线路的编码，若无法播放请切换线路或尝试其他浏览器。</Notice>
      )}
      {resolved && resolved.type !== 'iframe' && (
        <PlaybackDiagnostics info={playInfo} error={playError} />
      )}
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
      {episode && (
        <PlayerCachePanel
          key={`${context.ruleName}:${episode.url}`}
          context={context}
          episode={episode}
          episodes={episodes}
          roadName={roads[roadIndex]?.name || `线路 ${roadIndex + 1}`}
          resolved={resolved?.episodeUrl === episode.url ? resolved : null}
          onCacheRemoved={() => setAttempt((value) => value + 1)}
          navigate={navigate}
          notify={notify}
        />
      )}
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
