import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPlaybackDiagnostics,
  createPlayerDiagnostics,
  MAX_PLAYER_LOGS,
  readPlaybackMetrics,
  sanitizeDiagnosticText,
} from '../../src/features/player/player-diagnostics.js';

class Video extends EventTarget {
  currentTime = 15;
  duration = 90;
  videoWidth = 1920;
  videoHeight = 1080;
  playbackRate = 1.5;
  readyState = 4;
  networkState = 2;
  paused = false;
  buffered = {
    length: 2,
    start: (index) => [0, 40][index],
    end: (index) => [20, 60][index],
  };
  getVideoPlaybackQuality() {
    return { droppedVideoFrames: 2, totalVideoFrames: 240 };
  }
}

test('buffer metrics measure only the contiguous range containing the playhead', () => {
  const video = new Video();
  assert.equal(readPlaybackMetrics(video).bufferedAhead, 5);
  video.currentTime = 30;
  assert.equal(readPlaybackMetrics(video).bufferedAhead, 0);
  video.currentTime = 45;
  assert.equal(readPlaybackMetrics(video).bufferedAhead, 15);
  assert.equal(readPlaybackMetrics(video).droppedFrames, 2);
});

test('unknown duration and unsupported quality metrics remain distinguishable from zero', () => {
  const video = new Video();
  video.duration = Infinity;
  video.getVideoPlaybackQuality = undefined;
  const metrics = readPlaybackMetrics(video);
  assert.equal(metrics.duration, null);
  assert.equal(metrics.live, true);
  assert.equal(metrics.totalFrames, null);
  assert.doesNotThrow(() => JSON.stringify(metrics));
});

test('diagnostics redact credentials, signed proxy payloads, query parameters and fragments', () => {
  const text = sanitizeDiagnosticText(
    'HTTP https://user:secret@cdn.example/video.mp4?token=private#secret /api/media?payload=private&signature=signed',
  );
  assert.equal(text, 'HTTP https://cdn.example/video.mp4?[已隐藏参数] /api/media?[已隐藏参数]');
  for (const privateValue of ['user', 'secret', 'private', 'signed'])
    assert.ok(!text.includes(privateValue));
});

test('log retention stays bounded and subscribers detach without clearing metrics', () => {
  const diagnostics = createPlayerDiagnostics();
  let updates = 0;
  const unsubscribe = diagnostics.subscribe(() => updates++);
  diagnostics.update({ resolveMs: 120 });
  const previous = diagnostics.getSnapshot();
  for (let index = 0; index < MAX_PLAYER_LOGS + 5; index++)
    diagnostics.log('info', 'HLS', `分片 ${index}`);
  const { logs } = diagnostics.getSnapshot();
  assert.equal(previous.logs.length, 0);
  assert.equal(logs.length, MAX_PLAYER_LOGS);
  assert.equal(logs[0].message, '分片 5');
  assert.ok(logs.at(-1).id > logs[0].id);
  assert.equal(updates, MAX_PLAYER_LOGS + 6);
  unsubscribe();
  diagnostics.clear();
  assert.equal(updates, MAX_PLAYER_LOGS + 6);
  assert.equal(diagnostics.getSnapshot().metrics.resolveMs, 120);
  assert.equal(diagnostics.getSnapshot().logs.length, 0);
});

test('resolution diagnostics retain server timestamps and redact source URLs', () => {
  const diagnostics = createPlayerDiagnostics();
  diagnostics.log(
    'info',
    '规则匹配',
    'https://user:secret@cdn.example/movie.mp4?token=private',
    1234,
    'resolve',
  );
  const [entry] = diagnostics.getSnapshot().logs;
  assert.equal(entry.time, 1234);
  assert.equal(entry.phase, 'resolve');
  assert.equal(entry.message, 'https://cdn.example/movie.mp4?[已隐藏参数]');
});

test('playback events report errors and paused seeks accurately and stop sampling after teardown', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const video = new Video();
  const events = [];
  const stop = attachPlaybackDiagnostics(video, (event) => events.push(event));
  t.after(stop);
  video.dispatchEvent(new Event('waiting'));
  assert.equal(events.at(-1).level, 'warn');
  assert.equal(events.at(-1).metrics.status, '正在缓冲');
  video.paused = true;
  video.dispatchEvent(new Event('seeked'));
  assert.equal(events.at(-1).metrics.status, '已暂停');
  video.error = { code: 2, message: 'Failed https://cdn.example/video?token=secret' };
  video.dispatchEvent(new Event('error'));
  assert.equal(events.at(-1).level, 'error');
  assert.match(events.at(-1).message, /code=2/);
  const diagnostics = createPlayerDiagnostics();
  const error = events.at(-1);
  diagnostics.log(error.level, error.scope, error.message);
  assert.ok(!diagnostics.getSnapshot().logs[0].message.includes('secret'));
  video.dispatchEvent(new Event('pause'));
  assert.equal(events.at(-1).metrics.status, '播放错误');
  const beforeTick = events.length;
  t.mock.timers.tick(1000);
  assert.equal(events.length, beforeTick + 1);
  stop();
  const beforeStop = events.length;
  video.dispatchEvent(new Event('playing'));
  t.mock.timers.tick(5000);
  assert.equal(events.length, beforeStop);
});
