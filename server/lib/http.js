import dns from 'node:dns';
import { Agent, buildConnector, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { createEchTransport, isEchTarget } from './ech.js';
import { createProxyTunnels } from './proxy-tunnel.js';
import { DEFAULT_NETWORK_SETTINGS } from '../../shared/network-settings.js';

export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const USER_AGENT = 'KazumiWeb/1.0 (self-hosted; https://github.com/Predidit/Kazumi)';

export function isPublicAddress(address) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}

export function checkedUrl(value, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new HttpError('仅支持不含凭据的 HTTP/HTTPS URL');
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    !allowPrivate &&
    (host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      (ipaddr.isValid(host) && !isPublicAddress(host)))
  ) {
    throw new HttpError('不允许访问本机或私有网络地址', 403);
  }
  return url;
}

function safeLookup(allowPrivate, resolver) {
  return (hostname, options, callback) => {
    const finish = (error, addresses) => {
      if (error) return callback(error);
      if (
        !addresses.length ||
        (!allowPrivate && addresses.some(({ address }) => !isPublicAddress(address)))
      )
        return callback(new HttpError('域名解析到私有或保留网络地址', 403));
      // Pass the validated address directly to the socket. Never resolve it again.
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    };
    if (resolver)
      resolver(hostname, options.family).then((addresses) => finish(null, addresses), finish);
    else dns.lookup(hostname, { all: true, verbatim: true }, finish);
  };
}

async function queryDnsOverHttps(endpoint, dispatcher, hostname, type) {
  const url = checkedUrl(endpoint);
  if (url.protocol !== 'https:') throw new HttpError('DNS_OVER_HTTPS_URL 必须使用 HTTPS');
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', type);
  const response = await fetch(url, {
    dispatcher,
    headers: { accept: 'application/dns-json' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError('安全 DNS 解析服务不可用', 502);
  }
  return JSON.parse(await readLimited(response, 65536));
}

function dnsOverHttps(endpoint, dispatcher) {
  const base = checkedUrl(endpoint);
  if (base.protocol !== 'https:') throw new HttpError('DNS_OVER_HTTPS_URL 必须使用 HTTPS');
  const cache = new Map();
  return async (hostname, family) => {
    const cacheKey = `${hostname}:${family || 4}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.addresses;
    let addresses = [],
      ttl = 60;
    for (const type of family === 6 ? ['AAAA'] : ['A', 'AAAA']) {
      const data = await queryDnsOverHttps(base, dispatcher, hostname, type);
      const answers = (data.Answer || []).filter((answer) => [1, 28].includes(answer.type));
      addresses = answers.map((answer) => ({
        address: answer.data,
        family: answer.type === 1 ? 4 : 6,
      }));
      // DNS TTL is capped so changes are picked up promptly and memory stays bounded.
      ttl = Math.max(5, Math.min(300, ...answers.map((answer) => Number(answer.TTL) || 60)));
      if (addresses.length) break;
    }
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
      throw new HttpError('安全 DNS 未返回有效公网地址', 403);
    cache.set(cacheKey, { addresses, expires: Date.now() + ttl * 1000 });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return addresses;
  };
}

// Own the DNS dispatcher alongside its lookup so socket clients share the same
// validation and DNS-over-HTTPS behavior without performing a second lookup.
export function createSafeLookup({ allowPrivate = false, dnsOverHttpsUrl, resolver } = {}) {
  const dispatcher = dnsOverHttpsUrl
    ? new Agent({ connect: { lookup: safeLookup(false), timeout: 8000 } })
    : null;
  const resolve = resolver || (dnsOverHttpsUrl ? dnsOverHttps(dnsOverHttpsUrl, dispatcher) : null);
  return {
    lookup: safeLookup(allowPrivate, resolve),
    close: () => dispatcher?.close() || Promise.resolve(),
  };
}

export function cleanHeaders(input = {}) {
  const result = { 'user-agent': USER_AGENT };
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (
      /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|forwarded|x-forwarded-.*|accept-encoding)$/.test(
        key,
      )
    )
      continue;
    if (value != null && !/[\r\n]/.test(String(value))) result[key] = String(value);
  }
  return result;
}

export function createHttpClient({
  allowPrivate = process.env.ALLOW_PRIVATE_NETWORK === 'true',
  timeout = 20000,
  bodyTimeout = 60000,
  allowH2 = true,
  dnsOverHttpsUrl = process.env.DNS_OVER_HTTPS_URL,
  bangumiEch = DEFAULT_NETWORK_SETTINGS.bangumiEch,
  echDohUrl = DEFAULT_NETWORK_SETTINGS.echDohUrl,
  echHelperPath,
  echTransport,
  getProxySettings = () => null,
  resolver,
} = {}) {
  const dnsLookup = createSafeLookup({ allowPrivate, dnsOverHttpsUrl, resolver });
  const dispatcher = new Agent({
    allowH2,
    connect: { lookup: dnsLookup.lookup, timeout: 15000 },
    headersTimeout: timeout,
    bodyTimeout,
  });
  let ech;
  const echChannels = new Set();
  function closeEch(channel) {
    channel.closing ||= (async () => {
      channel.transport.close();
      await Promise.all([channel.lookup?.close(), channel.bootstrap?.close()]);
    })().finally(() => echChannels.delete(channel));
    return channel.closing;
  }
  async function requestEch(url, options, settings) {
    if (echTransport) return echTransport.request(url, options);
    const endpoint = settings?.echDohUrl ?? echDohUrl;
    if (!ech || ech.endpoint !== endpoint) {
      const previous = ech;
      const lookup = createSafeLookup({ dnsOverHttpsUrl: endpoint });
      const bootstrap = new Agent({ connect: { lookup: safeLookup(false), timeout: 8000 } });
      ech = {
        endpoint,
        lookup,
        bootstrap,
        active: 0,
        transport: createEchTransport({
          lookup: lookup.lookup,
          binary: echHelperPath,
          queryConfig: () =>
            queryDnsOverHttps(endpoint, bootstrap, 'crypto.cloudflare.com', 'HTTPS'),
        }),
      };
      echChannels.add(ech);
      // A DNS setting change must let requests on the previous channel finish.
      if (previous && !previous.active) void closeEch(previous).catch(() => {});
    }
    const channel = ech;
    channel.active++;
    try {
      return await channel.transport.request(url, options);
    } finally {
      channel.active--;
      if (channel !== ech && !channel.active) void closeEch(channel).catch(() => {});
    }
  }
  const tunnels = createProxyTunnels({ lookup: dnsLookup.lookup });
  // Match Kazumi's proxy mode. Direct connections retain the default TLS checks.
  const tlsConnector = buildConnector({ timeout: 15000, rejectUnauthorized: false, allowH2 });
  const proxyDispatchers = new Map();
  const retiring = new Set();
  function requestDispatcher(settings) {
    if (!settings?.enabled) return dispatcher;
    const key = JSON.stringify([settings.url, settings.username, settings.password]);
    let selected = proxyDispatchers.get(key);
    if (selected) proxyDispatchers.delete(key);
    else {
      selected = new Agent({
        allowH2,
        headersTimeout: timeout,
        bodyTimeout,
        connect(options, callback) {
          const hostname = options.hostname.replace(/^\[|\]$/g, '');
          tunnels
            .connect(
              settings,
              hostname,
              Number(options.port) || (options.protocol === 'https:' ? 443 : 80),
            )
            .then(
              (socket) => {
                if (options.protocol !== 'https:') return callback(null, socket);
                tlsConnector({ ...options, httpSocket: socket }, (error, secure) => {
                  if (error) socket.destroy();
                  callback(error, secure);
                });
              },
              (error) => callback(error, null),
            );
        },
      });
    }
    proxyDispatchers.set(key, selected);
    if (proxyDispatchers.size > 32) {
      const [oldKey, old] = proxyDispatchers.entries().next().value;
      proxyDispatchers.delete(oldKey);
      const closing = old.close().catch(() => {});
      retiring.add(closing);
      void closing.finally(() => retiring.delete(closing));
    }
    return selected;
  }
  async function request(input, options = {}) {
    let url = checkedUrl(input, { allowPrivate });
    let method = options.method || 'GET';
    let body = options.body;
    let headers = cleanHeaders(options.headers);
    let dropContentType = false;
    for (let redirects = 0; redirects <= 5; redirects++) {
      options.validateUrl?.(url.href);
      const proxy = getProxySettings(url.href);
      const activeDispatcher = requestDispatcher(proxy);
      // Session-aware callers select cookies for every URL, including a
      // redirect to another path on the same origin. The callback returns the
      // complete header set, preserving Range and other caller headers itself.
      if (options.headersForUrl) headers = cleanHeaders(await options.headersForUrl(url.href));
      if (dropContentType) delete headers['content-type'];
      let response;
      const usingEch =
        !proxy?.enabled && (options.ech ?? proxy?.bangumiEch ?? bangumiEch) && isEchTarget(url);
      try {
        response = await (usingEch
          ? requestEch(
              url,
              {
                method,
                body,
                headers,
                timeout: options.timeout || timeout,
                signal: options.signal || AbortSignal.timeout(options.timeout || timeout),
              },
              proxy,
            )
          : fetch(url, {
              dispatcher: activeDispatcher,
              method,
              body,
              headers,
              redirect: 'manual',
              signal: options.signal || AbortSignal.timeout(options.timeout || timeout),
            }));
      } catch (error) {
        if (error.cause instanceof HttpError) throw error.cause;
        const failure = new HttpError(
          error.name === 'TimeoutError'
            ? '上游请求超时'
            : error.cause?.code === 'PROXY_AUTH_FAILED'
              ? '代理连接失败：代理认证失败，请检查用户名和密码'
              : `${usingEch ? 'ECH 连接失败' : proxy?.enabled ? '代理连接失败' : '无法连接上游站点'}: ${error.cause?.code || error.message}`,
          502,
        );
        if (usingEch) failure.echAccepted = error.echAccepted === true;
        failure.routing = proxy?.routing;
        throw failure;
      }
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        await response.body?.cancel();
        const next = checkedUrl(new URL(response.headers.get('location'), url).href, {
          allowPrivate,
        });
        if (next.origin !== url.origin) {
          headers = { ...headers };
          delete headers.authorization;
          delete headers.cookie;
        }
        if (
          response.status === 303 ||
          ([301, 302].includes(response.status) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
          dropContentType = true;
          delete headers['content-type'];
        }
        url = next;
        continue;
      }
      return {
        response,
        url: url.href,
        routing: proxy?.routing,
        ...(usingEch && { echAccepted: true }),
      };
    }
    throw new HttpError('上游重定向次数过多', 502);
  }
  async function text(url, options = {}) {
    const result = await request(url, options);
    if (!result.response.ok) {
      await result.response.body?.cancel();
      throw new HttpError(`上游返回 HTTP ${result.response.status}`, 502);
    }
    return {
      text: await readLimited(result.response, options.maxBytes),
      url: result.url,
      response: result.response,
    };
  }
  async function json(url, options) {
    const result = await text(url, options);
    try {
      return JSON.parse(result.text);
    } catch {
      throw new HttpError('上游未返回有效 JSON', 502);
    }
  }
  return {
    request,
    text,
    json,
    close: async () => {
      echTransport?.close();
      await Promise.all([
        dispatcher.close(),
        ...[...proxyDispatchers.values()].map((client) => client.close()),
        ...retiring,
        dnsLookup.close(),
        ...[...echChannels].map(closeEch),
      ]);
      await tunnels.close();
    },
    allowPrivate,
    getProxySettings,
  };
}

export async function readLimited(response, maxBytes = 5 * 1024 * 1024) {
  if (!response.body) return '';
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new HttpError('上游响应过大', 502);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError('上游响应过大', 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  const charset =
    /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers.get('content-type') || '')?.[1] ||
    'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}
