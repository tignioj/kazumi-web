import React, { useEffect, useRef } from 'react';
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { attachNativePlayback } from './native-playback.js';

// Only application events are adapted here. ArtPlayer owns controls and playback.
export function WebPlayer({ source, resume = 0, autoplay, onProgress, onEnded, onError }) {
  const container = useRef(null);
  const callbacks = useRef({ onEnded, onError });
  callbacks.current = { onEnded, onError };
  useEffect(() => {
    let lastSave = 0;
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
            const stop = attachNativePlayback(video, url, {
              resume,
              onError: (message) => callbacks.current.onError?.(message),
            });
            player.on('destroy', stop);
          } else if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal)
                callbacks.current.onError?.(
                  `视频加载失败：${data.details}，可重新解析或切换线路。`,
                );
            });
            player.on('destroy', () => hls.destroy());
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = url;
          else callbacks.current.onError?.('当前浏览器不支持 HLS 播放，请换用其他浏览器。');
        },
      },
    });
    const save = () => {
      if (art.video.readyState > 0) onProgress?.(art.currentTime, art.duration);
    };
    art.once('video:loadedmetadata', () => {
      if (resume > 0 && Number.isFinite(art.duration))
        art.currentTime = Math.min(resume, Math.max(0, art.duration - 1));
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
      window.removeEventListener('pagehide', save);
      art.destroy(false);
    };
  }, [source.url]);
  return <div className="web-player" ref={container} aria-label="ArtPlayer 视频播放器" />;
}
