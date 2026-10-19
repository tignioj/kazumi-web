import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { KazumiCoreClient } from '../../server/modules/core/client.js';
import { createHttpClient } from '../../server/lib/http.js';

async function fixture(t) {
  const calls = [];
  const bytes = Buffer.from('fixture-video');
  const mediaHeaders = [];
  const media = createServer((req, res) => {
    mediaHeaders.push(req.headers);
    if (req.url === '/master.m3u8' || req.url === '/playlist') {
      res.setHeader(
        'content-type',
        req.url === '/playlist' ? 'application/octet-stream' : 'application/vnd.apple.mpegurl',
      );
      return res.end('#EXTM3U\n#EXTINF:1,\n/movie.mp4\n#EXT-X-ENDLIST\n');
    }
    const start = req.headers.range ? 2 : 0;
    res.writeHead(start ? 206 : 200, {
      'content-type': 'video/mp4',
      'content-length': bytes.length - start,
      ...(start ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    res.end(bytes.subarray(start));
  });
  media.listen(0, '127.0.0.1');
  await once(media, 'listening');
  const origin = `http://127.0.0.1:${media.address().port}`;
  const rule = {
    name: 'Upstream',
    api: '9',
    baseURL: origin,
    searchMode: 'api',
    searchApiConfig: { sourcePath: '$.opaque', sourceTemplate: 'https://example.com/GV@source/' },
  };
  const service = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/validate') return res.end(JSON.stringify({ rules: [body.content] }));
    if (req.url === '/search')
      return res.end(JSON.stringify({ items: [{ name: '番剧', url: 'opaque/a%2Fb' }] }));
    if (req.url === '/chapters')
      return res.end(
        JSON.stringify({
          roads: [{ name: '线路', episodes: [{ name: '一', url: `${origin}/episode` }] }],
        }),
      );
    if (req.url === '/resolve')
      return res.end(
        JSON.stringify({
          type: body.url.includes('hls') ? 'hls' : 'video',
          url: `${origin}/${body.url.includes('extensionless') ? 'playlist' : body.url.includes('hls') ? 'master.m3u8' : 'movie.mp4'}`,
          headers: { referer: 'https://source.example/', authorization: 'Bearer secret' },
          cookies: [
            {
              name: 'verified',
              value: 'cookie-secret',
              domain: '127.0.0.1',
              path: '/',
              expires: -1,
            },
          ],
        }),
      );
    res.writeHead(404).end('{"error":"unexpected operation"}');
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-core-contract-'));
  const app = await createApp({
    dataDir: directory,
    metadata: {},
    seedRules: [rule],
    egress: false,
    httpClient: createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' }),
    coreOptions: { url: `http://127.0.0.1:${service.address().port}` },
  });
  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await app.close();
    for (const s of [server, service, media]) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (path, body) => {
    const response = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { calls, post, base, rule, origin, bytes, mediaHeaders };
}

test('search and chapters delegate unchanged rules and opaque IDs to Kazumi', async (t) => {
  const f = await fixture(t);
  const search = await f.post('/rules/search', { keyword: '番剧' });
  assert.equal(search.results[0].items[0].url, 'opaque/a%2Fb');
  await f.post('/rules/chapters', { ruleName: f.rule.name, url: 'opaque/a%2Fb' });
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['/search', '/chapters'],
  );
  for (const [key, value] of Object.entries(f.rule))
    assert.deepEqual(f.calls[0].body.rule[key], value);
  assert.equal(f.calls[1].body.url, 'opaque/a%2Fb');
  assert.match(f.calls[0].body.owner, /^[A-Za-z0-9_-]{32}$/);
  assert.match(f.calls[0].body.requestId, /^[a-f0-9-]{36}$/);
});

test('native resolution feeds the media proxy without exposing cookies and preserves Range', async (t) => {
  const f = await fixture(t);
  const result = await f.post('/resolve', { ruleName: f.rule.name, url: `${f.origin}/episode` });
  assert.equal(f.calls[0].path, '/resolve');
  const data = JSON.parse(
    Buffer.from(new URL(result.url, f.base).searchParams.get('payload'), 'base64url'),
  );
  assert.doesNotMatch(JSON.stringify(data), /cookie-secret|Bearer|headers/);
  const response = await fetch(new URL(result.url, f.base), { headers: { range: 'bytes=2-' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(2));
  assert.equal(f.mediaHeaders[0].cookie, 'verified=cookie-secret');
  assert.equal(f.mediaHeaders[0].referer, 'https://source.example/');
  assert.equal(f.mediaHeaders[0].range, 'bytes=2-');
});

test('HLS manifests stay on the existing same-origin transport', async (t) => {
  const f = await fixture(t);
  const result = await f.post('/resolve', { ruleName: f.rule.name, url: `${f.origin}/hls` });
  const manifest = await (await fetch(new URL(result.url, f.base))).text();
  const child = manifest.split('\n').find((line) => line.startsWith('/api/media?'));
  assert.ok(child);
  assert.deepEqual(Buffer.from(await (await fetch(new URL(child, f.base))).arrayBuffer()), f.bytes);
});

test('extensionless HLS media receives a browser format hint without parsing source pages', async (t) => {
  const f = await fixture(t);
  const result = await f.post('/resolve', {
    ruleName: f.rule.name,
    url: `${f.origin}/extensionless`,
  });
  assert.equal(result.type, 'hls');
  const response = await fetch(new URL(result.url, f.base));
  assert.match(response.headers.get('content-type'), /mpegurl/);
  assert.match(await response.text(), /\/api\/media\?/);
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['/resolve'],
  );
});

test('core failures are reported without falling back to a local parser', async () => {
  const client = new KazumiCoreClient({
    fetcher: async () => {
      throw new TypeError('offline');
    },
  });
  await assert.rejects(client.resolve({}, 'https://example.com/episode'), { status: 503 });
  const invalid = new KazumiCoreClient({
    fetcher: async () => Response.json({ error: 'upstream rule failure' }, { status: 400 }),
  });
  await assert.rejects(invalid.validate({}), { status: 400, message: 'upstream rule failure' });
});

test('cancellation reaches the upstream request ID', async () => {
  const calls = [];
  const controller = new AbortController();
  const client = new KazumiCoreClient({
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ path: url.pathname, body });
      if (url.pathname === '/cancel') return Response.json({ ok: true });
      controller.abort();
      throw controller.signal.reason;
    },
  });
  await assert.rejects(client.search({}, 'query', { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(calls[1].path, '/cancel');
  assert.equal(calls[1].body.requestId, calls[0].body.requestId);
});

test('search retries transient connection failures once with a fresh request ID', async () => {
  for (const code of ['SOURCE_CONNECTION_ERROR', 'SOURCE_CONNECT_TIMEOUT']) {
    const calls = [];
    const items = [{ name: '银魂', url: 'opaque/247' }];
    const client = new KazumiCoreClient({
      fetcher: async (url, options) => {
        calls.push({ path: url.pathname, body: JSON.parse(options.body) });
        return calls.length === 1
          ? Response.json({ error: '来源连接中断', code }, { status: 502 })
          : Response.json({ items });
      },
    });
    const rule = { name: 'Source', usePost: true };
    assert.deepEqual(await client.search(rule, '银魂', { sessionOwner: 'owner' }), items);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.path === '/search'));
    assert.deepEqual(calls[1].body.rule, rule);
    assert.equal(calls[1].body.keyword, '银魂');
    assert.equal(calls[1].body.owner, 'owner');
    assert.notEqual(calls[0].body.requestId, calls[1].body.requestId);
  }
});

test('persistent failures stop after one retry and permanent failures are not retried', async () => {
  for (const [code, expected] of [
    ['SOURCE_CONNECTION_ERROR', 2],
    ['SOURCE_CERTIFICATE_ERROR', 1],
    ['SOURCE_TLS_ERROR', 1],
    ['SOURCE_TIMEOUT', 1],
    ['SOURCE_HTTP_ERROR', 1],
    ['SOURCE_RULE_ERROR', 1],
    [undefined, 1],
  ]) {
    let calls = 0;
    const client = new KazumiCoreClient({
      fetcher: async () => {
        calls++;
        return Response.json({ error: '来源失败', code }, { status: 502 });
      },
    });
    await assert.rejects(client.search({}, '银魂'), { message: '来源失败' });
    assert.equal(calls, expected, code);
  }
});

test('cancelling a failed search prevents a retry', async () => {
  const controller = new AbortController();
  const calls = [];
  const client = new KazumiCoreClient({
    fetcher: async (url) => {
      calls.push(url.pathname);
      if (url.pathname === '/cancel') return Response.json({ ok: true });
      controller.abort();
      return Response.json(
        { error: '来源连接中断', code: 'SOURCE_CONNECTION_ERROR' },
        { status: 502 },
      );
    },
  });
  await assert.rejects(client.search({}, '银魂', { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.deepEqual(calls, ['/search', '/cancel']);
});
