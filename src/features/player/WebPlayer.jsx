import React, { useEffect, useRef } from 'react';
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { attachNativePlayback } from './native-playback.js';
import { attachVideoRecovery } from './video-recovery.js';
import { attachPlaybackDiagnostics } from './player-diagnostics.js';

// ArtPlayer owns controls; transport adapters handle stream loading and recovery.
export function WebPlayer({ source, resume = 0, autoplay, onProgress, onEnded, onError, onDebug }) {
  const container = useRef(null);
  const callbacks = useRef({ onEnded, onError, onDebug });
  callbacks.current = { onEnded, onError, onDebug };
  useEffect(() => {
    let lastSave = 0;
    let disposed = false;
    const report = (event) => {
      if (!disposed) callbacks.current.onDebug?.(event);
    };
    const fail = (message, scope = '播放器') => {
      if (disposed) return;
      report({ level: 'error', scope, message, metrics: { status: '播放错误' } });
      callbacks.current.onError?.(message);
    };
    report({
      level: 'info',
      scope: '播放器',
      message: `初始化 ArtPlayer · hls.js ${Hls.version}`,
      metrics: { engine: 'HTMLVideoElement' },
    });
    const art = new Artplayer({
      container: container.current,
      url: source.url,
      type: source.type === 'hls' ? 'm3u8' : 'mp4',
      lang: 'zh-cn',
      theme: '#b9533b',
      autoplay: !!autoplay,
      playbackRate: true,
      setting: true,
      fullscreen: true,
      fullscreenWeb: true,
      pip: true,
      hotkey: true,
      playsInline: true,
      customType: {
        m3u8(video, url, player) {
          if (source.nativePlayback) {
            report({
              level: 'info',
              scope: '原生流',
              message: '使用服务端原生过滤流与 MediaSource 播放',
              metrics: { engine: '原生过滤流 / MSE' },
            });
            const stop = attachNativePlayback(video, url, {
              resume,
              onError: (message) => fail(message, '原生流'),
              onDebug: report,
            });
            player.on('destroy', stop);
          } else if (Hls.isSupported()) {
            const hls = new Hls();
            let fragments = 0;
            report({
              level: 'info',
              scope: 'HLS',
              message: `使用 hls.js ${Hls.version}`,
              metrics: { engine: 'hls.js / MSE', fragments: 0 },
            });
            hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
              report({
                level: 'info',
                scope: 'HLS',
                message: `播放列表已解析 · ${data.levels.length} 个清晰度`,
              });
            });
            hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
              const level = hls.levels[data.level];
              if (!level) return;
              report({
                level: 'info',
                scope: 'HLS',
                message: `切换清晰度 · level ${data.level}${level.height ? ` · ${level.height}p` : ''}`,
                metrics: {
                  bitrate: level.bitrate,
                  ...((level.videoCodec || level.audioCodec) && {
                    codecs: [level.videoCodec, level.audioCodec].filter(Boolean).join(' / '),
                  }),
                },
              });
            });
            hls.on(Hls.Events.BUFFER_CODECS, (_event, data) => {
              const codecs = [data.video, data.audio, data.audiovideo]
                .map((track) => track?.codec || track?.levelCodec)
                .filter(Boolean)
                .join(' / ');
              if (codecs)
                report({
                  level: 'info',
                  scope: 'HLS',
                  message: `已识别编码 · ${codecs}`,
                  metrics: { codecs },
                });
            });
            hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
              fragments++;
              report({
                level: 'info',
                scope: 'HLS',
                message: `分片 ${data.frag.sn} 加载完成${Number.isFinite(data.frag.duration) ? ` · ${data.frag.duration.toFixed(1)} 秒` : ''}`,
                metrics: { fragments, bandwidth: hls.bandwidthEstimate },
              });
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
              const details = `${data.type} · ${data.details}${data.response?.code ? ` · HTTP ${data.response.code}` : ''}`;
              if (data.fatal) fail(`视频加载失败：${details}，可重新解析或切换线路。`, 'HLS');
              else
                report({
                  level: 'warn',
                  scope: 'HLS',
                  message: details,
                });
            });
            player.on('destroy', () => hls.destroy());
            hls.loadSource(url);
            hls.attachMedia(video);
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            report({
              level: 'info',
              scope: 'HLS',
              message: '使用浏览器原生 HLS 播放',
              metrics: { engine: '浏览器原生 HLS' },
            });
            video.src = url;
          } else fail('当前浏览器不支持 HLS 播放，请换用其他浏览器。', 'HLS');
        },
      },
    });
    const stopDiagnostics = attachPlaybackDiagnostics(art.video, report);
    const recovery =
      source.type === 'video'
        ? attachVideoRecovery(art.video, {
            onRecover: () => {
              report({
                level: 'warn',
                scope: '恢复',
                message: `连接停滞，重新加载视频并恢复至 ${art.currentTime.toFixed(1)} 秒`,
                metrics: { status: '正在恢复' },
              });
              art.notice.show = '连接停滞，正在恢复播放…';
            },
            onError: (message) => fail(message, '恢复'),
          })
        : undefined;
    if (recovery) {
      art.on('pause', () => recovery.setPlaying(false));
      art.on('play', () => recovery.setPlaying(true));
    }
    const save = () => {
      if (art.video.readyState > 0) onProgress?.(art.currentTime, art.duration);
    };
    art.once('video:loadedmetadata', () => {
      if (resume > 0 && Number.isFinite(art.duration)) {
        art.currentTime = Math.min(resume, Math.max(0, art.duration - 1));
        report({
          level: 'info',
          scope: '进度',
          message: `恢复观看进度至 ${art.currentTime.toFixed(1)} 秒`,
        });
      }
    });
    art.on('video:timeupdate', () => {
      if (Date.now() - lastSave > 5000) {
        lastSave = Date.now();
        save();
      }
    });
    art.on('video:pause', save);
    art.on('video:ended', () => {
      save();
      callbacks.current.onEnded?.();
    });
    art.on('video:error', () =>
      callbacks.current.onError?.('视频加载失败，请重新解析或切换线路。'),
    );
    window.addEventListener('pagehide', save);
    return () => {
      save();
      disposed = true;
      stopDiagnostics();
      recovery?.stop();
      window.removeEventListener('pagehide', save);
      art.destroy(false);
    };
  }, [source.url, source.type, source.nativePlayback]);
  return <div className="web-player" ref={container} aria-label="ArtPlayer 视频播放器" />;
}
