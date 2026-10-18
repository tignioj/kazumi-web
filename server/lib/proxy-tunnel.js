import net from 'node:net';
import { once } from 'node:events';
import { Pool } from 'undici';
import { SocksClient } from 'socks';

// Resolve and validate the destination before handing its IP to the proxy. The
// proxy endpoint itself is administrator configured and may be on the LAN.
export function createProxyTunnels({ lookup, timeout = 15000 } = {}) {
  const pools = new Map();
  const sockets = new Set();
  let closed = false;
  const track = (socket) => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  return {
    async connect(settings, hostname, port) {
      if (closed) throw new Error('代理连接已关闭');
      const address = net.isIP(hostname)
        ? hostname
        : await new Promise((resolve, reject) => {
            lookup(hostname, {}, (error, address) => (error ? reject(error) : resolve(address)));
          });
      if (closed) throw new Error('代理连接已关闭');
      const proxy = new URL(settings.url);
      let socket;
      if (proxy.protocol === 'socks5:') {
        socket = track(
          net.connect({
            host: proxy.hostname.replace(/^\[|\]$/g, ''),
            port: Number(proxy.port) || 1080,
          }),
        );
        socket.setTimeout(timeout, () => socket.destroy(new Error('代理连接超时')));
        await once(socket, 'connect');
        socket.setTimeout(0);
        ({ socket } = await SocksClient.createConnection({
          command: 'connect',
          existing_socket: socket,
          proxy: {
            host: proxy.hostname.replace(/^\[|\]$/g, ''),
            port: Number(proxy.port) || 1080,
            type: 5,
            userId: settings.username,
            password: settings.password,
          },
          destination: { host: address, port: Number(port) },
          timeout,
        }));
      } else {
        let pool = pools.get(proxy.origin);
        if (!pool) {
          pool = new Pool(proxy.origin, { connectTimeout: timeout, allowH2: false });
          pools.set(proxy.origin, pool);
        }
        const authority = `${net.isIPv6(address) ? `[${address}]` : address}:${port}`;
        const headers = { host: authority };
        if (settings.username)
          headers['proxy-authorization'] = `Basic ${Buffer.from(
            `${settings.username}:${settings.password}`,
          ).toString('base64')}`;
        const result = await pool.connect({
          path: authority,
          headers,
          signal: AbortSignal.timeout(timeout),
        });
        socket = result.socket;
        if (result.statusCode !== 200) {
          socket.on('error', () => {}).destroy();
          throw Object.assign(
            new Error(
              result.statusCode === 407
                ? '代理认证失败，请检查用户名和密码'
                : `代理返回 HTTP ${result.statusCode}`,
            ),
            { code: result.statusCode === 407 ? 'PROXY_AUTH_FAILED' : 'PROXY_CONNECT_FAILED' },
          );
        }
      }
      if (closed) {
        socket.destroy();
        throw new Error('代理连接已关闭');
      }
      if (!sockets.has(socket)) track(socket);
      return socket;
    },
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy(new Error('代理连接已关闭'));
      await Promise.all([...pools.values()].map((pool) => pool.destroy()));
    },
  };
}
