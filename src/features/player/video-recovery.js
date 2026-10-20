// Browsers can leave a ranged MP4 request stalled after an idle connection or
// an aborted seek. Reload the transport, keeping the user's position and intent.
export function attachVideoRecovery(video, { onRecover, onError } = {}) {
  const timeout = 15000;
  let lastTime = video.currentTime;
  let lastProgress = Date.now();
  let attempts = 0;
  let pending;
  let failed = false;

  const resetClock = () => {
    lastTime = video.currentTime;
    lastProgress = Date.now();
  };
  const seek = () => {
    if (!pending || Math.abs(video.currentTime - pending.time) > 0.15) {
      pending = undefined;
      attempts = 0;
      failed = false;
    }
    resetClock();
  };
  const metadata = () => {
    if (!pending || pending.restored) return;
    pending.restored = true;
    video.currentTime = Math.min(pending.time, Math.max(0, video.duration - 0.1));
    video.playbackRate = pending.rate;
    if (pending.playing) video.play().catch(() => {});
    resetClock();
  };
  const timer = setInterval(() => {
    if (video.error || video.ended || failed) return;
    if (pending?.restored && !video.seeking && video.readyState >= (video.paused ? 2 : 3))
      pending = undefined;
    if (
      !pending &&
      ((!video.seeking && video.paused) || (!video.seeking && video.currentTime > lastTime + 0.05))
    ) {
      if (!video.paused) attempts = 0;
      resetClock();
      return;
    }
    if (!pending && !video.seeking && video.readyState >= 3) {
      resetClock();
      return;
    }
    if (Date.now() - lastProgress < timeout) return;
    if (attempts >= 2) {
      failed = true;
      onError?.('视频缓冲超时，请重新解析或切换线路。');
      return;
    }
    pending = {
      time: pending?.time ?? video.currentTime,
      playing: pending?.playing ?? !video.paused,
      rate: pending?.rate ?? video.playbackRate,
    };
    attempts++;
    resetClock();
    onRecover?.();
    video.load();
  }, 1000);
  video.addEventListener('seeking', seek);
  video.addEventListener('loadedmetadata', metadata);
  return {
    setPlaying(playing) {
      if (pending) pending.playing = playing;
    },
    stop() {
      clearInterval(timer);
      video.removeEventListener('seeking', seek);
      video.removeEventListener('loadedmetadata', metadata);
    },
  };
}
