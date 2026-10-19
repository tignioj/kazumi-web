import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, checkedUrl, readLimited } from '../../lib/http.js';
import { LocalSourceResolver } from './source-resolver.js';
import { mediaType } from './extract-media.js';
import { headersForSession, MediaSessionStore } from './session-store.js';

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
    { resolver, browserResolver, sessionOptions } = {},
  ) {
    this.http = http;
    this.secret = secret;
    this.resolver = resolver || new LocalSourceResolver(http, { browserResolver });
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
  async resolve(rule, originalUrl, options = {}) {
    originalUrl = checkedUrl(new URL(originalUrl, rule.baseURL).href, {
      allowPrivate: this.http.allowPrivate,
    }).href;
    const result = await this.resolver.resolve(rule, originalUrl, options);
    if (!result || !['hls', 'video'].includes(result.type))
      throw new HttpError('未解析到可播放的视频地址', 422);
    checkedUrl(result.url, { allowPrivate: this.http.allowPrivate });
    const session = this.sessions.create({ ...result, adBlocker: rule.adBlocker === true });
    // Native players detect stream formats themselves. Browser playback needs a
    // transport hint for signed, extensionless media URLs; no source HTML is read.
    if (result.type === 'video' && !mediaType(result.url)) {
      const signal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(12000),
      ]);
      const headersForUrl = (target) => ({
        ...headersForSession(session, target),
        range: 'bytes=0-511',
      });
      const { response } = await this.http.request(result.url, {
        headers: headersForUrl(result.url),
        headersForUrl,
        signal,
      });
      if (![200, 206].includes(response.status)) {
        await response.body?.cancel();
        throw new HttpError(`媒体服务器返回 HTTP ${response.status}`, 502);
      }
      if (/mpegurl/i.test(response.headers.get('content-type') || '')) {
        result.type = 'hls';
        await response.body?.cancel();
      } else if (response.body) {
        const reader = response.body.getReader();
        try {
          const { value } = await reader.read();
          if (
            value &&
            Buffer.from(value)
              .toString('utf8', 0, 512)
              .replace(/^\uFEFF/, '')
              .trimStart()
              .startsWith('#EXTM3U')
          )
            result.type = 'hls';
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
    }
    return {
      type: result.type,
      nativePlayback: result.type === 'hls' && rule.adBlocker === true,
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
        const playlist = rewritePlaylist(raw, url, (target, kind) =>
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

export { extractMedia, mediaType } from './extract-media.js';
