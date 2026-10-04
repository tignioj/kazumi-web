import dns from 'node:dns';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';

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
      const url = new URL(base);
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
      const data = JSON.parse(await readLimited(response, 65536));
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
  dnsOverHttpsUrl = process.env.DNS_OVER_HTTPS_URL,
} = {}) {
  const dnsLookup = createSafeLookup({ allowPrivate, dnsOverHttpsUrl });
  const dispatcher = new Agent({
    connect: { lookup: dnsLookup.lookup, timeout: 15000 },
    headersTimeout: timeout,
    bodyTimeout: 60000,
  });
  async function request(input, options = {}) {
    let url = checkedUrl(input, { allowPrivate });
    let method = options.method || 'GET';
    let body = options.body;
    let headers = cleanHeaders(options.headers);
    let dropContentType = false;
    for (let redirects = 0; redirects <= 5; redirects++) {
      // Session-aware callers select cookies for every URL, including a
      // redirect to another path on the same origin. The callback returns the
      // complete header set, preserving Range and other caller headers itself.
      if (options.headersForUrl) headers = cleanHeaders(await options.headersForUrl(url.href));
      if (dropContentType) delete headers['content-type'];
      let response;
      try {
        response = await fetch(url, {
          dispatcher,
          method,
          body,
          headers,
          redirect: 'manual',
          signal: options.signal || AbortSignal.timeout(options.timeout || timeout),
        });
      } catch (error) {
        if (error.cause instanceof HttpError) throw error.cause;
        throw new HttpError(
          error.name === 'TimeoutError'
            ? '上游请求超时'
            : `无法连接上游站点: ${error.cause?.code || error.message}`,
          502,
        );
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
      return { response, url: url.href };
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
    close: () => Promise.all([dispatcher.close(), dnsLookup.close()]),
    allowPrivate,
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
