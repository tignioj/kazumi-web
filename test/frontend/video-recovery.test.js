import test from 'node:test';
import assert from 'node:assert/strict';
import { attachVideoRecovery } from '../../src/features/player/video-recovery.js';

class Video extends EventTarget {
  currentTime = 120;
  duration = 1400;
  playbackRate = 1.5;
  paused = false;
  seeking = false;
  readyState = 2;
  loads = 0;
  load() {
    this.loads++;
    this.currentTime = 0;
    this.paused = true;
    this.readyState = 0;
    this.seeking = false;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  metadata() {
    this.readyState = 1;
    this.dispatchEvent(new Event('loadedmetadata'));
    this.seeking = true;
    this.dispatchEvent(new Event('seeking'));
  }
}

function fixture(t, options) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const video = new Video();
  t.after(attachVideoRecovery(video, options).stop);
  return video;
}

test('stalled playback reloads at the same position, rate and playing state', (t) => {
  const video = fixture(t);
  t.mock.timers.tick(14999);
  assert.equal(video.loads, 0);
  t.mock.timers.tick(1);
  assert.equal(video.loads, 1);
  video.metadata();
  assert.equal(video.currentTime, 120);
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.paused, false);
  video.seeking = false;
  video.readyState = 4;
  video.currentTime = 123;
  t.mock.timers.tick(20000);
  assert.equal(video.loads, 1);
});

test('long pauses stay idle, while a stalled paused seek preserves the latest target', (t) => {
  const video = fixture(t);
  video.paused = true;
  t.mock.timers.tick(180000);
  assert.equal(video.loads, 0);
  video.seeking = true;
  video.currentTime = 600;
  video.dispatchEvent(new Event('seeking'));
  t.mock.timers.tick(10000);
  video.currentTime = 240;
  video.dispatchEvent(new Event('seeking'));
  t.mock.timers.tick(14999);
  assert.equal(video.loads, 0);
  t.mock.timers.tick(1);
  video.metadata();
  assert.equal(video.currentTime, 240);
  assert.equal(video.paused, true);
});

test('failed metadata or seek recovery retries twice without losing its target', (t) => {
  const errors = [];
  const video = fixture(t, { onError: (message) => errors.push(message) });
  t.mock.timers.tick(15000);
  video.metadata();
  t.mock.timers.tick(15000);
  assert.equal(video.loads, 2);
  t.mock.timers.tick(60000);
  assert.equal(video.loads, 2);
  assert.equal(errors.length, 1);
  video.currentTime = 300;
  video.seeking = true;
  video.dispatchEvent(new Event('seeking'));
  t.mock.timers.tick(15000);
  assert.equal(video.loads, 3);
  video.metadata();
  assert.equal(video.currentTime, 300);
});

test('destroying the player cancels retries and metadata restoration', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const video = new Video();
  const { stop } = attachVideoRecovery(video);
  t.mock.timers.tick(15000);
  stop();
  video.metadata();
  assert.equal(video.currentTime, 0);
  t.mock.timers.tick(60000);
  assert.equal(video.loads, 1);
});

test('pausing during reconnection overrides the original playing intent', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const video = new Video();
  const recovery = attachVideoRecovery(video);
  t.after(recovery.stop);
  t.mock.timers.tick(15000);
  recovery.setPlaying(false);
  video.metadata();
  assert.equal(video.currentTime, 120);
  assert.equal(video.paused, true);
  video.seeking = false;
  video.readyState = 2;
  t.mock.timers.tick(60000);
  assert.equal(video.loads, 1);
});
