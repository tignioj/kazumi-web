import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createBrowserEgress } from '../browser-egress.js';
import { createHttpClient, readLimited } from '../http.js';

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(proxy, target, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxy, { path: target, agent: false, ...options }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function tunnel(proxy, target) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxy, { method: 'CONNECT', path: target, agent: false });
    req.on('connect', (response, socket, head) =>
      resolve({ status: response.statusCode, socket, head }),
    );
    req.on('error', reject);
    req.end();
  });
}

test('browser egress rejects private literals and names before opening a socket', async (t) => {
  const egress = await createBrowserEgress({ dnsOverHttpsUrl: '' });
  t.after(() => egress.close());
  for (const target of [
    'http://127.0.0.1:8080/',
    'http://localhost/',
    'http://foo.local/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data',
  ]) {
    assert.equal((await request(egress.url, target)).status, 403, target);
  }
  for (const target of ['127.0.0.1:443', '[::1]:443', 'localhost:443']) {
    const result = await tunnel(egress.url, target);
    result.socket.destroy();
    assert.equal(result.status, 403, target);
  }
  for (const target of [
    'example.com',
    'example.com:0',
    'example.com:99999',
    'user@example.com:443',
    'example.com:443/path',
  ]) {
    const result = await tunnel(egress.url, target);
    result.socket.destroy();
    assert.equal(result.status, 400, target);
  }
});

test('browser egress validates every DNS answer for HTTP and CONNECT', async (t) => {
  let lookups = 0;
  const egress = await createBrowserEgress({
    dnsOverHttpsUrl: '',
    resolver: async () => {
      lookups++;
      return [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ];
    },
  });
  t.after(() => egress.close());
  assert.equal((await request(egress.url, 'http://fixture.invalid/')).status, 403);
  const result = await tunnel(egress.url, 'fixture.invalid:443');
  result.socket.destroy();
  assert.equal(result.status, 403);
  assert.equal(lookups, 2);
});

test('browser egress forwards bodies and end-to-end headers to a pinned DNS address', async (t) => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers['proxy-authorization'], undefined);
    assert.equal(req.headers['x-secret-hop'], undefined);
    assert.equal(req.headers.cookie, 'session=fixture');
    assert.equal(req.headers.range, 'bytes=0-1');
    assert.equal(req.url, '/dynamic?x=1');
    res.writeHead(206, {
      connection: 'close, x-response-hop',
      'x-response-hop': 'must-not-forward',
      'set-cookie': ['result=fixture; HttpOnly'],
      'content-type': 'text/plain',
    });
    res.end(Buffer.concat(chunks));
  });
  const port = await listen(upstream);
  let lookups = 0;
  const egress = await createBrowserEgress({
    allowPrivate: true,
    dnsOverHttpsUrl: '',
    resolver: async (hostname) => {
      assert.equal(hostname, 'fixture.invalid');
      lookups++;
      // A second lookup would send the request to a different address.
      return [{ address: lookups === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }];
    },
  });
  t.after(async () => {
    await egress.close();
    await close(upstream);
  });
  const result = await request(egress.url, `http://fixture.invalid:${port}/dynamic?x=1`, {
    method: 'POST',
    body: 'payload',
    headers: {
      cookie: 'session=fixture',
      range: 'bytes=0-1',
      connection: 'close, x-secret-hop',
      'x-secret-hop': 'secret',
      'proxy-authorization': 'must-not-forward',
    },
  });
  assert.equal(result.status, 206);
  assert.equal(result.body, 'payload');
  assert.equal(result.headers['x-response-hop'], undefined);
  assert.deepEqual(result.headers['set-cookie'], ['result=fixture; HttpOnly']);
  assert.equal(lookups, 1);
});

test('CONNECT tunnels bytes using the validated DNS address and close cleans up open tunnels', async (t) => {
  const upstreamSockets = new Set();
  const upstream = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
    socket.pipe(socket);
  });
  const port = await listen(upstream);
  let lookups = 0;
  const egress = await createBrowserEgress({
    allowPrivate: true,
    dnsOverHttpsUrl: '',
    resolver: async () => {
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  t.after(async () => {
    await egress.close();
    for (const socket of upstreamSockets) socket.destroy();
    await close(upstream);
  });
  const result = await tunnel(egress.url, `fixture.invalid:${port}`);
  assert.equal(result.status, 200);
  const bytes = once(result.socket, 'data');
  result.socket.write('tunnel data');
  assert.equal((await bytes)[0].toString(), 'tunnel data');
  assert.equal(lookups, 1);
  const socketClosed = once(result.socket, 'close');
  await Promise.all([egress.close(), egress.close()]);
  await socketClosed;
  assert.equal(result.socket.destroyed, true);
});

test('CONNECT accepts bracketed IPv6 addresses when explicitly allowed', async (t) => {
  const upstream = net.createServer((socket) => socket.end('ipv6'));
  let port;
  try {
    port = await listen(upstream, '::1');
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code))
      return t.skip('IPv6 is unavailable');
    throw error;
  }
  const egress = await createBrowserEgress({ allowPrivate: true, dnsOverHttpsUrl: '' });
  t.after(async () => {
    await egress.close();
    await close(upstream);
  });
  const result = await tunnel(egress.url, `[::1]:${port}`);
  assert.equal(result.status, 200);
  const chunks = [result.head];
  for await (const chunk of result.socket) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'ipv6');
});

test('browser egress rejects HTTP upgrades and non-HTTP proxy targets', async (t) => {
  const egress = await createBrowserEgress({ dnsOverHttpsUrl: '' });
  t.after(() => egress.close());
  assert.equal((await request(egress.url, 'ws://example.com/')).status, 400);
  assert.equal((await request(egress.url, 'https://example.com/')).status, 400);
  const upgraded = await request(egress.url, 'http://example.com/', {
    headers: { connection: 'Upgrade', upgrade: 'websocket' },
  });
  assert.equal(upgraded.status, 403);
});

test('browser egress cancels upstream HTTP when the browser disconnects', async (t) => {
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  const upstream = http.createServer((req) => accept(req.socket));
  const port = await listen(upstream);
  const egress = await createBrowserEgress({ allowPrivate: true, dnsOverHttpsUrl: '' });
  t.after(async () => {
    await egress.close();
    await close(upstream);
  });
  const client = http.request(egress.url, {
    path: `http://127.0.0.1:${port}/pending`,
    agent: false,
  });
  client.on('error', () => {});
  client.end();
  const socket = await accepted;
  const gone = once(socket, 'close');
  client.destroy();
  await gone;
});

test('browser egress bounds tunnel lifetime even while the connection is open', async (t) => {
  const upstream = net.createServer((socket) => socket.on('error', () => {}));
  const port = await listen(upstream);
  const egress = await createBrowserEgress({
    allowPrivate: true,
    dnsOverHttpsUrl: '',
    tunnelTimeout: 60,
  });
  t.after(async () => {
    await egress.close();
    await close(upstream);
  });
  const result = await tunnel(egress.url, `127.0.0.1:${port}`);
  assert.equal(result.status, 200);
  await once(result.socket, 'close');
  assert.equal(result.socket.destroyed, true);
});

test('HTTP session headers are rebuilt for same-origin paths and cross-origin redirects', async (t) => {
  const seen = [];
  const record = (req) => seen.push({ path: req.url, method: req.method, headers: req.headers });
  const cdn = http.createServer((req, res) => {
    record(req);
    req.resume();
    res.end('media');
  });
  const cdnPort = await listen(cdn);
  const upstream = http.createServer((req, res) => {
    record(req);
    req.resume();
    res
      .writeHead(req.url === '/entry' ? 307 : 302, {
        location: req.url === '/entry' ? '/session/path' : `http://127.0.0.1:${cdnPort}/media`,
      })
      .end();
  });
  const port = await listen(upstream);
  const client = createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' });
  t.after(async () => {
    await client.close();
    await Promise.all([close(upstream), close(cdn)]);
  });
  const selected = [];
  const { response } = await client.request(`http://127.0.0.1:${port}/entry`, {
    method: 'POST',
    body: '{}',
    headers: { cookie: 'stale=must-not-forward' },
    headersForUrl: async (urlString) => {
      const url = new URL(urlString);
      selected.push(url.pathname);
      return {
        cookie: `scope=${url.pathname}`,
        range: 'bytes=0-1',
        'content-type': 'application/json',
      };
    },
  });
  assert.equal(await readLimited(response), 'media');
  assert.deepEqual(selected, ['/entry', '/session/path', '/media']);
  assert.deepEqual(
    seen.map(({ headers }) => headers.cookie),
    ['scope=/entry', 'scope=/session/path', 'scope=/media'],
  );
  assert.deepEqual(
    seen.map(({ headers }) => headers.range),
    ['bytes=0-1', 'bytes=0-1', 'bytes=0-1'],
  );
  assert.deepEqual(
    seen.map(({ method }) => method),
    ['POST', 'POST', 'GET'],
  );
  assert.equal(seen[2].headers['content-type'], undefined);
});
