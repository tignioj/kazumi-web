import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeOrigin } from './corpus.mjs';
import { HttpError } from '../../server/lib/http.js';

export const playbackCases = ['delayed-mp4', 'nested-hls', 'extensionless-video'];
export const captchaCases = [
  'captcha-image',
  'captcha-post',
  'captcha-button',
  'captcha-script',
  'captcha-header',
];
const isImageCaptcha = (id) => ['captcha-image', 'captcha-post', 'captcha-cancel'].includes(id);

export function browserRule(origin, id) {
  const base = `${origin}/browser/${id}`;
  return {
    api: '9',
    name: `Compatibility ${id}`,
    version: '1',
    baseURL: origin,
    searchURL: `${base}/search?wd=@keyword${id === 'captcha-post' ? '&tag=first&tag=last' : ''}`,
    usePost: id === 'captcha-post',
    searchList: '//article',
    searchName: '//a',
    searchResult: '//a',
    chapterRoads: '//ul',
    chapterResult: '//a',
    useWebview: true,
    useNativePlayer: true,
    useLegacyParser: false,
    ...(id.startsWith('captcha-')
      ? {
          antiCrawlerConfig: {
            enabled: true,
            captchaType: isImageCaptcha(id) ? 1 : id === 'captcha-button' ? 2 : 3,
            captchaDetectType: id === 'captcha-header' ? 2 : 1,
            captchaDetectValue:
              id === 'captcha-header' ? 'not present in this document' : '//div[@id="gate"]',
            captchaImage: '//img[@id="captcha"]',
            captchaInput: '//input[@name="answer"]',
            captchaButton: '//button[@id="verify"]',
            captchaScript:
              "fetch('./grant', {method:'POST'}).then(() => { document.querySelector('#gate')?.remove(); window.KazumiCaptcha.done(); });",
          },
        }
      : {}),
  };
}

export async function createBrowserFixture({ port = 17334 } = {}) {
  const mp4 = await readFile(new URL('../fixtures/media/sample.mp4', import.meta.url));
  const segment = await readFile(new URL('../fixtures/media/segment00.ts', import.meta.url));
  const requests = [];
  const grants = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const [, , id, phase] = url.pathname.split('/');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      requests.push({ id, phase, method: request.method, headers: request.headers, body });
      const html = (text, status = 200) =>
        response
          .writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          .end(`<!doctype html><html><body>${text}</body></html>`);
      const prefix = `/browser/${id}`;
      const results = `<article><a href="${prefix}/detail">Verified result</a></article>`;
      const cookieName = id?.replaceAll('-', '_');
      const cookie = request.headers.cookie
        ?.split('; ')
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      const verified = cookie && grants.get(cookie) === request.headers['user-agent'];
      if (phase === 'grant') {
        if (isImageCaptcha(id) && new URLSearchParams(body).get('answer') !== '2468')
          return html(`<p>Incorrect answer</p>${imageForm(prefix)}`);
        const token = randomUUID();
        grants.set(token, request.headers['user-agent']);
        response.setHeader(
          'set-cookie',
          `${cookieName}=${token}; Path=${prefix}/; HttpOnly; SameSite=Lax`,
        );
        if (id === 'captcha-script' || id === 'captcha-header')
          return response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return response.writeHead(303, { location: `${prefix}/search` }).end();
      }
      if (phase === 'image')
        return response
          .writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
          .end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="25">2468</text></svg>',
          );
      if (phase === 'search') {
        if (verified) return html(results);
        if (isImageCaptcha(id)) return html(imageForm(prefix));
        if (id === 'captcha-header') response.setHeader('cf-mitigated', 'challenge');
        return html(
          `<div id="gate"><form method="POST" action="${prefix}/grant"><button id="verify">Continue</button></form></div>`,
          id === 'captcha-header' ? 403 : 200,
        );
      }
      if (phase === 'detail' || phase === 'protected-detail') {
        if (phase === 'protected-detail' && !verified)
          return html('<div id="gate">Clearance or User-Agent missing</div>', 403);
        return html(`<ul><a href="${prefix}/watch">Episode 1</a></ul>`);
      }
      if (phase === 'watch') {
        if (id === 'cancel-playback') return html('<p>Player never creates media</p>');
        if (id === 'nested-hls')
          return html(
            `<script>setTimeout(() => { const f = document.createElement('iframe'); f.src = '${prefix}/frame'; document.body.append(f); }, 150);</script>`,
          );
        const media = `${url.origin}${prefix}/${id === 'extensionless-video' ? 'stream' : 'media.mp4'}?signature=a%2Fb%2B`;
        return html(
          `<script>setTimeout(() => { const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.controls = true; v.src = ${JSON.stringify(media)}; document.body.append(v); v.play().catch(() => {}); }, 250);</script>`,
        );
      }
      if (phase === 'frame')
        return html(
          `<script>setTimeout(() => fetch('${prefix}/media.m3u8?signature=a%2Fb%2B').then(r => r.text()), 200);</script>`,
        );
      if (phase === 'media.m3u8')
        return response
          .writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
          .end('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST\n');
      if (phase === 'segment.ts')
        return response.writeHead(200, { 'content-type': 'video/mp2t' }).end(segment);
      if (phase === 'media.mp4' || phase === 'stream') {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
        const start = Number(range?.[1] || 0);
        const end = Math.min(Number(range?.[2] || mp4.length - 1), mp4.length - 1);
        if (start > end) return response.writeHead(416).end();
        return response
          .writeHead(range ? 206 : 200, {
            'content-type': 'video/mp4',
            'accept-ranges': 'bytes',
            'content-length': end - start + 1,
            ...(range ? { 'content-range': `bytes ${start}-${end}/${mp4.length}` } : {}),
          })
          .end(mp4.subarray(start, end + 1));
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  return {
    requests,
    origin: `http://127.0.0.1:${server.address().port}`,
    mp4,
    segment,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function imageForm(prefix) {
  return `<div id="gate"><form method="POST" action="${prefix}/grant"><img id="captcha" src="${prefix}/image"><input name="answer"><button id="verify" type="submit">Verify</button></form></div>`;
}

async function until(action, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  do {
    if (await action()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}

async function solve(challenge, id, fixture) {
  if (challenge.page) {
    assert.ok(isImageCaptcha(id), 'Automatic local verification should run without manual input');
    await challenge.page.locator('input[name="answer"]').fill('wrong');
    await challenge.page.locator('#verify').click();
    await challenge.page.getByText('Incorrect answer').waitFor();
    await challenge.page.locator('input[name="answer"]').fill('2468');
    await challenge.page.locator('#verify').click();
    await challenge.page.locator('article').waitFor();
    return;
  }
  if (isImageCaptcha(id)) {
    await until(async () => {
      const snapshot = await challenge.snapshot();
      assert.notEqual(snapshot.status, 'failed', snapshot.error);
      return snapshot.image?.startsWith('data:image/');
    }, 'official captcha image');
    const images = () => fixture.requests.filter((r) => r.id === id && r.phase === 'image').length;
    const count = images();
    await challenge.action({ type: 'answer', text: 'wrong' });
    await until(() => images() > count, 'incorrect answer reload');
    assert.equal(
      (await challenge.snapshot()).status,
      'waiting',
      'Wrong answers must not grant clearance',
    );
    await challenge.action({ type: 'answer', text: '2468' });
  }
  await until(async () => {
    const snapshot = await challenge.snapshot();
    assert.notEqual(snapshot.status, 'failed', snapshot.error);
    return snapshot.status === 'completed';
  }, `official ${id} completion`);
}

export async function runBrowserCases({
  engine,
  origin,
  fixture,
  official = false,
  onResult = () => {},
}) {
  const results = [];
  const record = (id, result) => {
    const entry = { id, ...normalizeOrigin(result, origin) };
    results.push(entry);
    onResult(entry);
  };
  for (const id of playbackCases) {
    const rule = browserRule(origin, id);
    const result = await engine.resolve(rule, `${origin}/browser/${id}/watch`);
    const hls = id === 'nested-hls';
    const expectedUrl = `${origin}/browser/${id}/${hls ? 'media.m3u8' : id === 'extensionless-video' ? 'stream' : 'media.mp4'}?signature=a%2Fb%2B`;
    assert.equal(result.url, expectedUrl, id);
    assert.equal(result.type, hls ? 'hls' : 'video', id);
    const mediaUrl = result.url.replace(origin, fixture.origin);
    const media = await fetch(mediaUrl, {
      headers: { ...result.headers, range: 'bytes=0-63' },
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(media.ok);
    const bytes = Buffer.from(await media.arrayBuffer());
    if (hls) {
      assert.match(bytes.toString(), /^#EXTM3U/);
      const child = await fetch(new URL('segment.ts', mediaUrl), {
        signal: AbortSignal.timeout(5000),
      });
      assert.ok(child.ok);
      assert.deepEqual(Buffer.from(await child.arrayBuffer()), fixture.segment);
    } else assert.deepEqual(bytes, fixture.mp4.subarray(0, 64));
    record(id, {
      url: result.url,
      type: result.type,
      bytes: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  for (const id of captchaCases) {
    const rule = browserRule(origin, id);
    const sessionOwner = `compat-${randomUUID()}`;
    const options = { sessionOwner, onVerification: (challenge) => solve(challenge, id, fixture) };
    const before = fixture.requests.length;
    const keyword = 'fixture & /中';
    const items = await engine.search(rule, keyword, options);
    assert.deepEqual(items, [{ name: 'Verified result', url: `${origin}/browser/${id}/detail` }]);
    const reused = await engine.search(rule, 'again', {
      sessionOwner,
      onVerification() {
        assert.fail('Clearance cookie and browser User-Agent must be reused');
      },
    });
    assert.deepEqual(reused, items);
    if (id === 'captcha-post') {
      const posts = fixture.requests
        .slice(before)
        .filter((r) => r.id === id && r.phase === 'search' && r.method === 'POST');
      assert.ok(posts.length >= 2, 'Verification must replay the original POST search');
      assert.equal(new URLSearchParams(posts[0].body).get('wd'), keyword);
      assert.equal(new URLSearchParams(posts[1].body).get('wd'), keyword);
      assert.deepEqual(new URLSearchParams(posts[1].body).getAll('tag'), ['last']);
    }
    const roads = await engine.chapters(rule, items[0].url, { sessionOwner });
    assert.deepEqual(roads, [
      { name: '播放线路1', episodes: [{ name: 'Episode1', url: `${origin}/browser/${id}/watch` }] },
    ]);
    // Official XPath chapters deliberately omit cookies. Assert Web's extra
    // clearance support separately instead of weakening it to match that limit.
    if (!official)
      assert.deepEqual(
        await engine.chapters(rule, `${origin}/browser/${id}/protected-detail`, { sessionOwner }),
        roads,
      );
    if (isImageCaptcha(id))
      await assert.rejects(
        engine.search(rule, 'other owner', { sessionOwner: `other-${sessionOwner}` }),
        { code: official ? 'CAPTCHA_REQUIRED' : 'VERIFICATION_REQUIRED' },
      );
    record(id, {
      items,
      roads,
      clearanceReused: true,
      ...(isImageCaptcha(id) ? { wrongAnswerRejected: true, ownerIsolated: true } : {}),
      ...(id === 'captcha-post' ? { postReplayed: true } : {}),
    });
  }
  const cancelledRule = browserRule(origin, 'captcha-cancel');
  const sessionOwner = `cancel-${randomUUID()}`;
  let cancelledChallenge;
  await assert.rejects(
    engine.search(cancelledRule, 'cancel', {
      sessionOwner,
      onVerification(challenge) {
        cancelledChallenge = challenge;
        throw new HttpError('Compatibility verification cancelled', 499);
      },
    }),
    /Compatibility verification cancelled/,
  );
  assert.ok(cancelledChallenge);
  if (official) await assert.rejects(cancelledChallenge.snapshot());
  else assert.ok(cancelledChallenge.page.isClosed());
  await assert.rejects(engine.search(cancelledRule, 'retry', { sessionOwner }), {
    code: official ? 'CAPTCHA_REQUIRED' : 'VERIFICATION_REQUIRED',
  });
  record('captcha-cancel', { cancelled: true, noClearanceSaved: true });
  const id = 'cancel-playback';
  const rule = browserRule(origin, id);
  const before = fixture.requests.length;
  const controller = new AbortController();
  const pending = engine.resolve(rule, `${origin}/browser/${id}/watch`, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending);
  await until(
    () => fixture.requests.slice(before).filter((r) => r.id === id).length >= (official ? 1 : 2),
    'pending playback request',
  );
  controller.abort();
  await rejected;
  const recovery = await engine.resolve(
    browserRule(origin, 'delayed-mp4'),
    `${origin}/browser/delayed-mp4/watch`,
  );
  assert.equal(recovery.type, 'video');
  record(id, { cancelled: true, nextRequestSucceeded: true });
  return results;
}
