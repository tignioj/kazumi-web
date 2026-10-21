import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Bug, Copy, Download, Trash2, X } from 'lucide-react';
import { timeLabel } from '../../lib/format.js';
import { downloadJSON } from '../../lib/download-json.js';
import { sanitizeDiagnosticText, MAX_PLAYER_LOGS } from './player-diagnostics.js';

const readyStates = ['尚无数据', '已读取元数据', '当前帧可用', '后续帧可用', '缓冲充足'];
const networkStates = ['尚未初始化', '空闲', '正在加载', '没有可用来源'];
const levels = { info: '信息', warn: '警告', error: '错误' };
const clock = (time) => new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
const rate = (value) =>
  Number.isFinite(value) && value > 0 ? `${(value / 1_000_000).toFixed(2)} Mbps` : '—';

export function PlayerDebugPanel({
  diagnostics,
  context,
  episode,
  roadName,
  resolved,
  onClose,
  notify,
}) {
  const { metrics, logs } = useSyncExternalStore(diagnostics.subscribe, diagnostics.getSnapshot);
  const [tab, setTab] = useState('overview');
  const [level, setLevel] = useState('all');
  const logList = useRef(null);
  const following = useRef(true);
  const filtered = logs.filter((entry) => level === 'all' || entry.level === level);
  const latestId = filtered.at(-1)?.id;
  useEffect(() => {
    if (following.current && logList.current)
      logList.current.scrollTop = logList.current.scrollHeight;
  }, [latestId, tab, level]);
  const fields = [
    ['播放状态', metrics.status],
    ['播放内核', metrics.engine],
    [
      '媒体类型',
      resolved
        ? resolved.type === 'hls'
          ? 'HLS'
          : resolved.type === 'iframe'
            ? '内嵌网页'
            : '视频文件'
        : '—',
    ],
    [
      '媒体路径',
      resolved
        ? resolved.cached
          ? '本地缓存'
          : resolved.url.startsWith('/api/media?')
            ? '服务端媒体代理'
            : '来源直连'
        : '—',
    ],
    ['解析耗时', metrics.resolveMs === null ? '—' : `${(metrics.resolveMs / 1000).toFixed(2)} 秒`],
    ['分辨率', metrics.width && metrics.height ? `${metrics.width} × ${metrics.height}` : '—'],
    [
      '播放进度',
      `${timeLabel(metrics.currentTime)} / ${metrics.live ? '直播' : metrics.duration === null ? '—' : timeLabel(metrics.duration)}`,
    ],
    ['前向缓冲', `${metrics.bufferedAhead.toFixed(1)} 秒`],
    ['播放速度', `${metrics.playbackRate}×`],
    [
      '掉帧 / 总帧数',
      metrics.totalFrames === null ? '—' : `${metrics.droppedFrames} / ${metrics.totalFrames}`,
    ],
    ['媒体就绪', `${metrics.readyState} · ${readyStates[metrics.readyState] || '未知'}`],
    ['媒体网络', `${metrics.networkState} · ${networkStates[metrics.networkState] || '未知'}`],
    ...(resolved?.type === 'hls' && !resolved.nativePlayback
      ? [
          ['估算带宽', rate(metrics.bandwidth)],
          ['清晰度码率', rate(metrics.bitrate)],
          ['已加载分片', metrics.fragments === null ? '—' : String(metrics.fragments)],
        ]
      : []),
    ['编码信息', metrics.codecs || '—'],
  ];
  const sourceFields = [
    ['规则', context.ruleName],
    ['线路', roadName],
    ['剧集', episode?.name || '—'],
    ['来源页面', episode?.url ? sanitizeDiagnosticText(episode.url) : '—'],
    ['播放地址', resolved?.url ? sanitizeDiagnosticText(resolved.url) : '—'],
  ];
  const report = () => ({
    title: context.title,
    exportedAt: new Date().toISOString(),
    environment: navigator.userAgent,
    source: Object.fromEntries(sourceFields),
    metrics,
    logs: logs.map(({ time, level, scope, message }) => ({
      time: new Date(time).toISOString(),
      level,
      scope,
      message,
    })),
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
      notify('调试信息已复制');
    } catch {
      notify('无法访问剪贴板，请使用导出调试信息');
    }
  };
  return (
    <aside className="player-debug" aria-label="播放调试窗口">
      <header className="player-debug-header">
        <h2>
          <Bug size={16} />
          播放调试
        </h2>
        <button className="icon-button" aria-label="关闭调试窗口" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="player-debug-tabs" role="tablist" aria-label="调试内容">
        <button
          role="tab"
          id="player-debug-overview-tab"
          aria-selected={tab === 'overview'}
          aria-controls="player-debug-overview"
          onClick={() => setTab('overview')}
        >
          概览
        </button>
        <button
          role="tab"
          id="player-debug-logs-tab"
          aria-selected={tab === 'logs'}
          aria-controls="player-debug-logs"
          onClick={() => setTab('logs')}
        >
          日志 <span>{logs.length}</span>
        </button>
      </div>
      {tab === 'overview' ? (
        <div
          className="player-debug-overview"
          role="tabpanel"
          id="player-debug-overview"
          aria-labelledby="player-debug-overview-tab"
        >
          <dl className="player-debug-metrics">
            {fields.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <h3>当前来源</h3>
          <dl className="player-debug-source">
            {sourceFields.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="player-debug-hint">
            每秒更新；浏览器未提供的参数显示为「—」。
            {resolved?.type === 'iframe' && '内嵌网页仅记录加载事件，无法读取内部播放参数。'}
          </p>
        </div>
      ) : (
        <div
          className="player-debug-log-panel"
          role="tabpanel"
          id="player-debug-logs"
          aria-labelledby="player-debug-logs-tab"
        >
          <div className="player-debug-log-toolbar">
            <select
              aria-label="日志级别"
              value={level}
              onChange={(event) => {
                following.current = true;
                setLevel(event.target.value);
              }}
            >
              <option value="all">全部级别</option>
              {Object.entries(levels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="text-button"
              disabled={!logs.length}
              onClick={() => diagnostics.clear()}
            >
              <Trash2 size={13} />
              清空
            </button>
          </div>
          <div
            className="player-debug-logs"
            ref={logList}
            tabIndex={0}
            aria-label="播放日志"
            onScroll={(event) => {
              const node = event.currentTarget;
              following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
            }}
          >
            {filtered.length ? (
              filtered.map((entry) => (
                <div className={`player-debug-entry ${entry.level}`} key={entry.id}>
                  <div>
                    <time dateTime={new Date(entry.time).toISOString()}>{clock(entry.time)}</time>
                    <span>
                      {levels[entry.level]} · {entry.scope}
                    </span>
                  </div>
                  <p>{entry.message}</p>
                </div>
              ))
            ) : (
              <p className="player-debug-empty">
                {logs.length ? '当前级别没有日志' : '暂无日志，后续播放事件会显示在这里'}
              </p>
            )}
          </div>
          <p className="player-debug-hint">保留最近 {MAX_PLAYER_LOGS} 条；向上滚动可暂停跟随。</p>
        </div>
      )}
      <footer className="player-debug-footer">
        <button className="text-button" onClick={copy}>
          <Copy size={13} />
          复制
        </button>
        <button
          className="text-button"
          onClick={() => downloadJSON(report(), 'kazumi-playback-debug.json')}
        >
          <Download size={13} />
          导出
        </button>
        <span>地址参数已隐藏</span>
      </footer>
    </aside>
  );
}
