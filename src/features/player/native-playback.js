function event(target, name, signal, operation) {
  return new Promise((resolve, reject) => {
    const clear = () => {
      target.removeEventListener(name, ready);
      target.removeEventListener('error', failed);
      signal.removeEventListener('abort', failed);
    };
    const ready = () => {
      clear();
      resolve();
    };
    const failed = () => {
      clear();
      reject(signal.reason || new Error('视频缓冲失败'));
    };
    target.addEventListener(name, ready, { once: true });
    target.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted) failed();
    else {
      try {
        operation?.();
      } catch (error) {
        clear();
        reject(error);
      }
    }
  });
}

async function response(url, signal) {
  const result = await fetch(url, { signal });
  if (!result.ok) {
    const data = await result.json().catch(() => ({}));
    throw new Error(data.error || `视频请求失败：HTTP ${result.status}`);
  }
  return result;
}

// MSE transport for the native FFmpeg output. Ad detection stays upstream.
export function attachNativePlayback(video, source, { resume = 0, onError, onDebug } = {}) {
  const lifetime = new AbortController();
  const MediaSourceClass = window.MediaSource || window.ManagedMediaSource;
  if (!MediaSourceClass) {
    onError?.('当前浏览器不支持原生过滤视频流，请使用支持 MediaSource 的浏览器。');
    return () => {};
  }
  const media = new MediaSourceClass();
  const objectUrl = URL.createObjectURL(media);
  const opened = event(media, 'sourceopen', lifetime.signal);
  video.disableRemotePlayback = true;
  video.src = objectUrl;
  let buffer,
    duration,
    parserFactory,
    stream,
    task,
    pendingStart,
    stopped = false;
  const endpoint = (action, start) =>
    `/api/native-media/${action}?${new URLSearchParams({
      source,
      ...(start !== undefined && { start: String(start) }),
    })}`;
  const contains = (time) => {
    for (let i = 0; i < video.buffered.length; i++)
      if (time >= video.buffered.start(i) && time < video.buffered.end(i) - 0.05) return true;
    return false;
  };
  async function update(operation, signal) {
    signal.throwIfAborted();
    await event(buffer, 'updateend', signal, operation);
  }
  async function pump(start, signal) {
    const result = await response(endpoint('stream', start), signal);
    const reader = result.body.getReader();
    const parser = parserFactory();
    let mime,
      offset = 0,
      initialized = false;
    const pending = [];
    parser.onReady = (info) => {
      mime = `video/mp4; codecs="${info.tracks
        .filter((track) => track.video || track.audio)
        .map((track) => track.codec)
        .join(',')}"`;
    };
    parser.onError = () => {
      throw new Error('来源返回的 MP4 初始化信息无效');
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (!initialized) {
          pending.push(value);
          const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          bytes.fileStart = offset;
          offset += bytes.byteLength;
          parser.appendBuffer(bytes);
          if (!mime) {
            if (offset > 2 * 1024 * 1024) throw new Error('视频初始化信息过大');
            continue;
          }
          if (!MediaSourceClass.isTypeSupported(mime))
            throw new Error('当前浏览器不支持此视频的编码，请切换线路。');
          onDebug?.({
            level: 'info',
            scope: '原生流',
            message: `已识别编码 · ${mime}`,
            metrics: { codecs: mime },
          });
          if (!buffer) buffer = media.addSourceBuffer(mime);
          else if (buffer.changeType) buffer.changeType(mime);
          buffer.timestampOffset = 0;
          media.duration = duration;
          if (start > 0) video.currentTime = start;
          initialized = true;
          for (const bytes of pending) await update(() => buffer.appendBuffer(bytes), signal);
          pending.length = 0;
        } else await update(() => buffer.appendBuffer(value), signal);
        if (contains(start)) pendingStart = undefined;
        // Let browser consumption back-pressure FFmpeg instead of reading an
        // entire episode. Seeking aborts this wait and starts a native seek.
        while (
          buffer.buffered.length &&
          buffer.buffered.end(buffer.buffered.length - 1) - video.currentTime > 60
        ) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(done, 500);
            function done() {
              signal.removeEventListener('abort', cancel);
              resolve();
            }
            function cancel() {
              clearTimeout(timer);
              reject(signal.reason);
            }
            signal.addEventListener('abort', cancel, { once: true });
          });
        }
        if (
          buffer.buffered.length &&
          video.currentTime > 40 &&
          buffer.buffered.start(0) < video.currentTime - 40
        )
          await update(() => buffer.remove(0, video.currentTime - 30), signal);
      }
      if (!initialized) throw new Error('来源没有返回可播放的视频');
      if (media.readyState === 'open') media.endOfStream();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  function restart(start) {
    onDebug?.({
      level: 'info',
      scope: '原生流',
      message: `请求视频流 · 起点 ${start.toFixed(1)} 秒`,
    });
    pendingStart = start;
    stream?.abort();
    const previous = task;
    stream = new AbortController();
    const signal = stream.signal;
    task = (async () => {
      await previous?.catch(() => {});
      signal.throwIfAborted();
      if (buffer) {
        if (media.readyState === 'open') buffer.abort();
        if (buffer.buffered.length) await update(() => buffer.remove(0, duration + 1), signal);
      }
      await pump(start, signal);
    })().catch((error) => {
      if (!signal.aborted && !stopped) onError?.(error.message || '原生视频播放失败');
    });
  }
  const seek = () => {
    if (
      duration &&
      (pendingStart === undefined || Math.abs(video.currentTime - pendingStart) >= 0.15) &&
      !contains(video.currentTime)
    )
      restart(video.currentTime);
  };
  video.addEventListener('seeking', seek);
  (async () => {
    const [info, library] = await Promise.all([
      response(endpoint('info'), lifetime.signal).then((result) => result.json()),
      import('mp4box'),
      opened,
    ]);
    lifetime.signal.throwIfAborted();
    duration = info.duration;
    onDebug?.({
      level: 'info',
      scope: '原生流',
      message: `媒体信息已就绪 · 时长 ${duration.toFixed(1)} 秒`,
    });
    parserFactory = library.createFile;
    restart(Math.max(0, Math.min(resume, duration - 0.1)));
  })().catch((error) => {
    if (!lifetime.signal.aborted) onError?.(error.message || '原生播放器初始化失败');
  });
  return () => {
    stopped = true;
    lifetime.abort();
    stream?.abort();
    video.removeEventListener('seeking', seek);
    URL.revokeObjectURL(objectUrl);
  };
}
