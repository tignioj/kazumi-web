import http from 'node:http';
import net from 'node:net';
import { checkedUrl, createSafeLookup, HttpError } from './http.js';

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const value of String(headers.connection || '').split(',')) {
    blocked.add(value.trim().toLowerCase());
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => !blocked.has(key.toLowerCase()) && !/^proxy-/i.test(key),
    ),
  );
}

function connectUrl(authority, allowPrivate) {
  // URL accepts paths, userinfo and omitted ports; CONNECT accepts only host:port.
  if (!/^(?:\[[\da-f:.]+\]|[^\s/:?#@%]+):\d{1,5}$/i.test(authority))
    throw new HttpError('CONNECT 目标无效');
  const port = Number(authority.slice(authority.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) throw new HttpError('CONNECT 端口无效');
  return checkedUrl(`https://${authority}`, { allowPrivate });
}

function errorStatus(error) {
  return error instanceof HttpError && [400, 403].includes(error.status) ? error.status : 502;
}

/**
 * A loopback proxy for Chromium. All sockets use checked DNS answers directly;
 * browser DNS resolution never decides the address used by an outbound socket.
 * TLS remains end-to-end through CONNECT. Browser code must block WebSockets
 * itself, since an encrypted Upgrade request is opaque to this proxy.
 */
export async function createBrowserEgress({
  allowPrivate = false,
  dnsOverHttpsUrl = process.env.DNS_OVER_HTTPS_URL,
  resolver,
  timeout = 30000,
  tunnelTimeout = 60000,
  maxConnections = 128,
} = {}) {
  const dns = createSafeLookup({ allowPrivate, dnsOverHttpsUrl, resolver });
  const sockets = new Set();
  const agent = new http.Agent({ keepAlive: false, lookup: dns.lookup, maxSockets: 64 });
  let closing = false;
  let closed;
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = http.createServer((request, response) => {
    let url;
    try {
      url = checkedUrl(request.url, { allowPrivate });
      if (url.protocol !== 'http:') throw new HttpError('HTTPS 请求必须使用 CONNECT');
      if (closing) throw new HttpError('解析器已关闭', 503);
    } catch (error) {
      response.writeHead(errorStatus(error), { connection: 'close' }).end();
      request.resume();
      return;
    }
    const headers = forwardHeaders(request.headers);
    headers.host = url.host;
    const upstream = http.request(url, {
      method: request.method,
      headers,
      agent,
      lookup: dns.lookup,
      autoSelectFamily: false,
    });
    const timer = setTimeout(() => upstream.destroy(new Error('Proxy request timed out')), timeout);
    timer.unref();
    const stop = () => {
      clearTimeout(timer);
      upstream.destroy();
    };
    response.once('close', stop);
    request.once('aborted', stop);
    request.once('error', stop);
    upstream.once('socket', track);
    upstream.once('response', (incoming) => {
      response.writeHead(incoming.statusCode, forwardHeaders(incoming.headers));
      incoming.once('error', () => response.destroy());
      incoming.pipe(response);
    });
    upstream.once('error', (error) => {
      clearTimeout(timer);
      if (!response.headersSent) response.writeHead(errorStatus(error), { connection: 'close' });
      response.end();
    });
    request.pipe(upstream);
  });
  server.requestTimeout = timeout;
  server.headersTimeout = Math.min(timeout, 10000);
  server.keepAliveTimeout = 1000;
  server.maxConnections = maxConnections;
  server.on('connection', (socket) => {
    track(socket);
    socket.on('error', () => {});
    socket.setTimeout(timeout, () => socket.destroy());
    if (closing) socket.destroy();
  });
  server.on('connect', (request, client, head) => {
    let target;
    try {
      target = connectUrl(request.url, allowPrivate);
      if (closing) throw new HttpError('解析器已关闭', 503);
    } catch (error) {
      client.end(`HTTP/1.1 ${errorStatus(error)} Rejected\r\nConnection: close\r\n\r\n`);
      return;
    }
    const remote = track(
      net.connect({
        host: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port) || 443,
        lookup: dns.lookup,
        autoSelectFamily: false,
      }),
    );
    let connected = false;
    const timer = setTimeout(
      () => remote.destroy(new Error('Proxy tunnel timed out')),
      tunnelTimeout,
    );
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      remote.destroy();
      client.destroy();
    };
    remote.setTimeout(timeout, () => remote.destroy(new Error('Proxy tunnel idle timeout')));
    client.once('close', cleanup);
    remote.once('close', () => {
      clearTimeout(timer);
      // Let buffered upstream bytes flush when the server closes normally.
      if (connected) client.end();
    });
    remote.once('error', (error) => {
      clearTimeout(timer);
      if (connected) client.destroy();
      else client.end(`HTTP/1.1 ${errorStatus(error)} Rejected\r\nConnection: close\r\n\r\n`);
    });
    remote.once('connect', () => {
      if (client.destroyed) return remote.destroy();
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
  });
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    agent.destroy();
    await dns.close();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        const stopped = new Promise((resolve) => server.close(resolve));
        agent.destroy();
        for (const socket of sockets) socket.destroy();
        await Promise.all([stopped, dns.close()]);
      })();
      return closed;
    },
  };
}
