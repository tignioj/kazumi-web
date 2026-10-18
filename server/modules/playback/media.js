import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JSDOM } from 'jsdom';
import { HttpError, checkedUrl, readLimited } from '../../lib/http.js';
import { absoluteUrl, ruleHeaders } from '../rules/engine.js';
import { jsonObjectAt } from './player-json.js';
import { legacyIframeMedia } from './legacy-parser.js';
import { filterHlsAds } from './hls-ad-filter.js';
import { resolveHhjx } from './adapters/hhjx.js';
import { resolveSevenSefun } from './adapters/sevensefun.js';
import { headersForSession, MediaSessionStore } from './session-store.js';

export function mediaType(url) {
  // An HTML parser's query or fragment can contain a media URL of its own.
  const path = url.split(/[?#]/, 1)[0];
  if (/\.m3u8$/i.test(path)) return 'hls';
  if (/\.(?:mp4|m4v|webm|mov|mp3|m4a|ogg|ogv)$/i.test(path)) return 'video';
  return null;
}

export function extractMedia(html, pageUrl, { useLegacyParser = false } = {}) {
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    if (useLegacyParser) {
      for (const iframe of document.querySelectorAll('iframe[src]')) {
        const media = legacyIframeMedia(iframe.getAttribute('src'), pageUrl);
        if (media) return { ...media, legacy: true };
      }
    }
    for (const node of document.querySelectorAll(
      'video[src],video source[src],audio[src],audio source[src]',
    )) {
      const url = absoluteUrl(node.getAttribute('src'), pageUrl);
      if (url)
        return {
          type: /mpegurl/i.test(node.getAttribute('type') || '')
            ? 'hls'
            : mediaType(url) || 'video',
          url,
        };
    }
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      const patterns = /(?:player_[A-Za-z0-9_]+|playerConfig|player_data)\s*=\s*\{/g;
      for (const match of text.matchAll(patterns)) {
        const data = jsonObjectAt(text, match.index + match[0].lastIndexOf('{'));
        if (!data || typeof data.url !== 'string') continue;
        let raw = data.url;
        try {
          if (Number(data.encrypt) === 2) raw = Buffer.from(raw, 'base64').toString('utf8');
          if ([1, 2].includes(Number(data.encrypt))) raw = decodeURIComponent(raw);
        } catch {
          continue;
        }
        // Player identifiers (ali_*, Doki-*, etc.) are inputs to the site's
        // parser, not relative web pages. Keep the original page for sniffing.
        if (!/^(?:(?:https?:)?\/\/|\/|\.\.?\/)/i.test(raw) && !mediaType(raw)) continue;
        const url = absoluteUrl(raw, pageUrl);
        if (url) {
          const type = mediaType(url) || (/m3u8|hls/i.test(data.from || '') ? 'hls' : 'iframe');
          return {
            type,
            url,
            ...(type === 'iframe' ? { browserUrl: url } : {}),
          };
        }
      }
      // Recognize literal media URLs without executing any source JavaScript.
      const literal =
        /["']((?:https?:)?(?:\\?\/){2}[^"'\s<>]+?\.(?:m3u8|mp4|webm)(?:\?[^"'\s<>]*)?)["']/i.exec(
          text,
        )?.[1];
      if (literal) {
        const url = absoluteUrl(literal.replace(/\\\//g, '/').replaceAll('&amp;', '&'), pageUrl);
        if (url) return { type: mediaType(url), url };
      }
    }
    const iframe = document.querySelector('iframe[src]');
    const url = iframe && absoluteUrl(iframe.getAttribute('src'), pageUrl);
    return url ? { type: 'iframe', url } : null;
  } finally {
    dom.window.close();
  }
}

export function rewritePlaylist(text, playlistUrl, makeUrl) {
  if (!text.trimStart().startsWith('#EXTM3U'))
    throw new HttpError('上游返回的播放列表格式无效', 502);
  let nextIsPlaylist = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.trimStart().startsWith('#')) {
        // Includes EXT-X-KEY, MAP, MEDIA, I-FRAME-STREAM-INF and LL-HLS tags.
        if (/^#EXT-X-STREAM-INF:/i.test(line.trim())) nextIsPlaylist = true;
        const isChildPlaylist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/i.test(
          line.trim(),
        );
        return line.replace(
          /URI="([^"]+)"/g,
          (_, uri) =>
            `URI="${makeUrl(new URL(uri, playlistUrl).href, isChildPlaylist ? 'hls' : undefined)}"`,
        );
      }
      const kind = nextIsPlaylist ? 'hls' : undefined;
      nextIsPlaylist = false;
      return makeUrl(new URL(line.trim(), playlistUrl).href, kind);
    })
    .join('\n');
}

export class MediaService {
  constructor(
    http,
    secret = process.env.MEDIA_SECRET || randomBytes(32).toString('hex'),
    { browserResolver, sessionOptions } = {},
  ) {
    this.http = http;
    this.secret = secret;
    this.browserResolver = browserResolver;
    this.sessions = new MediaSessionStore(sessionOptions);
  }
  signature(value) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
  proxyUrl(
    url,
    headers,
    expires = Math.floor(Date.now() / 1000) + 24 * 3600,
    kind,
    sessionId,
    adBlocker = false,
  ) {
    checkedUrl(url, { allowPrivate: this.http.allowPrivate });
    const data = sessionId ? { url, sessionId, expires, kind } : { url, headers, expires, kind };
    if (adBlocker) data.adBlocker = true;
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `/api/media?payload=${payload}&signature=${this.signature(payload)}`;
  }
  verify(payload, signature) {
    if (
      typeof payload !== 'string' ||
      payload.length > 24000 ||
      typeof signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw new HttpError('媒体代理链接无效', 403);
    if (!timingSafeEqual(Buffer.from(this.signature(payload)), Buffer.from(signature)))
      throw new HttpError('媒体代理签名无效', 403);
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      throw new HttpError('媒体代理链接无效', 403);
    }
    if (!Number.isFinite(data.expires) || data.expires < Date.now() / 1000)
      throw new HttpError('播放链接已过期，请重新打开剧集', 403);
    return data;
  }
  async resolve(rule, source, { signal, onVerification, sessionOwner } = {}) {
    const originalUrl = absoluteUrl(source, rule.baseURL);
    if (!originalUrl) throw new HttpError('播放地址无效');
    checkedUrl(originalUrl, { allowPrivate: this.http.allowPrivate });
    signal?.throwIfAborted();
    let playbackUrl;
    try {
      const result = await this.resolveStatic(rule, originalUrl, signal, sessionOwner);
      if (result.type !== 'iframe') {
        const restored = this.browserResolver?.mediaSession?.(
          rule,
          result.url,
          result.headers,
          sessionOwner,
        );
        if (this.browserResolver?.validate) {
          // A literal <video src> can still depend on cookies created by page
          // scripts. Only keep the fast path when the proxy can fetch its media.
          const controller = new AbortController();
          const deadline = setTimeout(() => controller.abort(), 5000);
          const probeSignal = signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal;
          try {
            const type = await this.browserResolver.validate(
              { url: result.url, type: result.type },
              {
                ...(restored || {
                  url: result.url,
                  headers: result.headers,
                  cookies: [],
                  requestHeaders: [],
                }),
                adBlocker: rule.adBlocker === true,
              },
              probeSignal,
            );
            if (['hls', 'video'].includes(type)) result.type = type;
          } catch (error) {
            signal?.throwIfAborted();
            if (controller.signal.aborted) throw new HttpError('媒体预检超时', 504);
            throw error;
          } finally {
            clearTimeout(deadline);
          }
        }
        signal?.throwIfAborted();
        const session = restored ? this.sessions.create(restored) : null;
        return {
          type: result.type,
          url: this.proxyUrl(
            result.url,
            session ? undefined : result.headers,
            session?.expires,
            result.type,
            session?.sessionId,
            rule.adBlocker === true,
          ),
          originalUrl,
        };
      }
      if (!this.browserResolver) return result;
      playbackUrl = result.browserUrl;
    } catch (error) {
      // Private-network/URL validation failures are never retried in a browser.
      // HTTP upstream status codes are wrapped as 502 by the static resolver.
      signal?.throwIfAborted();
      if (!this.browserResolver || ![422, 502, 504].includes(error.status)) throw error;
    }
    signal?.throwIfAborted();
    const result = await this.browserResolver.resolve(rule, originalUrl, {
      signal,
      ...(playbackUrl && playbackUrl !== originalUrl ? { playbackUrl } : {}),
      ...(onVerification ? { onVerification } : {}),
      ...(sessionOwner !== undefined ? { sessionOwner } : {}),
    });
    signal?.throwIfAborted();
    if (!result || !['hls', 'video'].includes(result.type))
      throw new HttpError('动态解析未找到可播放的视频', 422);
    checkedUrl(result.url, { allowPrivate: this.http.allowPrivate });
    for (const entry of result.requestHeaders || [])
      checkedUrl(entry.url, { allowPrivate: this.http.allowPrivate });
    const session = this.sessions.create(result);
    return {
      type: result.type,
      url: this.proxyUrl(
        result.url,
        undefined,
        session.expires,
        result.type,
        session.sessionId,
        rule.adBlocker === true,
      ),
      originalUrl,
    };
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
  close() {
    this.sessions.close();
  }
  async proxy(req, res) {
    const data = this.verify(req.query.payload, req.query.signature);
    checkedUrl(data.url, { allowPrivate: this.http.allowPrivate });
    const session = data.sessionId ? this.sessions.get(data.sessionId) : null;
    const controller = new AbortController();
    // Only bound time to response headers; long video streams must not stop at
    // an absolute deadline. Undici enforces an idle body timeout separately.
    const deadline = setTimeout(() => controller.abort(), 20000);
    req.on('aborted', () => controller.abort());
    res.on('close', () => {
      clearTimeout(deadline);
      if (!res.writableEnded) controller.abort();
    });
    try {
      const headers = session ? headersForSession(session, data.url) : { ...data.headers };
      if (req.headers.range) headers.range = req.headers.range;
      const { response, url } = await this.http.request(data.url, {
        headers,
        ...(session && {
          headersForUrl: (target) => ({
            ...headersForSession(session, target),
            ...(req.headers.range && { range: req.headers.range }),
          }),
        }),
        signal: controller.signal,
      });
      clearTimeout(deadline);
      if (![200, 206, 416].includes(response.status)) {
        await response.body?.cancel();
        throw new HttpError(`媒体服务器返回 HTTP ${response.status}`, 502);
      }
      const contentType = response.headers.get('content-type') || '';
      const isPlaylist =
        data.kind === 'hls' || mediaType(url) === 'hls' || /mpegurl/i.test(contentType);
      if (isPlaylist) {
        const raw = await readLimited(response, 2 * 1024 * 1024);
        const playlist = rewritePlaylist(
          data.adBlocker ? filterHlsAds(raw) : raw,
          url,
          (target, kind) =>
            this.proxyUrl(target, data.headers, data.expires, kind, data.sessionId, data.adBlocker),
        );
        res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(playlist);
        return;
      }
      if (/text\/html|application\/(?:json|javascript|xhtml)|image\/svg/i.test(contentType)) {
        await response.body?.cancel();
        throw new HttpError('媒体服务器返回了网页，无法直接播放', 422);
      }
      res.status(response.status);
      res.set(
        'Content-Type',
        /^(?:video|audio)\//i.test(contentType) ? contentType : 'application/octet-stream',
      );
      res.set('Cache-Control', 'private, max-age=60');
      for (const name of ['content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = response.headers.get(name);
        if (value) res.set(name, value);
      }
      if (!response.headers.get('content-encoding') && response.headers.get('content-length'))
        res.set('Content-Length', response.headers.get('content-length'));
      if (req.method === 'HEAD') {
        await response.body?.cancel();
        res.end();
        return;
      }
      await pipeline(Readable.fromWeb(response.body), res);
    } finally {
      clearTimeout(deadline);
    }
  }
}
