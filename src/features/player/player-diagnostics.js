import { sanitizeDiagnosticText } from '../../../shared/diagnostic-text.js';
export { sanitizeDiagnosticText } from '../../../shared/diagnostic-text.js';

export const MAX_PLAYER_LOGS = 300;

export const emptyPlaybackMetrics = {
  status: '等待播放',
  engine: '—',
  currentTime: 0,
  duration: null,
  live: false,
  width: 0,
  height: 0,
  bufferedAhead: 0,
  playbackRate: 1,
  droppedFrames: null,
  totalFrames: null,
  readyState: 0,
  networkState: 0,
  bandwidth: null,
  bitrate: null,
  codecs: '',
  fragments: null,
  resolveMs: null,
};

export function createPlayerDiagnostics() {
  let snapshot = { metrics: { ...emptyPlaybackMetrics }, logs: [] };
  let sequence = 0;
  const listeners = new Set();
  const publish = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(metrics) {
      snapshot = { ...snapshot, metrics: { ...snapshot.metrics, ...metrics } };
      publish();
    },
    log(level, scope, message, time = Date.now(), phase) {
      snapshot = {
        ...snapshot,
        logs: [
          ...snapshot.logs,
          {
            id: ++sequence,
            time: Number.isFinite(time) ? time : Date.now(),
            ...(phase && { phase }),
            level,
            scope,
            message: sanitizeDiagnosticText(message),
          },
        ].slice(-MAX_PLAYER_LOGS),
      };
      publish();
    },
    clear() {
      snapshot = { ...snapshot, logs: [] };
      publish();
    },
  };
}

export function readPlaybackMetrics(video) {
  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  let bufferedAhead = 0;
  for (let index = 0; index < video.buffered.length; index++) {
    if (video.buffered.start(index) <= currentTime && video.buffered.end(index) >= currentTime) {
      bufferedAhead = Math.max(0, video.buffered.end(index) - currentTime);
      break;
    }
  }
  const quality = video.getVideoPlaybackQuality?.();
  return {
    currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : null,
    live: video.duration === Infinity,
    width: video.videoWidth,
    height: video.videoHeight,
    bufferedAhead,
    playbackRate: video.playbackRate,
    readyState: video.readyState,
    networkState: video.networkState,
    droppedFrames: quality?.droppedVideoFrames ?? null,
    totalFrames: quality?.totalVideoFrames ?? null,
  };
}

const mediaErrors = {
  1: '播放请求被中止',
  2: '媒体网络请求失败',
  3: '视频解码失败',
  4: '媒体格式或来源不受支持',
};

export function attachPlaybackDiagnostics(video, report) {
  const sample = () => report({ metrics: readPlaybackMetrics(video) });
  const events = {
    loadstart: ['info', '正在加载', '开始加载媒体'],
    loadedmetadata: ['info', null, '已读取视频元数据'],
    canplay: ['info', '可以播放', '缓冲就绪，可以播放'],
    playing: ['info', '正在播放', '开始播放'],
    pause: ['info', '已暂停', '暂停播放'],
    waiting: ['warn', '正在缓冲', '等待视频缓冲'],
    stalled: ['warn', null, '媒体数据传输停滞'],
    seeking: ['info', '正在跳转', '跳转到'],
    seeked: ['info', null, '跳转完成'],
    ratechange: ['info', null, '播放速度变更为'],
    ended: ['info', '播放结束', '本话播放结束'],
    error: ['error', '播放错误', ''],
  };
  const listeners = Object.entries(events).map(([event, [level, status, text]]) => {
    const listener = () => {
      let message = text;
      if (event === 'seeking') message += ` ${video.currentTime.toFixed(1)} 秒`;
      if (event === 'ratechange') message += ` ${video.playbackRate}×`;
      if (event === 'loadedmetadata') message += ` · ${video.videoWidth} × ${video.videoHeight}`;
      if (event === 'error')
        message = `${mediaErrors[video.error?.code] || '未知媒体错误'}（code=${video.error?.code ?? '—'}）${video.error?.message ? ` · ${video.error.message}` : ''}`;
      // canplay/seeked also fire while paused; retain the actual playback state.
      const nextStatus = video.error
        ? '播放错误'
        : video.ended
          ? '播放结束'
          : event === 'canplay' || event === 'seeked' || event === 'loadedmetadata'
            ? video.paused
              ? '已暂停'
              : '正在播放'
            : status;
      report({
        level,
        scope: '媒体',
        message,
        metrics: { ...readPlaybackMetrics(video), ...(nextStatus && { status: nextStatus }) },
      });
    };
    video.addEventListener(event, listener);
    return [event, listener];
  });
  sample();
  const timer = setInterval(sample, 1000);
  return () => {
    clearInterval(timer);
    listeners.forEach(([event, listener]) => video.removeEventListener(event, listener));
  };
}
