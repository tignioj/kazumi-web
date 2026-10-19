import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, USER_AGENT } from '../../lib/http.js';

export const COMMENT_PAGE_SIZE = 20;

function positiveId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new HttpError('评论条目 ID 无效');
  return Number(value);
}

function normalizeComment(row, subject = false) {
  if (
    !row ||
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    typeof (subject ? row.comment : row.content) !== 'string'
  )
    throw new Error('评论数据格式无效');
  const user = row.user || {};
  const timestamp = Number(subject ? row.updatedAt : row.createdAt);
  const result = {
    id: row.id,
    user: {
      username: typeof user.username === 'string' ? user.username : '',
      nickname: typeof user.nickname === 'string' ? user.nickname : '',
    },
    content: subject ? row.comment : row.content,
    timestamp:
      Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 253402300799 ? timestamp : 0,
    rate: subject ? Number(row.rate) || 0 : 0,
    replies: [],
  };
  if (!subject && row.replies !== undefined) {
    if (!Array.isArray(row.replies)) throw new Error('评论回复格式无效');
    result.replies = row.replies.map((reply) => normalizeComment(reply));
  }
  return result;
}

// Kept separately from the replaceable Archive database: comments survive both
// metadata imports and application restarts, including in local metadata mode.
export class CommentService {
  constructor({
    directory,
    http,
    nextUrl = process.env.BANGUMI_NEXT_URL || 'https://next.bgm.tv',
    ttlMinutes = Number(process.env.COMMENTS_CACHE_TTL_MINUTES ?? 30),
    maxBytes = Number(process.env.COMMENTS_CACHE_MAX_BYTES ?? 50 * 1024 ** 2),
    now = Date.now,
  }) {
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0)
      throw new Error('COMMENTS_CACHE_TTL_MINUTES 必须大于 0');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error('COMMENTS_CACHE_MAX_BYTES 必须为正整数字节数');
    this.directory = directory;
    this.http = http;
    this.nextUrl = nextUrl.replace(/\/$/, '');
    this.ttl = ttlMinutes * 60000;
    this.maxBytes = maxBytes;
    this.now = now;
    this.pending = new Map();
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    return this;
  }

  open() {
    if (this.db) return;
    this.db = new DatabaseSync(join(this.directory, 'comments.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS comment_cache (
        cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL
      );
    `);
    this.prune();
  }

  prune() {
    const rows = this.db
      .prepare('SELECT cache_key,bytes FROM comment_cache ORDER BY updated_at DESC,rowid DESC')
      .all();
    const remove = this.db.prepare('DELETE FROM comment_cache WHERE cache_key=?');
    let bytes = 0;
    rows.forEach((row, index) => {
      bytes += row.bytes;
      if (bytes > this.maxBytes || index >= 2000) remove.run(row.cache_key);
    });
  }

  save(key, data, updatedAt) {
    const payload = JSON.stringify(data);
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.maxBytes) return false;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO comment_cache VALUES(?,?,?,?)
        ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,
          updated_at=excluded.updated_at,bytes=excluded.bytes`,
        )
        .run(key, payload, updatedAt, bytes);
      this.prune();
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async read(kind, id, { page = 1, refresh = false } = {}) {
    if (!['subjects', 'episodes'].includes(kind)) throw new HttpError('评论类型无效');
    id = positiveId(id);
    if (!Number.isInteger(page) || page < 1 || page > 1000)
      throw new HttpError('页码必须为 1 至 1000');
    this.open();
    const path =
      `/p1/${kind}/${id}/comments` +
      (kind === 'subjects'
        ? `?limit=${COMMENT_PAGE_SIZE}&offset=${(page - 1) * COMMENT_PAGE_SIZE}`
        : '');
    const key = `${this.nextUrl}${path}`;
    const hit = this.db
      .prepare('SELECT payload,updated_at FROM comment_cache WHERE cache_key=?')
      .get(key);
    const cached = hit ? JSON.parse(hit.payload) : null;
    let result;
    if (hit && !refresh && this.now() - hit.updated_at < this.ttl) {
      result = { ...cached, cache: { cached: true, stale: false, updatedAt: hit.updated_at } };
    } else {
      if (!this.pending.has(key)) {
        const pending = this.fetch(key, kind, cached, hit?.updated_at).finally(() =>
          this.pending.delete(key),
        );
        this.pending.set(key, pending);
      }
      result = await this.pending.get(key);
    }
    const start = (page - 1) * COMMENT_PAGE_SIZE;
    return {
      ...result,
      items:
        kind === 'episodes' ? result.items.slice(start, start + COMMENT_PAGE_SIZE) : result.items,
      page,
      pageSize: COMMENT_PAGE_SIZE,
    };
  }

  async fetch(url, kind, cached, updatedAt) {
    let data;
    try {
      const raw = await this.http.json(url, {
        timeout: 10000,
        maxBytes: 5 * 1024 ** 2,
        headers: { 'user-agent': process.env.BANGUMI_USER_AGENT || USER_AGENT },
      });
      if (kind === 'subjects') {
        if (!Array.isArray(raw?.data) || !Number.isSafeInteger(raw.total) || raw.total < 0)
          throw new Error('短评数据格式无效');
        data = { items: raw.data.map((row) => normalizeComment(row, true)), total: raw.total };
      } else {
        if (!Array.isArray(raw)) throw new Error('剧集评论格式无效');
        data = { items: raw.map((row) => normalizeComment(row)), total: raw.length };
      }
    } catch {
      if (cached) return { ...cached, cache: { cached: true, stale: true, updatedAt } };
      throw new HttpError('暂时无法获取 Bangumi 评论，请稍后重试', 502);
    }
    updatedAt = this.now();
    let persisted = false;
    try {
      persisted = this.save(url, data, updatedAt);
    } catch (error) {
      console.warn('[comments] 无法保存评论缓存:', error.message);
    }
    return { ...data, cache: { cached: false, stale: false, updatedAt, persisted } };
  }

  async close() {
    await Promise.allSettled(this.pending.values());
    this.db?.close();
    this.db = null;
  }
}
