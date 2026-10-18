import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createEchTransport, isEchTarget, parseEchConfig } from '../../server/lib/ech.js';
import { createHttpClient } from '../../server/lib/http.js';

const config = { Status: 0, Answer: [{ type: 65, TTL: 100, data: '1 . alpn=h2 ech=AAECAw==' }] };
const lookup = (host, options, callback) => callback(null, [{ address: '104.26.8.23', family: 4 }]);

async function helper(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'kazumi-ech-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'helper');
  await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return binary;
}

test('ECH discovery requires a real HTTPS ECH config and exact allowed hosts', () => {
  assert.deepEqual(parseEchConfig(config), { value: 'AAECAw==', ttl: 100 });
  for (const data of [
    { Status: 2 },
    { Status: 0, Answer: [] },
    { Status: 0, Answer: [{ type: 65, data: '1 . ech=AAAAA' }] },
  ])
    assert.throws(() => parseEchConfig(data));
  assert.equal(isEchTarget('https://api.bgm.tv:443/v0/search/subjects'), true);
  for (const url of [
    'http://api.bgm.tv/',
    'https://api.bgm.tv:444/',
    'https://api.bgm.tv.evil.example/',
    'https://example.com/',
  ])
    assert.equal(isEchTarget(url), false);
});

test('ECH subprocess preserves POST data and public pinned addresses, and caches discovery', async (t) => {
  const binary = await helper(
    t,
    `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify({status:200,echAccepted:true,headers:{'Content-Type':['application/json']},body:Buffer.from(input).toString('base64')})));`,
  );
  let discoveries = 0;
  const transport = createEchTransport({
    binary,
    lookup,
    queryConfig: async () => {
      discoveries++;
      return config;
    },
  });
  t.after(() => transport.close());
  for (let i = 0; i < 2; i++) {
    const response = await transport.request('https://api.bgm.tv/v0/search/subjects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"keyword":"科幻"}',
      signal: AbortSignal.timeout(3000),
    });
    const input = await response.json();
    assert.equal(input.method, 'POST');
    assert.equal(Buffer.from(input.body, 'base64').toString(), '{"keyword":"科幻"}');
    assert.deepEqual(input.addresses, ['104.26.8.23']);
    assert.equal(input.echConfig, 'AAECAw==');
  }
  assert.equal(discoveries, 1);
});

test('ECH requires acceptance and aborts an active helper with handshake evidence', async (t) => {
  const rejected = await helper(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({status:200,echAccepted:false})));`,
  );
  const first = createEchTransport({ binary: rejected, lookup, queryConfig: async () => config });
  t.after(() => first.close());
  await assert.rejects(
    first.request('https://api.bgm.tv/', { signal: AbortSignal.timeout(3000) }),
    /未接受 ECH/,
  );
  const waiting = await helper(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>{console.error('ECH_ACCEPTED');setTimeout(()=>{},10000);});`,
  );
  const second = createEchTransport({ binary: waiting, lookup, queryConfig: async () => config });
  t.after(() => second.close());
  await assert.rejects(
    second.request('https://api.bgm.tv/', { signal: AbortSignal.timeout(500) }),
    (error) => error.name === 'TimeoutError' && error.echAccepted === true,
  );
});

test('cancelling one ECH discovery waiter leaves the shared discovery usable', async (t) => {
  const binary = await helper(
    t,
    `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({status:204,echAccepted:true})));`,
  );
  let finish;
  const transport = createEchTransport({
    binary,
    lookup,
    queryConfig: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  t.after(() => transport.close());
  const first = transport.request('https://api.bgm.tv/', { signal: AbortSignal.timeout(30) });
  const second = transport.request('https://api.bgm.tv/', { signal: AbortSignal.timeout(3000) });
  await assert.rejects(first, { name: 'TimeoutError' });
  finish(config);
  assert.equal((await second).status, 204);
});

test('ECH redirect handling strips credentials, changes POST to GET, and blocks private targets', async (t) => {
  const calls = [];
  const http = createHttpClient({
    bangumiEch: true,
    echTransport: {
      request: async (url, options) => {
        calls.push({ url: String(url), ...options });
        return calls.length === 1
          ? new Response(null, { status: 303, headers: { location: 'https://next.bgm.tv/final' } })
          : new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } });
      },
      close() {},
    },
  });
  t.after(() => http.close());
  await assert.rejects(
    http.request('https://api.bgm.tv/search', {
      method: 'POST',
      body: '{}',
      headers: {
        authorization: 'Bearer private',
        cookie: 'private=1',
        'content-type': 'application/json',
      },
    }),
    /私有网络/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers.cookie, undefined);
  assert.equal(calls[1].headers['content-type'], undefined);
});

test('ECH failures never silently fall back and unrelated requests retain their transport', async (t) => {
  let calls = 0;
  const http = createHttpClient({
    bangumiEch: true,
    allowPrivate: true,
    echTransport: {
      request: async () => {
        calls++;
        throw new Error('ECH rejected');
      },
      close() {},
    },
  });
  t.after(() => http.close());
  await assert.rejects(http.request('https://api.bgm.tv/'), /ECH rejected/);
  assert.equal(calls, 1);
  const server = createServer((req, res) => res.end('ordinary HTTP'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { response } = await http.request(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await response.text(), 'ordinary HTTP');
  assert.equal(calls, 1);
});

test('ECH follows live network settings and yields to the proxy without recreating the client', async (t) => {
  const proxy = createServer();
  let proxyCalls = 0;
  proxy.on('connect', (req, socket) => {
    proxyCalls++;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  let settings = { enabled: false, bangumiEch: false };
  let echCalls = 0;
  let directLookups = 0;
  const http = createHttpClient({
    dnsOverHttpsUrl: '',
    getProxySettings: () => settings,
    resolver: async () => {
      if (settings.enabled) return [{ address: '8.8.8.8', family: 4 }];
      directLookups++;
      throw Object.assign(new Error('direct transport selected'), { code: 'DIRECT_SELECTED' });
    },
    echTransport: {
      request: async () => {
        echCalls++;
        return new Response('via ECH');
      },
      close() {},
    },
  });
  t.after(() => http.close());
  const target = 'https://api.bgm.tv/';
  await assert.rejects(http.request(target), /DIRECT_SELECTED/);
  settings = { ...settings, bangumiEch: true };
  assert.equal((await http.text(target)).text, 'via ECH');
  settings = { ...settings, bangumiEch: false };
  await assert.rejects(http.request(target), /DIRECT_SELECTED/);
  assert.equal(directLookups, 2);
  assert.equal(echCalls, 1);
  settings = {
    enabled: true,
    bangumiEch: true,
    url: `http://127.0.0.1:${proxy.address().port}`,
  };
  await assert.rejects(http.request(target, { ech: true }), /代理连接失败/);
  assert.equal(proxyCalls, 1);
  assert.equal(echCalls, 1, 'failed proxy requests do not fall back to ECH');
  settings = { ...settings, enabled: false };
  assert.equal((await http.text(target)).text, 'via ECH');
  assert.equal(echCalls, 2);
});
