import Hls from 'hls.js';
import { codecTracks, compatibility, probeMedia } from './media-probe.js';

const diagnostic = (code, title, message, detail = '') => ({ code, title, message, detail });

export function playbackError({ hls, media, request, unsupported = false } = {}) {
  const status = Number(hls?.response?.code || request?.status || 0);
  const detail = hls?.details || (media?.code ? `MediaError ${media.code}` : '');
  let upstream = request?.message || '';
  try {
    upstream ||= JSON.parse(hls?.response?.text || '').error || '';
  } catch {
    /* Not JSON. */
  }
  const context = [detail, status ? `HTTP ${status}` : '', upstream.slice(0, 200)]
    .filter(Boolean)
    .join(' · ');
  if (/过期|失效/.test(upstream))
    return diagnostic('expired', '播放地址已失效', '重新解析当前剧集以获取新的播放地址。', context);
  if ([401, 403].includes(status) || /HTTP (401|403)\b/.test(upstream))
    return diagnostic(
      'access',
      '媒体访问被拒绝',
      '播放凭据可能已失效，或片源限制访问。请重新解析或切换线路。',
      context,
    );
  if (status === 404 || /HTTP 404\b/.test(upstream))
    return diagnostic(
      'missing',
      '视频资源不存在',
      '该线路的媒体文件可能已下架，请切换线路。',
      context,
    );
  if (/timeout/i.test(detail) || /超时/.test(upstream))
    return diagnostic('timeout', '媒体加载超时', '片源响应较慢，请重试或切换线路。', context);
  if (status >= 400 || hls?.type === 'networkError' || media?.code === 2 || request)
    return diagnostic(
      'network',
      '媒体加载失败',
      '无法读取视频或分片，请检查网络、重试或切换线路。',
      context,
    );
  if (unsupported || /incompatiblecodecs|addcodec/i.test(detail))
    return diagnostic(
      'codec',
      '当前浏览器不支持此编码',
      '请切换线路，或在支持该编码的浏览器、播放器中观看。',
      context,
    );
  if (hls?.type === 'keySystemError' || /decrypt/i.test(detail))
    return diagnostic(
      'encryption',
      '媒体解密失败',
      '该线路的加密方式或密钥不可用，请切换线路。',
      context,
    );
  if (/parsing|empty/i.test(detail))
    return diagnostic(
      'format',
      '媒体内容无法解析',
      '播放列表或视频分片可能无效，请重试或切换线路。',
      context,
    );
  if (media?.code === 3 || hls?.type === 'mediaError' || hls?.type === 'muxError')
    return diagnostic(
      'decode',
      '视频解码失败',
      '可能是编码不兼容或分片损坏，请切换线路或尝试其他浏览器。',
      context,
    );
  if (media?.code === 4)
    return diagnostic(
      'format',
      '浏览器无法识别此视频',
      '可能是格式不受支持，或片源返回了无效内容，请切换线路。',
      context,
    );
  return diagnostic('playback', '暂时无法播放', '请重试、切换线路，或打开来源页面。', context);
}

export function startPlayback(
  video,
  source,
  { onError, onInfo, HlsClass = Hls, scope = globalThis, fetcher } = {},
) {
  const controller = new AbortController();
  let disposed = false;
  let fatal = false;
  let hlsFatal = false;
  let hls;
  let probeTimer;
  let requestError;
  let info = { mode: 'native', status: 'unknown', codecs: [], mime: '' };
  const publish = (next) => {
    if (disposed) return;
    info = { ...info, ...next, ...(info.status === 'playable' && { status: 'playable' }) };
    onInfo(info);
  };
  const fail = (error) => {
    if (disposed || fatal) return;
    fatal = true;
    onError(error);
  };
  const inspect = (media) =>
    publish({
      mime: media.mime || info.mime,
      ...compatibility(media, video, info.mode, scope),
    });
  const playable = () => {
    publish({ status: 'playable' });
  };
  const playing = () => {
    fatal = false;
    hlsFatal = false;
    onError(null);
    playable();
  };
  let probe = Promise.resolve();
  const nativeFailure = () => {
    const error = video.error;
    if (!error || error.code === 1) return; // Switching/unmounting intentionally aborts playback.
    const report = () =>
      playbackError({
        media: error,
        request: [2, 4].includes(error.code) && requestError?.status ? requestError : undefined,
        unsupported: info.status === 'unsupported',
      });
    // Give hls.js its synchronous error event first; preserve its more precise diagnosis.
    queueMicrotask(() => {
      if (disposed || fatal) return;
      fail(report());
      probe.then(() => {
        if (!disposed && fatal && !hlsFatal && video.error === error) onError(report());
      });
    });
  };
  video.addEventListener('error', nativeFailure);
  video.addEventListener('canplay', playable);
  video.addEventListener('playing', playing);
  // A native HLS capability hint does not guarantee the stream can be demuxed.
  // For example, DM84 serves TS with a PNG prefix that some native players reject,
  // while hls.js finds the TS packets and transmuxes them for MediaSource.
  if (source.type === 'hls' && HlsClass.isSupported()) {
    info.mode = 'mse';
    publish({});
    hls = new HlsClass();
    hls.on(HlsClass.Events.MANIFEST_LOADED, (_, data) => {
      inspect({
        variants: data.levels.map((level) =>
          codecTracks([level.videoCodec, level.audioCodec].filter(Boolean).join(',')),
        ),
      });
    });
    hls.on(HlsClass.Events.BUFFER_CODECS, (_, data) => {
      inspect({
        tracks: Object.values(data.tracks)
          .filter((track) => track.codec || track.levelCodec)
          .map((track) => ({
            codec: track.codec || track.levelCodec,
            mime: track.container,
            exact: true,
          })),
      });
    });
    hls.on(HlsClass.Events.ERROR, (_, data) => {
      if (data.fatal && !disposed) {
        hlsFatal = true;
        fatal = true;
        onError(playbackError({ hls: data, unsupported: info.status === 'unsupported' }));
      }
    });
    hls.loadSource(source.url);
    hls.attachMedia(video);
  } else if (source.type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
    fail(diagnostic('hls', '当前浏览器无法播放 HLS', '请更新浏览器或使用支持 HLS 的浏览器观看。'));
  } else {
    publish({});
    // Inspect a bounded prefix in parallel; playback does not wait for this advisory check.
    probeTimer = setTimeout(() => controller.abort(), 12000);
    probe = probeMedia(source, controller.signal, fetcher)
      .then((media) => {
        inspect(media);
      })
      .catch((error) => {
        if (disposed) return;
        requestError = error;
        // A failed optional probe is not proof that the independent media request failed.
        publish({ probeFailed: true });
      })
      .finally(() => clearTimeout(probeTimer));
    video.src = source.url;
  }
  return () => {
    disposed = true;
    clearTimeout(probeTimer);
    controller.abort();
    video.removeEventListener('error', nativeFailure);
    video.removeEventListener('canplay', playable);
    video.removeEventListener('playing', playing);
    hls?.destroy();
  };
}
