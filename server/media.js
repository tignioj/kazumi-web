import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JSDOM } from 'jsdom';
import { HttpError, checkedUrl, readLimited } from './http.js';
import { absoluteUrl, ruleHeaders } from './rules.js';

export function mediaType(url) {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  if (/\.(?:mp4|m4v|webm|mov|mp3|m4a|ogg|ogv)(?:[?#]|$)/i.test(url)) return 'video';
  return null;
}

function jsonObjectAt(text, start) {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else {
      if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function extractMedia(html, pageUrl) {
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
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
        const url = absoluteUrl(raw, pageUrl);
        if (url)
          return {
            type: mediaType(url) || (/m3u8|hls/i.test(data.from || '') ? 'hls' : 'iframe'),
            url,
          };
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
  constructor(http, secret = process.env.MEDIA_SECRET || randomBytes(32).toString('hex')) {
    this.http = http;
    this.secret = secret;
  }
  signature(value) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
  proxyUrl(url, headers, expires = Math.floor(Date.now() / 1000) + 24 * 3600, kind) {
    checkedUrl(url, { allowPrivate: this.http.allowPrivate });
    const payload = Buffer.from(JSON.stringify({ url, headers, expires, kind })).toString(
      'base64url',
    );
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
  async resolve(rule, source) {
    const originalUrl = absoluteUrl(source, rule.baseURL);
    if (!originalUrl) throw new HttpError('播放地址无效');
    const headers = ruleHeaders(rule);
    let url = originalUrl;
    let fallback = originalUrl;
    const visited = new Set();
    for (let depth = 0; depth < 4; depth++) {
      checkedUrl(url, { allowPrivate: this.http.allowPrivate });
      const type = mediaType(url);
      if (type) return { type, url: this.proxyUrl(url, headers, undefined, type), originalUrl };
      if (visited.has(url)) break;
      visited.add(url);
      let result;
      try {
        result = await this.http.request(url, { headers });
      } catch (error) {
        if (depth === 0 || error.status === 403) throw error;
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
          url: this.proxyUrl(result.url, headers, undefined, kind),
          originalUrl,
        };
      }
      const raw = await readLimited(response);
      if (raw.trimStart().startsWith('#EXTM3U'))
        return {
          type: 'hls',
          url: this.proxyUrl(result.url, headers, undefined, 'hls'),
          originalUrl,
        };
      const extracted = extractMedia(raw, result.url);
      if (!extracted) break;
      checkedUrl(extracted.url, { allowPrivate: this.http.allowPrivate });
      if (extracted.type !== 'iframe')
        return {
          ...extracted,
          url: this.proxyUrl(extracted.url, headers, undefined, extracted.type),
          originalUrl,
        };
      fallback = extracted.url;
      url = extracted.url;
    }
    return { type: 'iframe', url: fallback, originalUrl };
  }
  async proxy(req, res) {
    const data = this.verify(req.query.payload, req.query.signature);
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
      const headers = { ...data.headers };
      if (req.headers.range) headers.range = req.headers.range;
      const { response, url } = await this.http.request(data.url, {
        headers,
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
        const playlist = rewritePlaylist(
          await readLimited(response, 2 * 1024 * 1024),
          url,
          (target, kind) => this.proxyUrl(target, data.headers, data.expires, kind),
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
