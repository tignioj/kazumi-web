import { HttpError, checkedUrl, readLimited } from '../../lib/http.js';
import { ruleHeaders, absoluteUrl } from '../rules/engine.js';
import { extractMedia, mediaType } from './extract-media.js';
import { resolveHhjx } from './adapters/hhjx.js';
import { resolveSevenSefun } from './adapters/sevensefun.js';

// Resolve pages locally; only dynamic players and challenges need Chromium.
export class LocalSourceResolver {
  constructor(http, { browserResolver } = {}) {
    this.http = http;
    this.browserResolver = browserResolver;
  }
  async resolve(rule, source, options = {}) {
    const { signal, sessionOwner } = options;
    const originalUrl = absoluteUrl(source, rule.baseURL);
    if (!originalUrl) throw new HttpError('播放地址无效');
    checkedUrl(originalUrl, { allowPrivate: this.http.allowPrivate });
    signal?.throwIfAborted();
    let playbackUrl;
    try {
      const result = await this.resolveStatic(rule, originalUrl, signal, sessionOwner);
      if (result.type !== 'iframe') {
        const session = this.browserResolver?.mediaSession?.(
          rule,
          result.url,
          result.headers,
          sessionOwner,
        ) || { url: result.url, headers: result.headers, cookies: [], requestHeaders: [] };
        if (this.browserResolver?.validate) {
          const probeSignal = AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(5000),
          ]);
          result.type = await this.browserResolver.validate(
            result,
            { ...session, adBlocker: rule.adBlocker === true },
            probeSignal,
          );
        }
        signal?.throwIfAborted();
        return { ...result, ...session, type: result.type };
      }
      playbackUrl = result.browserUrl;
    } catch (error) {
      signal?.throwIfAborted();
      if (!this.browserResolver || ![422, 502, 504].includes(error.status)) throw error;
    }
    if (!this.browserResolver) throw new HttpError('此来源需要动态解析，请安装 Chromium', 422);
    return this.browserResolver.resolve(rule, originalUrl, {
      ...options,
      ...(playbackUrl && { playbackUrl }),
    });
  }
  async resolveStatic(rule, originalUrl, signal, sessionOwner) {
    let headers = ruleHeaders(rule);
    let url = originalUrl;
    let fallback = originalUrl;
    let browserUrl;
    const visited = new Set();
    for (let depth = 0; depth < 4; depth++) {
      signal?.throwIfAborted();
      checkedUrl(url, { allowPrivate: this.http.allowPrivate });
      const type = mediaType(url);
      if (type) return { type, url, headers, originalUrl };
      if (visited.has(url)) break;
      visited.add(url);
      let result;
      try {
        result = await this.http.request(url, {
          ...(this.browserResolver?.requestOptions?.(rule, url, headers, sessionOwner) || {
            headers,
          }),
          signal,
        });
        signal?.throwIfAborted();
      } catch (error) {
        if (signal?.aborted || depth === 0 || error.status === 403) throw error;
        break;
      }
      const response = result.response;
      if (!response.ok) {
        await response.body?.cancel();
        if (depth === 0) throw new HttpError(`来源返回 HTTP ${response.status}`, 502);
        break;
      }
      const contentType = response.headers.get('content-type') || '';
      if (/mpegurl|^video\/|^audio\//i.test(contentType)) {
        await response.body?.cancel();
        const kind = /mpegurl/i.test(contentType) ? 'hls' : 'video';
        return {
          type: kind,
          url: result.url,
          headers,
          originalUrl,
        };
      }
      const raw = await readLimited(response);
      if (raw.trimStart().startsWith('#EXTM3U'))
        return {
          type: 'hls',
          url: result.url,
          headers,
          originalUrl,
        };
      const dynamic = await resolveHhjx(this.http, raw, result.url, headers, { signal });
      signal?.throwIfAborted();
      if (dynamic)
        return {
          type: dynamic.type,
          url: dynamic.url,
          headers: dynamic.headers,
          originalUrl,
        };
      const playerPage = await resolveSevenSefun(this.http, raw, result.url, headers, { signal });
      signal?.throwIfAborted();
      if (playerPage) {
        checkedUrl(playerPage.url, { allowPrivate: this.http.allowPrivate });
        url = playerPage.url;
        headers = playerPage.headers;
        continue;
      }
      const extracted = extractMedia(raw, result.url, rule);
      if (!extracted) break;
      checkedUrl(extracted.url, { allowPrivate: this.http.allowPrivate });
      if (extracted.type !== 'iframe')
        return {
          ...extracted,
          headers:
            extracted.legacy && !rule.referer
              ? Object.fromEntries(
                  Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'referer'),
                )
              : headers,
          originalUrl,
        };
      fallback = extracted.url;
      if (extracted.browserUrl) browserUrl = extracted.browserUrl;
      url = extracted.url;
    }
    return { type: 'iframe', url: fallback, originalUrl, ...(browserUrl && { browserUrl }) };
  }
}
