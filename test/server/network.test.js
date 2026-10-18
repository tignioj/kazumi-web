import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import ipaddr from 'ipaddr.js';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { createHttpClient } from '../../server/lib/http.js';
import { createBrowserEgress } from '../../server/lib/browser-egress.js';
import { createProxyTunnels } from '../../server/lib/proxy-tunnel.js';
import { NetworkStore } from '../../server/modules/network/store.js';
import { DEFAULT_NETWORK_SETTINGS, proxySettingsFor } from '../../shared/network-settings.js';

const credentials = { username: 'proxy-user', password: '密码:@secret' };
const basicAuth = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
const certificate = await readFile(
  new URL('../fixtures/network/localhost-cert.pem', import.meta.url),
);
const key = await readFile(new URL('../fixtures/network/localhost-key.pem', import.meta.url));
const originalCAs = tls.getCACertificates('default');
tls.setDefaultCACertificates([...originalCAs, certificate.toString()]);

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

async function upstream(t, secure = false) {
  const received = [];
  const handler = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === '/redirect') return res.writeHead(302, { location: '/result' }).end();
    if (req.url === '/private')
      return res.writeHead(302, { location: 'http://127.0.0.1/secret' }).end();
    res.writeHead(req.headers.range ? 206 : 200, { 'content-type': 'text/plain' });
    res.end('via-upstream');
  };
  const port = await listen(
    t,
    secure ? https.createServer({ key, cert: certificate }, handler) : http.createServer(handler),
  );
  return { port, received, url: `${secure ? 'https' : 'http'}://localhost:${port}` };
}

async function httpProxy(t, { secure = false, authenticate = true } = {}) {
  const calls = [];
  const server = secure ? https.createServer({ key, cert: certificate }) : http.createServer();
  server.on('connect', (req, client, head) => {
    calls.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    if (authenticate && req.headers['proxy-authorization'] !== basicAuth) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = new URL(`http://${req.url}`);
    // The public-IP fixture is mapped back to the local test origin here.
    const remote = net.connect(Number(target.port), '127.0.0.1');
    remote.on('error', () => client.destroy());
    client.on('close', () => remote.destroy());
    remote.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    });
  });
  const port = await listen(t, server);
  return {
    calls,
    settings: {
      enabled: true,
      url: `${secure ? 'https' : 'http'}://localhost:${port}`,
      ...credentials,
    },
  };
}

async function socksProxy(t) {
  const calls = [];
  const server = net.createServer((client) => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    const data = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        assert.equal(buffer[0], 5);
        buffer = buffer.subarray(2 + buffer[1]);
        client.write(Buffer.from([5, 2]));
        stage = 1;
      }
      if (stage === 1) {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
        const passwordOffset = 2 + buffer[1];
        const length = passwordOffset + 1 + buffer[passwordOffset];
        if (buffer.length < length) return;
        assert.equal(buffer.subarray(2, passwordOffset).toString(), credentials.username);
        assert.equal(buffer.subarray(passwordOffset + 1, length).toString(), credentials.password);
        buffer = buffer.subarray(length);
        client.write(Buffer.from([1, 0]));
        stage = 2;
      }
      if (stage === 2) {
        if (buffer.length < 4) return;
        assert.ok([1, 4].includes(buffer[3]), 'validated IP address is handed to SOCKS');
        const addressLength = buffer[3] === 1 ? 4 : 16;
        const length = 6 + addressLength;
        if (buffer.length < length) return;
        const address = ipaddr.fromByteArray([...buffer.subarray(4, 4 + addressLength)]).toString();
        const port = buffer.readUInt16BE(4 + addressLength);
        calls.push({ address, port });
        client.removeListener('data', data);
        const remote = net.connect(port, '127.0.0.1');
        remote.on('error', () => client.destroy());
        client.on('close', () => remote.destroy());
        remote.on('connect', () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (buffer.length > length) remote.write(buffer.subarray(length));
          client.pipe(remote).pipe(client);
        });
      }
    };
    client.on('data', data);
  });
  const port = await listen(t, server);
  return { calls, settings: { enabled: true, url: `socks5://127.0.0.1:${port}`, ...credentials } };
}

test('HTTP, HTTPS and authenticated SOCKS5 proxies preserve HTTP bodies, ranges and target TLS', async (t) => {
  for (const protocol of ['http', 'https', 'socks5']) {
    await t.test(protocol, async (t) => {
      const plain = await upstream(t);
      const secure = await upstream(t, true);
      const proxy =
        protocol === 'socks5'
          ? await socksProxy(t)
          : await httpProxy(t, { secure: protocol === 'https' });
      const client = createHttpClient({
        allowPrivate: true,
        getProxySettings: () => proxy.settings,
        dnsOverHttpsUrl: '',
      });
      t.after(() => client.close());
      const result = await client.text(`${plain.url}/post`, {
        method: 'POST',
        body: 'request-body',
        headers: { range: 'bytes=0-5', cookie: 'origin=value' },
      });
      assert.equal(result.response.status, 206);
      assert.equal(result.text, 'via-upstream');
      assert.equal(plain.received[0].body, 'request-body');
      assert.equal(plain.received[0].headers.cookie, 'origin=value');
      assert.equal(plain.received[0].headers['proxy-authorization'], undefined);
      assert.equal((await client.text(`${secure.url}/tls`)).text, 'via-upstream');
      assert.equal(proxy.calls.length, 2);
    });
  }
});

test('proxy changes take effect without restart and failures never fall back to direct', async (t) => {
  const origin = await upstream(t);
  const first = await httpProxy(t);
  const second = await socksProxy(t);
  let settings = { enabled: false };
  const client = createHttpClient({
    allowPrivate: true,
    getProxySettings: () => settings,
    dnsOverHttpsUrl: '',
  });
  t.after(() => client.close());
  await client.text(origin.url);
  assert.equal(first.calls.length, 0);
  settings = first.settings;
  await client.text(origin.url);
  assert.equal(first.calls.length, 1);
  settings = second.settings;
  await client.text(origin.url);
  assert.equal(second.calls.length, 1);
  settings = { ...first.settings, password: 'wrong' };
  await assert.rejects(client.text(origin.url), { status: 502, message: /代理连接失败/ });
  assert.equal(origin.received.length, 3);
  settings = { enabled: false };
  await client.text(origin.url);
  assert.equal(origin.received.length, 4);
  assert.equal(
    first.calls.at(-1).auth,
    `Basic ${Buffer.from(`${credentials.username}:wrong`).toString('base64')}`,
  );
});

test('proxy traffic validates DNS, pins the public address and rejects private redirects', async (t) => {
  const origin = await upstream(t);
  const proxy = await httpProxy(t);
  let address = '8.8.8.8';
  const client = createHttpClient({
    getProxySettings: () => proxy.settings,
    dnsOverHttpsUrl: '',
    resolver: async () => [{ address, family: 4 }],
  });
  t.after(() => client.close());
  const target = `http://public.invalid:${origin.port}`;
  assert.equal((await client.text(`${target}/redirect`)).text, 'via-upstream');
  assert.equal(proxy.calls[0].target, `8.8.8.8:${origin.port}`);
  assert.equal(origin.received[0].headers.host, `public.invalid:${origin.port}`);
  await assert.rejects(client.text(`${target}/private`), { status: 403 });
  const beforeBlocked = proxy.calls.length;
  address = '127.0.0.1';
  await assert.rejects(client.text(`http://another.invalid:${origin.port}`), { status: 403 });
  assert.equal(proxy.calls.length, beforeBlocked);
});

test('Chromium egress uses the same proxy for plain HTTP and CONNECT', async (t) => {
  for (const protocol of ['http', 'socks5']) {
    await t.test(protocol, async (t) => {
      const origin = await upstream(t);
      const proxy = protocol === 'socks5' ? await socksProxy(t) : await httpProxy(t);
      const egress = await createBrowserEgress({
        allowPrivate: true,
        dnsOverHttpsUrl: '',
        getProxySettings: () => proxy.settings,
      });
      t.after(() => egress.close());
      const plain = await new Promise((resolve, reject) => {
        const req = http.get(egress.url, { path: `${origin.url}/browser` }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
      });
      assert.equal(plain, 'via-upstream');
      const socket = await new Promise((resolve, reject) => {
        const req = http.request(egress.url, {
          method: 'CONNECT',
          path: `localhost:${origin.port}`,
        });
        req.on('connect', (res, socket) => {
          assert.equal(res.statusCode, 200);
          resolve(socket);
        });
        req.on('error', reject);
        req.end();
      });
      socket.write('GET /tunnel HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      const chunks = [];
      for await (const chunk of socket) chunks.push(chunk);
      assert.match(Buffer.concat(chunks).toString(), /via-upstream/);
      assert.equal(proxy.calls.length, 2);
    });
  }
});

test('five proxy categories route independently across all combinations and redirects', async (t) => {
  const origin = await upstream(t);
  const proxy = await httpProxy(t);
  let settings = { ...DEFAULT_NETWORK_SETTINGS, ...credentials, url: proxy.settings.url };
  const clients = ['video', 'image', 'bangumi', 'rules', 'archive', undefined].map((scope) => ({
    scope,
    client: createHttpClient({
      allowPrivate: true,
      dnsOverHttpsUrl: '',
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
      getProxySettings: () => proxySettingsFor(settings, scope),
    }),
  }));
  t.after(() => Promise.all(clients.map(({ client }) => client.close())));
  for (let mask = 0; mask < 32; mask++) {
    settings = {
      ...settings,
      videoProxy: Boolean(mask & 1),
      imageProxy: Boolean(mask & 2),
      bangumiProxy: Boolean(mask & 4),
      rulesProxy: Boolean(mask & 8),
      archiveProxy: Boolean(mask & 16),
    };
    for (const { scope, client } of clients) {
      const before = proxy.calls.length;
      const target = `http://${scope || 'other'}-${mask}.invalid:${origin.port}/redirect`;
      assert.equal((await client.text(target)).text, 'via-upstream');
      assert.equal(
        proxy.calls.length > before,
        scope ? settings[`${scope}Proxy`] : false,
        `${scope || 'other'} traffic with switches ${mask}`,
      );
    }
  }
});

test('Chromium video egress ignores image and API proxy switches and follows video changes', async (t) => {
  const origin = await upstream(t);
  const proxy = await httpProxy(t);
  let settings = {
    ...DEFAULT_NETWORK_SETTINGS,
    ...credentials,
    url: proxy.settings.url,
    imageProxy: true,
    bangumiProxy: true,
  };
  const egress = await createBrowserEgress({
    allowPrivate: true,
    dnsOverHttpsUrl: '',
    getProxySettings: () => proxySettingsFor(settings, 'video'),
  });
  t.after(() => egress.close());
  for (const videoProxy of [false, true, false]) {
    settings = { ...settings, videoProxy };
    const before = proxy.calls.length;
    await new Promise((resolve, reject) => {
      const req = http.get(egress.url, { path: `${origin.url}/browser` }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
    });
    assert.equal(proxy.calls.length > before, videoProxy);
  }
});

test('network settings API persists secrets, supports draft tests and keeps saved settings on failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-network-'));
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = await upstream(t);
  const proxy = await httpProxy(t);
  application = await createApp({
    dataDir: directory,
    seedRules: [],
    metadata: {},
    browserResolver: false,
    httpOptions: { allowPrivate: true, dnsOverHttpsUrl: '' },
  });
  const port = await listen(t, http.createServer(application.app));
  const base = `http://127.0.0.1:${port}/api/network-settings`;
  async function request(path = '', method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { response, data: await response.json() };
  }
  assert.equal((await request()).data.videoProxy, false);
  assert.equal((await request()).data.rulesProxy, false);
  assert.equal((await request()).data.archiveProxy, false);
  assert.equal((await request()).data.enabled, undefined);
  assert.equal((await request()).data.bangumiEch, false);
  assert.equal((await request()).data.imageAcceleration, 'direct');
  const saved = await request('', 'PUT', {
    url: proxy.settings.url,
    username: credentials.username,
    password: credentials.password,
    videoProxy: true,
    imageProxy: true,
    bangumiProxy: true,
    rulesProxy: true,
    archiveProxy: true,
    bangumiEch: true,
    imageAcceleration: 'mirror',
    echDohUrl: 'https://dns.example/dns-query',
  });
  assert.equal(saved.data.videoProxy, true);
  assert.equal(saved.data.hasPassword, true);
  assert.equal(saved.data.password, undefined);
  assert.equal((await stat(join(directory, 'network-settings.json'))).mode & 0o777, 0o600);
  const reloaded = await new NetworkStore(directory).init();
  assert.equal(reloaded.data.password, credentials.password);
  assert.equal(reloaded.data.videoProxy, true);
  assert.equal(reloaded.data.imageProxy, true);
  assert.equal(reloaded.data.bangumiProxy, true);
  assert.equal(reloaded.data.rulesProxy, true);
  assert.equal(reloaded.data.archiveProxy, true);
  assert.equal(reloaded.data.bangumiEch, true);
  assert.equal(reloaded.data.imageAcceleration, 'mirror');
  assert.equal(reloaded.data.echDohUrl, 'https://dns.example/dns-query');
  const retained = await request('', 'PUT', { videoProxy: false, url: proxy.settings.url });
  assert.equal(retained.data.hasPassword, true);
  assert.equal(retained.data.videoProxy, false);
  assert.equal(retained.data.imageProxy, true);
  assert.equal(retained.data.bangumiProxy, true);
  assert.equal(retained.data.rulesProxy, true);
  assert.equal(retained.data.archiveProxy, true);
  assert.equal(retained.data.bangumiEch, true);
  assert.equal(retained.data.imageAcceleration, 'mirror');
  assert.equal(retained.data.echDohUrl, 'https://dns.example/dns-query');
  const tested = await request('/test', 'POST', {
    settings: { bangumiProxy: true, url: proxy.settings.url, bangumiEch: false },
    url: origin.url,
  });
  assert.equal(tested.data.mode, 'proxy');
  assert.equal(proxy.calls.length, 1);
  for (const [scope, mode] of [
    ['video', 'direct'],
    ['image', 'proxy'],
    ['bangumi', 'proxy'],
    ['rules', 'proxy'],
    ['archive', 'proxy'],
  ]) {
    const result = await request('/test', 'POST', { settings: {}, scope, url: origin.url });
    assert.equal(result.data.mode, mode);
    assert.equal(result.data.scope, scope);
  }
  assert.equal(
    (await request('/test', 'POST', { settings: {}, scope: 'all', url: origin.url })).response
      .status,
    400,
  );
  assert.equal((await request()).data.videoProxy, false, 'draft tests never save');
  assert.equal((await request()).data.bangumiEch, true, 'draft tests preserve saved ECH');
  assert.equal(
    (await request()).data.imageAcceleration,
    'mirror',
    'draft tests preserve image mode',
  );
  const bad = await fetch(base, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bangumiProxy: true, url: 'file:///tmp/proxy' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await request()).data.videoProxy, false);
  const badEch = await request('', 'PUT', { videoProxy: false, echDohUrl: 'http://dns.example' });
  assert.equal(badEch.response.status, 400);
  assert.equal((await request()).data.echDohUrl, 'https://dns.example/dns-query');
  const badImage = await request('', 'PUT', { videoProxy: false, imageAcceleration: 'invalid' });
  assert.equal(badImage.response.status, 400);
  assert.equal((await request()).data.imageAcceleration, 'mirror');
  assert.equal((await request('', 'PUT', { enabled: true })).response.status, 400);
  const cleared = await request('', 'PUT', { videoProxy: false, username: '', password: '' });
  assert.equal(cleared.data.hasPassword, false);
});

test('legacy network files load with ECH disabled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-network-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'network-settings.json'),
    JSON.stringify({ enabled: false, url: '', username: '', password: '' }),
  );
  const network = await new NetworkStore(directory).init();
  assert.equal(network.data.bangumiEch, false);
  assert.equal(network.data.videoProxy, false);
  assert.equal(network.data.imageProxy, false);
  assert.equal(network.data.bangumiProxy, false);
  assert.equal(network.data.rulesProxy, false);
  assert.equal(network.data.archiveProxy, false);
  assert.equal(network.data.imageAcceleration, 'direct');
  await network.save({ bangumiEch: true });
  const reloaded = await new NetworkStore(directory).init();
  assert.equal(reloaded.data.bangumiEch, true);
  assert.equal(
    reloaded.data.imageAcceleration,
    'direct',
    'changing API ECH leaves images unchanged',
  );
});

test('legacy global proxy settings migrate once and scoped saves never restore the global switch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-proxy-scopes-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'network-settings.json');
  await writeFile(file, JSON.stringify({ enabled: true, url: 'http://localhost:7890' }));
  const network = await new NetworkStore(directory).init();
  assert.equal(network.data.videoProxy, true);
  assert.equal(network.data.imageProxy, true);
  assert.equal(network.data.bangumiProxy, true);
  assert.equal(network.data.rulesProxy, true);
  assert.equal(network.data.archiveProxy, true);
  await network.save({ videoProxy: false });
  const reloaded = await new NetworkStore(directory).init();
  assert.equal(reloaded.data.videoProxy, false);
  assert.equal(reloaded.data.imageProxy, true);
  assert.equal(reloaded.data.bangumiProxy, true);
  assert.equal(reloaded.data.rulesProxy, true);
  assert.equal(reloaded.data.archiveProxy, true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).enabled, undefined);
});

test('three-category settings gain independent rule and archive switches without changing existing choices', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-repository-proxies-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'network-settings.json'),
    JSON.stringify({
      videoProxy: true,
      imageProxy: false,
      bangumiProxy: true,
      url: 'http://localhost:7890',
    }),
  );
  const network = await new NetworkStore(directory).init();
  assert.equal(network.data.rulesProxy, false);
  assert.equal(network.data.archiveProxy, false);
  await network.save({ rulesProxy: true, archiveProxy: true });
  await network.save({ videoProxy: false });
  const reloaded = await new NetworkStore(directory).init();
  assert.equal(reloaded.data.videoProxy, false);
  assert.equal(reloaded.data.imageProxy, false);
  assert.equal(reloaded.data.bangumiProxy, true);
  assert.equal(reloaded.data.rulesProxy, true);
  assert.equal(reloaded.data.archiveProxy, true);
  await reloaded.save({ rulesProxy: false });
  assert.equal(reloaded.data.archiveProxy, true);
});

test('legacy combined ECH settings migrate images once and persist independent choices', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-network-images-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'network-settings.json'),
    JSON.stringify({ enabled: false, url: '', username: '', password: '', bangumiEch: true }),
  );
  const network = await new NetworkStore(directory).init();
  assert.equal(network.data.imageAcceleration, 'ech');
  await network.save({ imageAcceleration: 'direct' });
  const reloaded = await new NetworkStore(directory).init();
  assert.equal(reloaded.data.bangumiEch, true);
  assert.equal(reloaded.data.imageAcceleration, 'direct');
});

test('closing proxy tunnels cancels a pending SOCKS handshake', { timeout: 1000 }, async (t) => {
  const server = net.createServer();
  const port = await listen(t, server);
  const tunnels = createProxyTunnels({ timeout: 30000 });
  t.after(() => tunnels.close());
  const pending = tunnels.connect(
    { enabled: true, url: `socks5://127.0.0.1:${port}` },
    '8.8.8.8',
    80,
  );
  const rejected = assert.rejects(pending, /关闭|closed|Socket/);
  await once(server, 'connection');
  await tunnels.close();
  await rejected;
});
