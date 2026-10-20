import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpClient } from '../../server/lib/http.js';

const cert = await readFile(new URL('../fixtures/network/localhost-cert.pem', import.meta.url));
const key = await readFile(new URL('../fixtures/network/localhost-key.pem', import.meta.url));
tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert.toString()]);
const payload = Buffer.alloc(16 * 1024 * 1024, 0x61);
payload[8 * 1024 * 1024] = 0x62;
payload[payload.length - 1] = 0x7a;

async function fixture(t, proxied, transport = { allowH2: false }) {
  const sessions = new Set();
  const protocols = [];
  const origin = http2.createSecureServer({ key, cert, allowHTTP1: true });
  origin.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => {});
    session.once('close', () => sessions.delete(session));
  });
  origin.on('request', (req, res) => {
    protocols.push(req.httpVersion);
    const [start, end] = (req.headers.range || 'bytes=0-').slice(6).split('-');
    const from = Number(start);
    const to = end ? Number(end) : payload.length - 1;
    res.writeHead(206, {
      'content-type': 'video/mp4',
      'content-length': to - from + 1,
      'content-range': `bytes ${from}-${to}/${payload.length}`,
    });
    res.on('error', () => {});
    if (req.url === '/idle') {
      res.write(payload.subarray(from, from + 1));
      return;
    }
    let position = from;
    const write = () => {
      if (res.destroyed) return;
      while (position <= to) {
        const next = Math.min(position + 65536, to + 1);
        const chunk = payload.subarray(position, next);
        position = next;
        if (!res.write(chunk)) {
          res.once('drain', write);
          return;
        }
      }
      res.end();
    };
    write();
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  let proxy;
  const sockets = new Set();
  if (proxied) {
    proxy = http.createServer();
    proxy.on('connect', (req, client, head) => {
      const port = Number(req.url.slice(req.url.lastIndexOf(':') + 1));
      const remote = net.connect(port, '127.0.0.1');
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
  const client = createHttpClient({
    allowPrivate: true,
    dnsOverHttpsUrl: '',
    ...transport,
    bodyTimeout: 200,
    getProxySettings: () =>
      proxied ? { enabled: true, url: `http://127.0.0.1:${proxy.address().port}` } : null,
  });
  t.after(async () => {
    await client.close();
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections?.();
    await new Promise((resolve) => origin.close(resolve));
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
  });
  return {
    client,
    protocols,
    url: `https://localhost:${origin.address().port}`,
  };
}

test('ordinary HTTP clients can still negotiate HTTP/2', async (t) => {
  const f = await fixture(t, false, {});
  const { response } = await f.client.request(`${f.url}/video`, {
    headers: { range: 'bytes=0-65535' },
  });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(0, 65536));
  assert.deepEqual(f.protocols, ['2.0']);
});

for (const proxied of [false, true]) {
  test(
    `video ranges survive reader backpressure and cancelled seeks (${proxied ? 'proxy' : 'direct'})`,
    { timeout: 8000 },
    async (t) => {
      const f = await fixture(t, proxied);
      const { response } = await f.client.request(`${f.url}/video`, {
        headers: { range: 'bytes=0-' },
      });
      const reader = response.body.getReader();
      const chunks = [(await reader.read()).value];
      // A paused browser stops pulling. Bytes remain available at the origin;
      // this must not be treated as an upstream body timeout.
      await delay(650);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      assert.deepEqual(Buffer.concat(chunks), payload);
      const abandoned = await f.client.request(`${f.url}/video`, {
        headers: { range: 'bytes=4194304-' },
      });
      const pending = abandoned.response.body.getReader();
      await pending.read();
      await pending.cancel();
      for (const start of [8388608, 1048576, 12582912]) {
        const end = start + 65535;
        const seek = await f.client.request(`${f.url}/video`, {
          headers: { range: `bytes=${start}-${end}` },
        });
        assert.equal(
          seek.response.headers.get('content-range'),
          `bytes ${start}-${end}/${payload.length}`,
        );
        assert.deepEqual(
          Buffer.from(await seek.response.arrayBuffer()),
          payload.subarray(start, end + 1),
        );
      }
      assert.ok(f.protocols.every((version) => version === '1.1'));
    },
  );

  test(
    `video transport still times out when an actively read origin stops sending (${proxied ? 'proxy' : 'direct'})`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t, proxied);
      const { response } = await f.client.request(`${f.url}/idle`, {
        headers: { range: 'bytes=0-31' },
      });
      const reader = response.body.getReader();
      assert.equal((await reader.read()).value.length, 1);
      await assert.rejects(reader.read(), (error) => error.cause?.code === 'UND_ERR_BODY_TIMEOUT');
    },
  );
}
