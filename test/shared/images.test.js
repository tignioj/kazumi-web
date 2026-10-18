import test from 'node:test';
import assert from 'node:assert/strict';
import { bangumiImageUrl, bangumiImageMirrorUrl, imageSource } from '../../shared/images.js';

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

test('wsrv mirrors only Bangumi images and preserves paths, queries and animated GIFs', () => {
  assert.equal(
    bangumiImageMirrorUrl('https://lain.bgm.tv/pic/cover/l/cover.jpg'),
    'https://wsrv.nl/?url=lain.bgm.tv%2Fpic%2Fcover%2Fl%2Fcover.jpg',
  );
  assert.equal(
    bangumiImageMirrorUrl('http://lain.bgm.tv/pic/animated.GIF#fragment'),
    'https://wsrv.nl/?url=lain.bgm.tv%2Fpic%2Fanimated.GIF&n=-1',
  );
  for (const kind of ['subjects', 'characters', 'persons']) {
    const mirror = new URL(
      bangumiImageMirrorUrl(`https://api.bgm.tv/v0/${kind}/253/image?type=large`),
    );
    assert.equal(mirror.searchParams.get('url'), `api.bgm.tv/v0/${kind}/253/image?type=large`);
  }
  for (const url of [
    'https://wsrv.nl/?url=localhost',
    'https://lain.bgm.tv.evil/image.jpg',
    'https://user:pass@lain.bgm.tv/image.jpg',
    'https://example.com/image.jpg',
    'https://api.bgm.tv/v0/subjects/253',
  ])
    assert.equal(bangumiImageMirrorUrl(url), null);
});
