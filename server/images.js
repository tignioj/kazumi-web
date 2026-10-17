import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bangumiImageUrl } from '../shared/images.js';
import { HttpError } from './http.js';

const MAX_IMAGE_BYTES = 5 * 1024 ** 2;
const CACHE_TTL = 24 * 3600 * 1000;
const KEY = /^[a-f0-9]{64}\.img$/;

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
  constructor({ directory, http, maxBytes = 256 * 1024 ** 2, ttl = CACHE_TTL, now = Date.now }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error('IMAGE_CACHE_MAX_BYTES 必须为非负安全整数');
    this.directory = directory;
    this.http = http;
    this.maxBytes = maxBytes;
    this.ttl = ttl;
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
    for (const name of await readdir(this.directory)) {
      if (/^[a-f0-9]{64}\.img\.[a-f0-9]{12}\.tmp$/.test(name)) {
        await unlink(join(this.directory, name));
        continue;
      }
      if (!KEY.test(name)) continue;
      const info = await stat(join(this.directory, name));
      if (!info.isFile()) continue;
      if (info.size > MAX_IMAGE_BYTES || info.mtimeMs + this.ttl <= this.now()) {
        await unlink(join(this.directory, name));
        continue;
      }
      files.push({ key: name, size: info.size, expires: info.mtimeMs + this.ttl });
    }
    for (const entry of files.sort((a, b) => a.expires - b.expires)) {
      this.entries.set(entry.key, entry);
      this.bytes += entry.size;
    }
    await this.evict();
    return this;
  }

  async remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.size;
    await unlink(join(this.directory, key)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async evict() {
    while (this.bytes > this.maxBytes) await this.remove(this.entries.keys().next().value);
  }

  async load(url, key) {
    if (this.pending.size >= 64) throw new HttpError('图片加载繁忙，请稍后重试', 503);
    if (this.active >= 8) await new Promise((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      return await this.download(url, key);
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  async download(url, key) {
    const result = await this.http.request(url, {
      // The HTTP client invokes this before EVERY redirect hop, before opening its socket.
      validateUrl: validateImageUrl,
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
    });
    validateImageUrl(result.url);
    if (!result.response.ok) {
      await result.response.body?.cancel();
      throw new HttpError(`图片服务器返回 HTTP ${result.response.status}`, 502);
    }
    const bytes = await imageBytes(result.response);
    const entry = { key, size: bytes.length, expires: this.now() + this.ttl };
    if (bytes.length <= this.maxBytes) {
      // Serialize disk mutations so concurrent downloads cannot exceed the cache budget.
      const write = this.writes.then(async () => {
        const temporary = join(this.directory, `${key}.${randomBytes(6).toString('hex')}.tmp`);
        try {
          await writeFile(temporary, bytes, { flag: 'wx' });
          await rename(temporary, join(this.directory, key));
        } finally {
          await unlink(temporary).catch(() => {});
        }
        await this.removeExpired();
        this.entries.set(key, entry);
        this.bytes += entry.size;
        await this.evict();
      });
      this.writes = write.catch(() => {});
      // A full/read-only cache must not prevent a valid image from being displayed.
      await write.catch((error) => console.warn('[image-cache]', error.code || error.message));
    }
    return { bytes, expires: entry.expires };
  }

  async removeExpired() {
    for (const [key, entry] of this.entries)
      if (entry.expires <= this.now()) await this.remove(key);
  }

  async get(value) {
    const url = bangumiImageUrl(value);
    if (!url) throw new HttpError('仅允许代理 Bangumi 图片', 403);
    const key = `${createHash('sha256').update(url).digest('hex')}.img`;
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) {
      try {
        const bytes = await readFile(join(this.directory, key));
        if (imageType(bytes)) {
          if (this.entries.get(key) === hit) {
            this.entries.delete(key);
            this.entries.set(key, hit);
          }
          return { bytes, expires: hit.expires };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (this.pending.has(key)) return this.pending.get(key);
    await this.remove(key);
    // Recheck after the asynchronous deletion: another caller may already have started loading.
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = this.load(url, key)
      .catch((error) => {
        if (['TimeoutError', 'AbortError'].includes(error.name))
          throw new HttpError('图片加载超时，请稍后重试', 502);
        throw error;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  async serve(req, res) {
    res.set('Cache-Control', 'no-store');
    const { bytes, expires } = await this.get(req.query.url);
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
    res.set({
      'Content-Type': imageType(bytes),
      'Cache-Control': `public, max-age=${Math.max(0, Math.floor((expires - this.now()) / 1000))}`,
      ETag: etag,
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
