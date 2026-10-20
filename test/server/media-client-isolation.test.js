import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { RuleEngine } from '../../server/modules/rules/engine.js';
import { LocalSourceResolver } from '../../server/modules/playback/source-resolver.js';

const cert = await readFile(new URL('../fixtures/network/localhost-cert.pem', import.meta.url));
const key = await readFile(new URL('../fixtures/network/localhost-key.pem', import.meta.url));
tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert.toString()]);
const payload = Buffer.alloc(3 * 1024 * 1024 + 13, 0x61);
payload[512 * 1024] = 0x62;
payload[payload.length - 1] = 0x7a;

for (const proxied of [false, true]) {
  test(`local rules retain HTTP/2 while media uses HTTP/1.1 (${proxied ? 'proxy' : 'direct'})`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'kazumi-media-clients-'));
    const received = [];
    const sessions = new Set();
    const sockets = new Set();
    let application, server, proxy;
    let tunnels = 0;
    const origin = http2.createSecureServer({ key, cert, allowHTTP1: true });
    origin.on('session', (session) => {
      sessions.add(session);
      session.on('error', () => {});
      session.once('close', () => sessions.delete(session));
    });
    origin.on('request', (req, res) => {
      const path = new URL(req.url, 'https://fixture').pathname;
      received.push({ path, protocol: req.httpVersion, range: req.headers.range });
      res.on('error', () => {});
      if (path === '/search') return res.end('<article><a href="/play">Fixture</a></article>');
      if (path === '/play') return res.end('<video src="/movie.mp4"></video>');
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const from = Number(range?.[1] || 0);
      const to = Math.min(range?.[2] ? Number(range[2]) : payload.length - 1, payload.length - 1);
      if (from > to)
        return res.writeHead(416, { 'content-range': `bytes */${payload.length}` }).end();
      res.writeHead(range ? 206 : 200, {
        'content-type': 'video/mp4',
        'content-length': to - from + 1,
        ...(range && { 'content-range': `bytes ${from}-${to}/${payload.length}` }),
        etag: '"fixture"',
      });
      res.end(payload.subarray(from, to + 1));
    });
    t.after(async () => {
      server?.closeAllConnections();
      if (server) await new Promise((resolve) => server.close(resolve));
      await application?.close();
      for (const session of sessions) session.destroy();
      for (const socket of sockets) socket.destroy();
      origin.closeAllConnections?.();
      await new Promise((resolve) => origin.close(resolve));
      if (proxy) await new Promise((resolve) => proxy.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    if (proxied) {
      proxy = http.createServer();
      proxy.on('connect', (req, client, head) => {
        tunnels++;
        const remote = net.connect(
          Number(req.url.slice(req.url.lastIndexOf(':') + 1)),
          '127.0.0.1',
        );
        sockets.add(client);
        sockets.add(remote);
        client.on('error', () => {});
        remote.on('error', () => client.destroy());
        client.once('close', () => remote.destroy());
        remote.once('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) remote.write(head);
          client.pipe(remote).pipe(client);
        });
      });
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
    }
    const baseURL = `https://localhost:${origin.address().port}`;
    const rule = {
      name: 'Transport fixture',
      api: '3',
      baseURL,
      searchURL: `${baseURL}/search?q=@keyword`,
      searchList: '//article',
      searchName: '//a',
      searchResult: '//a',
    };
    application = await createApp({
      dataDir: directory,
      seedRules: [rule],
      metadata: {},
      browserResolver: false,
      httpOptions: { allowPrivate: true, dnsOverHttpsUrl: '' },
    });
    if (proxied)
      await application.network.save({
        videoProxy: true,
        url: `http://127.0.0.1:${proxy.address().port}`,
      });
    assert.ok(application.engine instanceof RuleEngine);
    const media = application.downloads.media;
    assert.ok(media.resolver instanceof LocalSourceResolver);
    assert.equal(media.resolver.http, application.engine.http);
    assert.notEqual(media.http, application.engine.http);
    assert.equal(application.downloads.http, media.http);
    assert.deepEqual(await application.engine.search(rule, 'Fixture'), [
      { name: 'Fixture', url: `${baseURL}/play` },
    ]);
    server = application.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const resolvedResponse = await fetch(`${base}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleName: rule.name, url: `${baseURL}/play` }),
    });
    assert.equal(resolvedResponse.status, 200);
    const resolved = await resolvedResponse.json();
    const response = await fetch(base + resolved.url, { headers: { range: 'bytes=19-' } });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get('content-range'),
      `bytes 19-${payload.length - 1}/${payload.length}`,
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(19));
    assert.ok(
      received
        .filter((r) => ['/search', '/play'].includes(r.path))
        .every((r) => r.protocol === '2.0'),
    );
    assert.ok(
      received.some((r) => r.path === '/play'),
      'the local source resolver fetched the page',
    );
    assert.ok(received.filter((r) => r.path === '/movie.mp4').every((r) => r.protocol === '1.1'));
    if (proxied)
      assert.ok(tunnels >= 2, 'both rule and media clients use the configured video proxy');
  });
}
