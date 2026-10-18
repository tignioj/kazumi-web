import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { bangumiImageUrl } from '../../../shared/images.js';
import { HttpError } from '../../lib/http.js';

const MAX_IMAGE_BYTES = 5 * 1024 ** 2;
const DEFAULT_MAX_AGE = 7 * 24 * 3600 * 1000;
const STALE_PERIOD = 30 * 24 * 3600 * 1000;
const KEY = /^[a-f0-9]{64}\.img$/;

function imageEtag(bytes) {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

function cachePolicy(headers, now, previous) {
  const control = headers.get('cache-control') ?? previous?.cacheControl ?? '';
  const directives = control
    .toLowerCase()
    .split(',')
    .map((value) => value.trim());
  const maxAge = directives.map((value) => /^max-age\s*=\s*"?(\d+)"?$/.exec(value)).find(Boolean);
  const seconds = maxAge ? Number(maxAge[1]) : DEFAULT_MAX_AGE / 1000;
  const age = Math.max(0, Number(headers.get('age')) || 0);
  const lifetime = directives.includes('no-cache') ? 0 : Math.max(0, seconds - age) * 1000;
  return {
    cacheControl: control,
    cacheable: !directives.includes('no-store'),
    expires: now + (Number.isSafeInteger(lifetime) ? lifetime : DEFAULT_MAX_AGE),
  };
}

export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 64)))
    return 'image/avif';
  return null;
}

function validateImageUrl(value) {
  const canonical = bangumiImageUrl(String(value));
  if (!canonical || new URL(String(value)).protocol !== 'https:')
    throw new HttpError('仅允许代理 Bangumi 的 HTTPS 图片', 403);
  return canonical;
}

async function imageBytes(response) {
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(jpeg|png|gif|webp|avif)$/.test(mime) && mime !== 'application/octet-stream') {
    await response.body?.cancel();
    throw new HttpError('图片服务器返回了不支持的内容', 502);
  }
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new HttpError('图片超过 5 MiB 限制', 502);
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new HttpError('图片超过 5 MiB 限制', 502);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks);
  if (!imageType(bytes)) throw new HttpError('图片内容无效或格式不受支持', 502);
  return bytes;
}

export class ImageCache {
  constructor({
    directory,
    http,
    maxBytes = 5 * 1024 ** 3,
    maxEntries = 5000,
    stalePeriod = STALE_PERIOD,
    now = Date.now,
    resolveUrl,
  }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error('IMAGE_CACHE_MAX_BYTES 必须为非负安全整数');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0)
      throw new Error('图片缓存数量上限必须为非负安全整数');
    this.directory = directory;
    this.http = http;
    this.resolveUrl = resolveUrl;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.stalePeriod = stalePeriod;
    this.now = now;
    this.entries = new Map();
    this.pending = new Map();
    this.active = 0;
    this.waiters = [];
    this.bytes = 0;
    this.writes = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    const files = [];
    const names = new Set(await readdir(this.directory));
    for (const name of names) {
      if (
        /^[a-f0-9]{64}\.img(?:\.json)?\.[a-f0-9]{12}\.tmp$/.test(name) ||
        (/^[a-f0-9]{64}\.img\.json$/.test(name) && !names.has(name.slice(0, -5)))
      ) {
        await unlink(join(this.directory, name));
        continue;
      }
      if (!KEY.test(name)) continue;
      const info = await stat(join(this.directory, name));
      if (!info.isFile()) continue;
      if (info.size > MAX_IMAGE_BYTES || info.mtimeMs + this.stalePeriod <= this.now()) {
        await unlink(join(this.directory, name));
        await this.unlink(`${name}.json`);
        continue;
      }
      let metadata;
      try {
        metadata = JSON.parse(await readFile(join(this.directory, `${name}.json`), 'utf8'));
        if (
          !Number.isFinite(metadata.expires) ||
          !/^"[a-f0-9]{64}"$/.test(metadata.contentEtag) ||
          validateImageUrl(metadata.target) !== metadata.target
        )
          metadata = null;
      } catch {
        metadata = null;
      }
      // Old caches have no HTTP metadata. Keep displaying them while fetching fresh headers.
      files.push({
        ...metadata,
        key: name,
        size: info.size,
        usedAt: info.mtimeMs,
        expires: metadata?.expires ?? 0,
      });
    }
    for (const entry of files.sort((a, b) => a.usedAt - b.usedAt)) {
      this.entries.set(entry.key, entry);
      this.bytes += entry.size;
    }
    await this.evict();
    return this;
  }

  async unlink(key) {
    await unlink(join(this.directory, key)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.size;
    await this.unlink(key);
    await this.unlink(`${key}.json`);
  }

  async evict() {
    for (const [key, entry] of this.entries)
      if (entry.usedAt + this.stalePeriod <= this.now()) await this.remove(key);
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries)
      await this.remove(this.entries.keys().next().value);
  }

  write(operation) {
    const write = this.writes.then(operation);
    this.writes = write.catch((error) =>
      console.warn('[image-cache]', error.code || error.message),
    );
    return this.writes;
  }

  async atomicWrite(key, bytes) {
    const temporary = `${key}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(join(this.directory, temporary), bytes, { flag: 'wx' });
      await rename(join(this.directory, temporary), join(this.directory, key));
    } finally {
      await this.unlink(temporary);
    }
  }

  refresh(url, key, cached) {
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = this.load(url, key, cached)
      .catch((error) => {
        if (['TimeoutError', 'AbortError'].includes(error.name))
          throw new HttpError('图片加载超时，请稍后重试', 502);
        throw error;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  async load(url, key, cached) {
    if (this.pending.size >= 64) throw new HttpError('图片加载繁忙，请稍后重试', 503);
    if (this.active >= 8) await new Promise((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      return await this.download(url, key, cached);
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  async download(url, key, cached) {
    const signal = AbortSignal.timeout(15000);
    const target = this.resolveUrl ? await this.resolveUrl(url, signal) : url;
    validateImageUrl(target);
    const headersForUrl = (value) => ({
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
      ...(value === cached?.target && cached.upstreamEtag
        ? { 'if-none-match': cached.upstreamEtag }
        : {}),
      ...(value === cached?.target && cached.lastModified
        ? { 'if-modified-since': cached.lastModified }
        : {}),
    });
    const result = await this.http.request(target, {
      // The HTTP client invokes this before EVERY redirect hop, before opening its socket.
      validateUrl: validateImageUrl,
      signal,
      headers: headersForUrl(target),
      headersForUrl,
    });
    validateImageUrl(result.url);
    const unchanged = result.response.status === 304 && cached?.target === result.url;
    if (!result.response.ok && !unchanged) {
      await result.response.body?.cancel();
      throw new HttpError(`图片服务器返回 HTTP ${result.response.status}`, 502);
    }
    if (unchanged) await result.response.body?.cancel();
    const bytes = unchanged ? cached.bytes : await imageBytes(result.response);
    const policy = cachePolicy(result.response.headers, this.now(), unchanged ? cached : null);
    const entry = {
      key,
      size: bytes.length,
      usedAt: this.now(),
      expires: policy.expires,
      cacheControl: policy.cacheControl,
      contentEtag: imageEtag(bytes),
      target: result.url,
      upstreamEtag: result.response.headers.get('etag') ?? (unchanged ? cached.upstreamEtag : null),
      lastModified:
        result.response.headers.get('last-modified') ?? (unchanged ? cached.lastModified : null),
    };
    // Serialize disk changes, including replacement accounting and last-use timestamps.
    await this.write(async () => {
      if (!policy.cacheable || bytes.length > this.maxBytes || !this.maxEntries) {
        await this.remove(key);
        return;
      }
      if (!unchanged || !this.entries.has(key)) await this.atomicWrite(key, bytes);
      const previous = this.entries.get(key);
      this.bytes += entry.size - (previous?.size ?? 0);
      this.entries.delete(key);
      this.entries.set(key, entry);
      try {
        await this.atomicWrite(`${key}.json`, JSON.stringify(entry));
      } catch (error) {
        await this.unlink(`${key}.json`);
        throw error;
      } finally {
        await utimes(join(this.directory, key), entry.usedAt / 1000, entry.usedAt / 1000);
        await this.evict();
      }
    });
    return { bytes, expires: entry.expires, cacheable: policy.cacheable };
  }

  async get(value, { waitForRefresh = false } = {}) {
    const url = bangumiImageUrl(value);
    if (!url) throw new HttpError('仅允许代理 Bangumi 图片', 403);
    const key = `${createHash('sha256').update(url).digest('hex')}.img`;
    const hit = this.entries.get(key);
    if (hit && hit.usedAt + this.stalePeriod > this.now()) {
      try {
        const bytes = await readFile(join(this.directory, key));
        if (this.entries.get(key) !== hit) return this.get(value, { waitForRefresh });
        if (imageType(bytes)) {
          const contentEtag = imageEtag(bytes);
          // A crash between the image and metadata writes must never reuse mismatched validators.
          if (hit.contentEtag !== contentEtag) {
            hit.expires = 0;
            hit.target = hit.upstreamEtag = hit.lastModified = null;
          }
          if (this.entries.get(key) === hit) {
            hit.usedAt = this.now();
            this.entries.delete(key);
            this.entries.set(key, hit);
            void this.write(async () => {
              if (this.entries.get(key) !== hit) return;
              await utimes(join(this.directory, key), hit.usedAt / 1000, hit.usedAt / 1000);
              await this.evict();
            });
          }
          if (
            hit.expires <= this.now() &&
            !this.pending.has(key) &&
            !(hit.retryAfter > this.now())
          ) {
            // Never make a cached cover wait for the upstream, even when refresh fails.
            void this.refresh(url, key, { ...hit, bytes }).catch((error) => {
              hit.retryAfter = this.now() + 60000;
              console.warn('[image-cache refresh]', error.code || error.message);
            });
          }
          if (waitForRefresh && this.pending.has(key)) {
            try {
              return await this.pending.get(key);
            } catch {
              // The browser keeps its already displayed cover when revalidation fails.
            }
          }
          return { bytes, expires: hit.expires };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return this.refresh(url, key);
  }

  async serve(req, res) {
    res.set('Cache-Control', 'no-store');
    const { bytes, expires, cacheable } = await this.get(req.query.url, {
      waitForRefresh: req.query.refresh === '1',
    });
    const etag = imageEtag(bytes);
    res.set({
      'Content-Type': imageType(bytes),
      'Cache-Control':
        cacheable === false
          ? 'no-store'
          : `public, max-age=${Math.max(0, Math.floor((expires - this.now()) / 1000))}, stale-while-revalidate=${Math.floor(this.stalePeriod / 1000)}`,
      ETag: etag,
      'X-Image-Expires': String(expires),
    });
    if (
      req
        .get('if-none-match')
        ?.split(/\s*,\s*/)
        .includes(etag)
    )
      return res.status(304).end();
    res.send(bytes);
  }

  async close() {
    await Promise.allSettled(this.pending.values());
    await this.writes;
  }
}
