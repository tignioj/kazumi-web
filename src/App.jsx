import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useWatchData } from './hooks/use-watch-data.js';
import { VerificationHost } from './features/verification/VerificationHost.jsx';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  Compass,
  History,
  LayoutGrid,
  Menu,
  Moon,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { api } from './lib/api.js';
import { useStored } from './hooks/use-stored.js';
import { useRequest } from './hooks/use-request.js';
import { useNetworkSettings } from './hooks/use-network-settings.js';
import { ProxyToggle } from './components/ProxyToggle.jsx';
import { Notice, Empty, Spinner } from './components/feedback.jsx';
import { Discover } from './features/catalog/Discover.jsx';
import { Categories } from './features/catalog/Categories.jsx';
import { Calendar } from './features/catalog/Calendar.jsx';
import { Subject } from './features/catalog/Subject.jsx';
import { Library } from './features/library/Library.jsx';
import { HistoryPage } from './features/history/HistoryPage.jsx';
import { sameCacheEpisode } from './features/downloads/utils.js';
import { Downloads } from './features/downloads/Downloads.jsx';
import { Sources } from './features/sources/Sources.jsx';
import { Rules } from './features/rules/Rules.jsx';
import { Settings } from './features/settings/Settings.jsx';
import { Player } from './features/player/Player.jsx';

const NAV = [
  { id: 'discover', label: '发现', sub: 'DISCOVER', icon: Compass },
  { id: 'categories', label: '番剧分类', sub: 'CATEGORIES', icon: LayoutGrid },
  { id: 'calendar', label: '放送日历', sub: 'ON AIR', icon: CalendarDays },
  { id: 'library', label: '我的收藏', sub: 'COLLECTION', icon: BookOpen },
  { id: 'history', label: '观看记录', sub: 'HISTORY', icon: History },
  { id: 'downloads', label: '下载缓存', sub: 'DOWNLOADS', icon: ArrowDownToLine },
];

export default function App() {
  const [navigation, setNavigation] = useState(() => ({
    route: location.hash.slice(1) || '/discover',
    origin: null,
    scrollY: null,
  }));
  const { route, origin } = navigation;
  const watchData = useWatchData(api);
  const network = useNetworkSettings();
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
    if (watchData.loading || network.loading || route !== '/settings?section=network') return;
    const frame = requestAnimationFrame(() => {
      document.getElementById('network-settings')?.scrollIntoView({ behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [route, watchData.loading, network.loading]);
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
  const playCached = (item, items) => {
    const previous = history.find((record) =>
      sameCacheEpisode(record, item.ruleName, item.episodeUrl),
    );
    const episodes = items
      .filter((entry) => entry.status === 'complete')
      .map((entry, index) => {
        const record = history.find((record) =>
          sameCacheEpisode(record, entry.ruleName, entry.episodeUrl),
        );
        return {
          name: entry.episodeName,
          url: entry.episodeUrl,
          originalRoadIndex: record?.roadIndex || 0,
          originalEpisodeIndex: record?.episodeIndex ?? index,
        };
      });
    startPlayer({
      ...item,
      roads: [{ name: '已缓存', episodes }],
      roadIndex: 0,
      episodeIndex: episodes.findIndex((episode) => episode.url === item.episodeUrl),
      cacheOnly: true,
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
          <ProxyToggle
            network={network}
            notify={notify}
            onConfigure={() => {
              if (route === '/settings?section=network')
                document
                  .getElementById('network-settings')
                  ?.scrollIntoView({ behavior: 'instant' });
              else navigate('/settings?section=network');
            }}
          />
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
                  network={network}
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
