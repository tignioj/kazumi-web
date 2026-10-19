import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHttpClient } from '../../server/lib/http.js';

test('bad target certificates are allowed only on proxy routes, including redirects and settings changes', async (t) => {
  const origin = https.createServer(
    {
      cert: await readFile(new URL('../fixtures/network/localhost-cert.pem', import.meta.url)),
      key: await readFile(new URL('../fixtures/network/localhost-key.pem', import.meta.url)),
    },
    (request, response) => {
      if (request.url === '/redirect') {
        response
          .writeHead(302, {
            location: `https://127.0.0.1:${origin.address().port}/done`,
          })
          .end();
      } else response.end('proxied TLS');
    },
  );
  const sockets = new Set();
  const proxy = http.createServer();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };
  proxy.on('connect', (request, client, head) => {
    track(client);
    const remote = track(net.connect({ host: '127.0.0.1', port: origin.address().port }));
    client.once('close', () => remote.destroy());
    remote.once('close', () => client.destroy());
    remote.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    });
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  let enabled = false;
  const client = createHttpClient({
    allowPrivate: true,
    dnsOverHttpsUrl: '',
    resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    getProxySettings: (url) => ({
      enabled: enabled && new URL(url).hostname === 'localhost',
      url: `http://127.0.0.1:${proxy.address().port}`,
    }),
  });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => origin.close(resolve)),
    ]);
  });
  const url = `https://localhost:${origin.address().port}`;
  await assert.rejects(client.request(url), /DEPTH_ZERO_SELF_SIGNED_CERT/);
  enabled = true;
  assert.equal(await (await client.request(url)).response.text(), 'proxied TLS');
  await assert.rejects(client.request(`${url}/redirect`), /DEPTH_ZERO_SELF_SIGNED_CERT/);
  const concurrent = await Promise.allSettled([
    client.request(url).then(({ response }) => response.text()),
    client.request(`https://127.0.0.1:${origin.address().port}/`),
  ]);
  assert.equal(concurrent[0].status, 'fulfilled');
  assert.equal(concurrent[1].status, 'rejected');
  enabled = false;
  await assert.rejects(client.request(url), /DEPTH_ZERO_SELF_SIGNED_CERT/);
});
