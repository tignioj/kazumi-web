import React, { useCallback, useEffect, useRef, useState } from 'react';
import { startPlayback } from './playback.js';
import { PlaybackDiagnostics } from './PlaybackDiagnostics.jsx';
import { watchKey } from '../../../shared/watch-data.js';
import {
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  Play,
  RefreshCw,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { Notice, Spinner } from '../../components/feedback.jsx';
import { PlayerCachePanel } from './PlayerCachePanel.jsx';

export function Player({ context, settings, onClose, onProgress, notify, navigate }) {
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
        roadIndex: context.cacheOnly ? episode.originalRoadIndex : roadIndex,
        episodeIndex: context.cacheOnly ? episode.originalEpisodeIndex : episodeIndex,
        position: Number.isFinite(position) ? position : 0,
        duration: Number.isFinite(duration) ? duration : 0,
        updatedAt: Date.now(),
      });
    },
    [episode, roadIndex, episodeIndex, context],
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
