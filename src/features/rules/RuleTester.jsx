import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, Search, Square } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Notice } from '../../components/feedback.jsx';
import { WebPlayer } from '../player/WebPlayer.jsx';
import { RuleParseTrace } from './RuleParseTrace.jsx';
import { sanitizeDiagnosticText } from '../../../shared/diagnostic-text.js';

const stages = { search: '搜索', chapters: '章节解析', resolve: '播放解析' };
const elapsed = (result) => `${(result.elapsedMs / 1000).toFixed(2)} 秒`;

export function RuleTester({ rule, active }) {
  const [keyword, setKeyword] = useState('');
  const [detail, setDetail] = useState('');
  const [playUrl, setPlayUrl] = useState('');
  const [search, setSearch] = useState(null);
  const [chapters, setChapters] = useState(null);
  const [searchTrace, setSearchTrace] = useState(null);
  const [chapterTrace, setChapterTrace] = useState(null);
  const [roadIndex, setRoadIndex] = useState(0);
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [resolved, setResolved] = useState(null);
  const [logs, setLogs] = useState([]);
  const [playStatus, setPlayStatus] = useState('');
  const [playError, setPlayError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const request = useRef(null);
  const nextLog = useRef(0);
  const errorRef = useRef(null);
  const searchRef = useRef(null);
  const chaptersRef = useRef(null);
  const playbackRef = useRef(null);
  const roads = chapters?.roads || [];
  const episodes = roads[roadIndex]?.episodes || [];
  const ruleRevision = JSON.stringify(rule);

  useEffect(() => {
    if (!active) {
      setBusy('');
      setResolved(null);
      setPlayStatus('');
    }
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [active]);

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setBusy('');
    setError('');
    setSearch(null);
    setSearchTrace(null);
    setChapters(null);
    setChapterTrace(null);
    setDetail('');
    setPlayUrl('');
    setRoadIndex(0);
    setEpisodeIndex(0);
    setResolved(null);
    setLogs([]);
    setPlayStatus('');
    setPlayError('');
  }, [ruleRevision]);

  useEffect(() => {
    if (!active) return;
    const target = error ? errorRef : resolved ? playbackRef : chapters ? chaptersRef : searchRef;
    target.current?.scrollIntoView({ block: 'nearest' });
  }, [error, resolved, chapters, search, active]);

  const addLog = (entry) => {
    if (!entry.message) return;
    const log = {
      ...entry,
      id: ++nextLog.current,
      message: sanitizeDiagnosticText(entry.message),
    };
    setLogs((current) => [...current, log].slice(-150));
  };
  const clearPlayback = () => {
    setResolved(null);
    setPlayError('');
    setPlayStatus('');
    setLogs([]);
  };
  const clearChapters = () => {
    setChapters(null);
    setChapterTrace(null);
    setRoadIndex(0);
    setEpisodeIndex(0);
    setPlayUrl('');
    clearPlayback();
  };
  const run = async (stage, url) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(stage);
    setError('');
    clearPlayback();
    if (stage === 'search') {
      setSearch(null);
      setSearchTrace(null);
      setDetail('');
      clearChapters();
    } else if (stage === 'chapters') clearChapters();
    try {
      const data = await api('/rules/test', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ rule, stage, ...(stage === 'search' ? { keyword } : { url }) }),
        onDiagnostic: (entry) => {
          if (request.current === controller && !controller.signal.aborted) addLog(entry);
        },
      });
      if (request.current !== controller || controller.signal.aborted) return;
      if (stage === 'search') {
        setSearch(data);
        setSearchTrace(data.trace || null);
      } else if (stage === 'chapters') {
        setChapters(data);
        setChapterTrace(data.trace || null);
        const index = Math.max(
          0,
          data.roads.findIndex((road) => road.episodes?.length),
        );
        setRoadIndex(index);
        setPlayUrl(data.roads[index]?.episodes?.[0]?.url || '');
      } else {
        setResolved(data);
        setPlayStatus('解析成功，点击播放器开始试播');
      }
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(error.message);
        if (stage === 'search') setSearchTrace(error.trace || null);
        else if (stage === 'chapters') setChapterTrace(error.trace || null);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy('');
      }
    }
  };
  const stop = () => {
    request.current?.abort();
    request.current = null;
    setBusy('');
    setError('测试已停止，可修改配置后重新测试。');
  };
  const selectEpisode = (road, episode) => {
    setRoadIndex(road);
    setEpisodeIndex(episode);
    setPlayUrl(roads[road]?.episodes?.[episode]?.url || '');
    clearPlayback();
    setError('');
  };

  return (
    <section className="rule-tester" hidden={!active} aria-label="规则测试面板">
      <p className="muted small">
        使用当前草稿请求来源站点，不保存规则或观看记录。可按顺序测试，也可直接填写详情或播放地址。
      </p>
      {busy && (
        <div className="rule-test-progress" role="status">
          <LoaderCircle size={16} className="spin" />
          正在测试{stages[busy]}…
          <button className="text-button" onClick={stop}>
            <Square size={13} />
            停止测试
          </button>
        </div>
      )}
      {error && (
        <div ref={errorRef}>
          <Notice>{error}</Notice>
        </div>
      )}
      <section className="rule-test-step">
        <h3>1. 搜索结果</h3>
        <form
          className="rule-test-input"
          onSubmit={(event) => {
            event.preventDefault();
            run('search');
          }}
        >
          <label className="rule-field">
            <span>搜索关键词</span>
            <input
              aria-label="测试搜索关键词"
              placeholder="输入动画名称"
              value={keyword}
              disabled={!!busy}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
          <button className="button quiet" disabled={!!busy || !keyword.trim()}>
            <Search size={15} />
            测试搜索
          </button>
        </form>
        {search && (
          <>
            <p ref={searchRef} className="rule-test-summary" role="status">
              找到 {search.items.length} 个搜索结果 · {elapsed(search)}
            </p>
            {search.items.length ? (
              <ul className="rule-test-results">
                {search.items.map((item, index) => (
                  <li key={`${item.url}:${index}`}>
                    <button
                      disabled={!!busy}
                      aria-label={`解析章节 ${item.name}`}
                      onClick={() => {
                        setDetail(item.url);
                        run('chapters', item.url);
                      }}
                    >
                      <strong>{item.name}</strong>
                      <small>{item.url}</small>
                      <span>解析章节 →</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">没有匹配结果，可更换关键词或检查搜索配置。</p>
            )}
          </>
        )}
        {searchTrace && <RuleParseTrace trace={searchTrace} />}
      </section>
      <section className="rule-test-step">
        <h3>2. 章节与播放线路</h3>
        <form
          className="rule-test-input"
          onSubmit={(event) => {
            event.preventDefault();
            run('chapters', detail);
          }}
        >
          <label className="rule-field">
            <span>详情地址或来源值</span>
            <input
              aria-label="测试详情地址或来源值"
              placeholder="选择搜索结果，或填写详情 URL / API 来源值"
              value={detail}
              disabled={!!busy}
              onChange={(event) => {
                setDetail(event.target.value);
                clearChapters();
              }}
            />
          </label>
          <button className="button quiet" disabled={!!busy || !detail.trim()}>
            测试章节
          </button>
        </form>
        {chapters && (
          <>
            <p ref={chaptersRef} className="rule-test-summary" role="status">
              解析到 {roads.length} 条播放线路、
              {roads.reduce((count, road) => count + road.episodes.length, 0)} 个剧集 ·{' '}
              {elapsed(chapters)}
            </p>
            <div className="rule-test-selectors">
              <label className="rule-field">
                <span>播放线路</span>
                <select
                  aria-label="测试播放线路"
                  disabled={!!busy}
                  value={roadIndex}
                  onChange={(event) => selectEpisode(Number(event.target.value), 0)}
                >
                  {roads.map((road, index) => (
                    <option value={index} key={index} disabled={!road.episodes.length}>
                      {road.name}（{road.episodes.length} 集）
                    </option>
                  ))}
                </select>
              </label>
              <label className="rule-field">
                <span>剧集</span>
                <select
                  aria-label="测试剧集"
                  disabled={!!busy || !episodes.length}
                  value={episodeIndex}
                  onChange={(event) => selectEpisode(roadIndex, Number(event.target.value))}
                >
                  {episodes.map((episode, index) => (
                    <option key={index} value={index}>
                      {episode.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ol className="rule-test-episodes" aria-label="解析出的剧集">
              {episodes.map((episode, index) => (
                <li key={index}>
                  <button
                    className={index === episodeIndex ? 'selected' : ''}
                    aria-pressed={index === episodeIndex}
                    disabled={!!busy}
                    onClick={() => selectEpisode(roadIndex, index)}
                  >
                    {episode.name}
                    <small>{episode.url}</small>
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
        {chapterTrace && <RuleParseTrace trace={chapterTrace} />}
      </section>
      <section className="rule-test-step">
        <h3>3. 播放解析与试播</h3>
        <form
          className="rule-test-input"
          onSubmit={(event) => {
            event.preventDefault();
            run('resolve', playUrl);
          }}
        >
          <label className="rule-field">
            <span>播放地址</span>
            <input
              aria-label="测试播放地址"
              value={playUrl}
              disabled={!!busy}
              placeholder="选择线路与剧集，或直接填写播放页地址"
              onChange={(event) => {
                setPlayUrl(event.target.value);
                clearPlayback();
              }}
            />
          </label>
          <button className="button quiet" disabled={!!busy || !playUrl.trim()}>
            <Play size={15} />
            测试播放
          </button>
        </form>
        {resolved && active && (
          <>
            <p className="rule-test-summary" role="status">
              已解析为 {resolved.source.type === 'hls' ? 'HLS' : '视频文件'} · {elapsed(resolved)} ·{' '}
              {playStatus}
            </p>
            <div ref={playbackRef} className="rule-test-player">
              <WebPlayer
                source={resolved.source}
                autoplay={false}
                onError={setPlayError}
                onDebug={(entry) => {
                  addLog(entry);
                  if (entry.metrics?.status) setPlayStatus(entry.metrics.status);
                }}
              />
            </div>
            <button className="text-button" onClick={clearPlayback}>
              <Square size={13} />
              结束试播
            </button>
          </>
        )}
        {playError && <Notice>{playError}</Notice>}
        {logs.length > 0 && (
          <details className="rule-test-diagnostics" open>
            <summary>解析与试播日志（{logs.length}）</summary>
            <ol aria-label="规则测试日志">
              {logs.map((entry) => (
                <li key={entry.id} data-level={entry.level}>
                  <strong>{entry.scope}</strong> {entry.message}
                </li>
              ))}
            </ol>
          </details>
        )}
      </section>
    </section>
  );
}
