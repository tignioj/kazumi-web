import test from 'node:test';
import assert from 'node:assert/strict';
import { bangumiImageUrl, imageSource } from '../../shared/images.js';

test('all Bangumi image URL forms use the same-origin endpoint, with no open proxy', () => {
  assert.equal(
    bangumiImageUrl('http://lain.bgm.tv/pic/a.jpg#fragment'),
    'https://lain.bgm.tv/pic/a.jpg',
  );
  assert.match(imageSource('//lain.bgm.tv/pic/a.jpg'), /^\/api\/image\?url=https%3A/);
  assert.match(
    imageSource('https://api.bgm.tv/v0/characters/7/image?type=large'),
    /^\/api\/image\?/,
  );
  for (const url of [
    'https://example.com/a.png',
    'http://localhost/a',
    'https://lain.bgm.tv.evil/a',
    'https://api.bgm.tv/v0/subjects/7',
    'https://user:pass@lain.bgm.tv/a',
    'https://lain.bgm.tv:8080/a',
    'data:image/png;base64,abc',
    '/api/image?url=already',
  ]) {
    assert.equal(bangumiImageUrl(url), null);
    assert.equal(imageSource(url), url);
  }
});
