import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { checkedUrl, cleanHeaders, HttpError } from './http.js';
import { headersForSession } from './media-session.js';
import { streamArchive } from './download-archive.js';

const MAX_JOBS = 200;
const MAX_FILES = 20000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 6;
const ID = /^[a-f0-9-]{36}$/;
const FILE = /^(?:index\.m3u8|(?:video|playlist-\d+|asset-\d+)\.[a-z0-9]{1,8})$/;
const KNOWN_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.webm',
  '.mov',
  '.mp3',
  '.m4a',
  '.ogg',
  '.ogv',
  '.ts',
  '.m4s',
  '.aac',
  '.vtt',
  '.webvtt',
  '.key',
  '.bin',
]);

function textField(value, fallback = '', limit = 500) {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit)
    : fallback;
}

function sameEpisode(job, ruleName, episodeUrl) {
  return (
    job.ruleName.trim().toLowerCase() === ruleName.trim().toLowerCase() &&
    job.episodeUrl === episodeUrl.trim()
  );
}

function validateEpisode(input) {
  if (
    !input ||
    typeof input.ruleName !== 'string' ||
    !input.ruleName.trim() ||
    typeof input.episodeUrl !== 'string' ||
    !input.episodeUrl.trim()
  )
    throw new HttpError('请选择要缓存的视频剧集');
  if (input.ruleName.length > 500 || input.episodeUrl.length > 8192)
    throw new HttpError('视频信息过长');
}

function newJob(input, media) {
  return {
    id: randomUUID(),
    ruleName: input.ruleName.trim(),
    episodeUrl: input.episodeUrl.trim(),
    sourceUrl: textField(input.sourceUrl, '', 8192),
    title: textField(input.title, '未命名视频'),
    episodeName: textField(input.episodeName, '视频'),
    image: textField(input.image, '', 8192),
    subjectId:
      typeof input.subjectId === 'number' || typeof input.subjectId === 'string'
        ? input.subjectId
        : undefined,
    ...media,
    status: 'queued',
    bytes: 0,
    totalBytes: null,
    completedFiles: 0,
    totalFiles: media.type === 'video' ? 1 : 0,
    createdAt: new Date().toISOString(),
    files: [],
  };
}

function extension(url, contentType = '', fallback = '.bin') {
  const suffix = extname(new URL(url).pathname).toLowerCase();
  if (KNOWN_EXTENSIONS.has(suffix)) return suffix;
  if (/video\/mp4/i.test(contentType)) return '.mp4';
  if (/video\/webm/i.test(contentType)) return '.webm';
  if (/audio\/mpeg/i.test(contentType)) return '.mp3';
  if (/audio\/(?:mp4|x-m4a)/i.test(contentType)) return '.m4a';
  if (/video\/mp2t/i.test(contentType)) return '.ts';
  if (/text\/vtt/i.test(contentType)) return '.vtt';
  return fallback;
}

function contentLength(response) {
  const value = response.headers.get('content-length');
  if (response.headers.get('content-encoding') || value == null) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new HttpError('视频长度无效', 502);
  return Number(value);
}

function checkContent(contentType, prefix, kind) {
  // HLS CDNs can serve image-prefixed segments as image/png or image/jpeg.
  // Keep their bytes intact, just as the playback proxy does, for the demuxer,
  // encrypted segments and playlist byte ranges. SVG and error pages still fail.
  if (
    /text\/html|application\/(?:json|javascript|xhtml|xml)|image\/svg/i.test(contentType) ||
    (kind !== 'segment' && /image\//i.test(contentType))
  )
    throw new HttpError('媒体服务器返回了网页或其他非视频内容', 422);
  if (
    kind === 'video' &&
    /^(?:text\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))/i.test(contentType)
  )
    throw new HttpError('媒体服务器未返回视频文件', 422);
  const start = prefix
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (/^(?:<!doctype|<html|<head|<body|<script|<\?xml|<svg|\{\s*["}]|\[\s*\{)/i.test(start))
    throw new HttpError('媒体服务器返回了网页或其他非视频内容', 422);
  if (kind !== 'manifest' && start.startsWith('#EXTM3U'))
    throw new HttpError('视频文件意外返回了播放列表，请重新解析', 422);
}

function publicJob(job) {
  const result = {
    id: job.id,
    ruleName: job.ruleName,
    episodeUrl: job.episodeUrl,
    sourceUrl: job.sourceUrl,
    title: job.title,
    episodeName: job.episodeName,
    type: job.type,
    status: job.status,
    bytes: job.bytes,
    totalBytes: job.totalBytes,
    completedFiles: job.completedFiles,
    totalFiles: job.totalFiles,
    createdAt: job.createdAt,
    playbackUrl:
      job.status === 'complete' ? `/api/downloads/${job.id}/files/${job.mainFile}` : null,
    downloadUrl: job.status === 'complete' ? `/api/downloads/${job.id}/download` : null,
  };
  if (job.image) result.image = job.image;
  if (job.subjectId) result.subjectId = job.subjectId;
  if (job.error) result.error = job.error;
  return result;
}

export class DownloadManager {
  constructor({ directory, http, media, maxBytes = 10 * 1024 ** 3, concurrency = 2 }) {
    this.directory = resolve(directory);
    this.http = http;
    this.media = media;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new HttpError('视频缓存容量必须为正整数');
    this.maxBytes = maxBytes;
    this.concurrency = Math.min(4, Math.max(1, Number(concurrency) || 2));
    this.jobs = new Map();
    this.usedBytes = 0;
    this.active = new Set();
    this.mutations = Promise.resolve();
    this.persistence = Promise.resolve();
    this.closed = false;
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let records = [];
    try {
      const index = JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
      if (!Array.isArray(index.items)) throw new Error('invalid index');
      records = index.items.slice(0, MAX_JOBS);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new HttpError('视频缓存索引损坏，无法读取', 500);
    }
    for (const data of records) {
      if (!ID.test(data.id) || !['video', 'hls', 'pending'].includes(data.type)) continue;
      const job = {
        id: data.id,
        ruleName: textField(data.ruleName),
        episodeUrl: textField(data.episodeUrl, '', 8192),
        sourceUrl: textField(data.sourceUrl, '', 8192),
        title: textField(data.title),
        episodeName: textField(data.episodeName),
        image: textField(data.image, '', 8192),
        subjectId: data.subjectId,
        type: data.type,
        status: data.status,
        bytes: 0,
        totalBytes: null,
        completedFiles: 0,
        totalFiles: 0,
        createdAt: textField(data.createdAt, new Date().toISOString()),
        files: [],
        mainFile: data.mainFile,
      };
      try {
        if (
          data.status !== 'complete' ||
          !FILE.test(data.mainFile) ||
          !Array.isArray(data.files) ||
          data.files.length > MAX_FILES ||
          !data.files.some((file) => file.name === data.mainFile)
        )
          throw new Error('incomplete');
        const names = new Set();
        for (const file of data.files) {
          if (!FILE.test(file.name) || names.has(file.name)) throw new Error('invalid file');
          names.add(file.name);
          const info = await stat(join(this.directory, job.id, file.name));
          if (!info.isFile() || info.size !== file.size) throw new Error('missing file');
          job.files.push({
            name: file.name,
            size: info.size,
            contentType: textField(file.contentType),
          });
          job.bytes += info.size;
        }
        job.completedFiles = job.totalFiles = job.files.length;
        job.totalBytes = job.bytes;
        this.usedBytes += job.bytes;
      } catch {
        await rm(join(this.directory, job.id), { recursive: true, force: true });
        job.status = 'error';
        job.error =
          data.status === 'error'
            ? textField(data.error, '缓存失败，请重试')
            : '缓存任务已中断或文件不完整，请重新缓存';
        job.bytes = 0;
        job.files = [];
      }
      this.jobs.set(job.id, job);
    }
    // An interrupted atomic write or a crash before indexing may leave files.
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (
        (entry.isDirectory() && ID.test(entry.name) && !this.jobs.has(entry.name)) ||
        /^index\.[a-f0-9-]+\.tmp$/.test(entry.name)
      )
        await rm(join(this.directory, entry.name), { recursive: true, force: true });
    }
    await this.persist();
    return this;
  }

  list() {
    return {
      items: [...this.jobs.values()]
        .filter((job) => !job.removed)
        .map(publicJob)
        .reverse(),
      usedBytes: this.usedBytes,
      maxBytes: this.maxBytes,
    };
  }

  findComplete(ruleName, episodeUrl) {
    const job = [...this.jobs.values()].find(
      (entry) =>
        !entry.removed && entry.status === 'complete' && sameEpisode(entry, ruleName, episodeUrl),
    );
    return job ? publicJob(job) : null;
  }

  lock(work) {
    const pending = this.mutations.then(work);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  create(input) {
    return this.lock(async () => {
      if (this.closed) throw new HttpError('缓存服务已关闭', 503);
      validateEpisode(input);
      const existing = [...this.jobs.values()].find(
        (job) => !job.removed && sameEpisode(job, input.ruleName, input.episodeUrl),
      );
      if (existing && existing.status !== 'error') return publicJob(existing);
      if (this.jobs.size >= MAX_JOBS && !existing)
        throw new HttpError('最多保留 200 个缓存任务，请先清理缓存', 409);
      if (this.usedBytes >= this.maxBytes)
        throw new HttpError('视频缓存空间不足，请先清理缓存', 507);
      const media = this.mediaSource(input.mediaUrl);
      if (existing) {
        await rm(join(this.directory, existing.id), { recursive: true, force: true });
        this.jobs.delete(existing.id);
      }
      const job = newJob(input, media);
      this.jobs.set(job.id, job);
      await this.persist();
      const result = publicJob(job);
      this.pump();
      return result;
    });
  }

  createBatch(input, rule) {
    return this.lock(async () => {
      if (this.closed) throw new HttpError('缓存服务已关闭', 503);
      if (
        !Array.isArray(input?.episodes) ||
        !input.episodes.length ||
        input.episodes.length > MAX_JOBS
      )
        throw new HttpError('一次可缓存 1 至 200 集');
      const episodes = new Map();
      for (const episode of input.episodes) {
        const entry = { ...input, episodeUrl: episode?.url, episodeName: episode?.name };
        validateEpisode(entry);
        episodes.set(entry.episodeUrl.trim(), entry);
      }
      const entries = [...episodes.values()].map((entry) => ({
        input: entry,
        existing: [...this.jobs.values()].find(
          (job) => !job.removed && sameEpisode(job, entry.ruleName, entry.episodeUrl),
        ),
      }));
      const pending = entries.filter(({ existing }) => !existing || existing.status === 'error');
      if (this.jobs.size + pending.filter(({ existing }) => !existing).length > MAX_JOBS)
        throw new HttpError('最多保留 200 个缓存任务，请先清理缓存', 409);
      if (pending.length && this.usedBytes >= this.maxBytes)
        throw new HttpError('视频缓存空间不足，请先清理缓存', 507);
      for (const entry of pending) {
        if (entry.existing) {
          await rm(join(this.directory, entry.existing.id), { recursive: true, force: true });
          this.jobs.delete(entry.existing.id);
        }
        const job = newJob(entry.input, { type: 'pending', rule });
        this.jobs.set(job.id, job);
        entry.existing = job;
      }
      await this.persist();
      const result = {
        items: entries.map(({ existing }) => publicJob(existing)),
        added: pending.length,
        skipped: entries.length - pending.length,
      };
      this.pump();
      return result;
    });
  }

  mediaSource(mediaUrl) {
    if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('/api/media?'))
      throw new HttpError('只能缓存已经解析的媒体链接', 400);
    const proxy = new URL(mediaUrl, 'http://cache.invalid');
    if (
      proxy.pathname !== '/api/media' ||
      proxy.hash ||
      proxy.searchParams.getAll('payload').length !== 1 ||
      proxy.searchParams.getAll('signature').length !== 1
    )
      throw new HttpError('媒体代理链接无效', 400);
    const verified = this.media.verify(
      proxy.searchParams.get('payload'),
      proxy.searchParams.get('signature'),
    );
    if (!['video', 'hls'].includes(verified.kind))
      throw new HttpError('当前播放来源暂不支持视频缓存', 422);
    checkedUrl(verified.url, { allowPrivate: this.http.allowPrivate });
    const source = {
      url: verified.url,
      headers: cleanHeaders(verified.headers),
      session: verified.sessionId
        ? structuredClone(this.media.sessions.get(verified.sessionId))
        : null,
    };
    delete source.headers.range;
    return { type: verified.kind, source };
  }

  persist() {
    const write = async () => {
      const items = [...this.jobs.values()]
        .filter((job) => !job.removed)
        .map((job) => ({
          ...publicJob(job),
          mainFile: job.mainFile,
          files: job.files,
        }));
      const path = join(this.directory, `index.${randomUUID()}.tmp`);
      await writeFile(path, JSON.stringify({ version: 1, items }), { mode: 0o600 });
      await rename(path, join(this.directory, 'index.json'));
    };
    const pending = this.persistence.then(write);
    this.persistence = pending.catch(() => {});
    return pending;
  }

  pump() {
    if (this.closed || this.paused) return;
    for (const job of this.jobs.values()) {
      if (this.active.size >= this.concurrency) break;
      if (job.removed || job.status !== 'queued') continue;
      job.status = 'downloading';
      job.controller = new AbortController();
      this.active.add(job.id);
      job.promise = this.run(job).finally(() => {
        this.active.delete(job.id);
        delete job.source;
        delete job.rule;
        delete job.controller;
        this.pump();
      });
      // run() records expected failures; a failed index write must not create
      // an unhandled rejection or prevent later queued jobs from running.
      job.promise.catch(() => {});
    }
  }

  async run(job) {
    try {
      await mkdir(join(this.directory, job.id), { mode: 0o700 });
      await this.persist();
      if (job.type === 'pending') {
        const resolved = await this.media.resolve(job.rule, job.episodeUrl, {
          signal: job.controller.signal,
        });
        job.controller.signal.throwIfAborted();
        if (!['video', 'hls'].includes(resolved.type))
          throw new HttpError('当前播放来源暂不支持视频缓存，请切换可直接播放的视频线路', 422);
        Object.assign(job, this.mediaSource(resolved.url));
      }
      if (job.type === 'hls') await this.hls(job);
      else await this.video(job);
      job.controller.signal.throwIfAborted();
      job.status = 'complete';
      job.totalBytes = job.bytes;
      job.totalFiles = job.completedFiles;
      await this.persist();
    } catch (error) {
      await rm(join(this.directory, job.id), { recursive: true, force: true });
      this.usedBytes -= job.bytes;
      job.bytes = 0;
      job.files = [];
      job.completedFiles = 0;
      job.totalBytes = null;
      job.status = 'error';
      job.error = job.controller.signal.aborted
        ? '缓存任务已中断，请重试'
        : textField(error.message, '视频缓存失败，请重试', 250).replace(
            /https?:\/\/[^\s]+/g,
            '[媒体地址]',
          );
      if (!job.removed) await this.persist();
    }
  }

  reserve(job, count) {
    job.controller.signal.throwIfAborted();
    if (this.usedBytes + count > this.maxBytes)
      throw new HttpError('视频缓存空间不足，请清理缓存后重试', 507);
    // Reserve before any await so concurrent workers share one strict budget.
    this.usedBytes += count;
    job.bytes += count;
  }

  async request(job, url) {
    checkedUrl(url, { allowPrivate: this.http.allowPrivate });
    const controller = new AbortController();
    const signal = AbortSignal.any([job.controller.signal, controller.signal]);
    let timer = setTimeout(() => controller.abort(), 20000);
    const headersForUrl = (target) => {
      if (job.source.session) return headersForSession(job.source.session, target);
      const headers = { ...job.source.headers };
      if (new URL(target).origin !== new URL(job.source.url).origin) {
        delete headers.authorization;
        delete headers.cookie;
      }
      return headers;
    };
    try {
      const result = await this.http.request(url, {
        headers: headersForUrl(url),
        headersForUrl,
        signal,
      });
      clearTimeout(timer);
      if (result.response.status !== 200 || !result.response.body) {
        await result.response.body?.cancel();
        throw new HttpError(`媒体服务器返回 HTTP ${result.response.status}`, 502);
      }
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), 60000);
      };
      touch();
      return { ...result, signal, touch, release: () => clearTimeout(timer) };
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }

  async consume(job, result, { name, kind, maxBytes = this.maxBytes } = {}) {
    const { response } = result;
    const reader = response.body.getReader();
    let handle;
    let size = 0;
    const chunks = [];
    let prefix = Buffer.alloc(0);
    let checked = false;
    let complete = false;
    try {
      const expected = contentLength(response);
      if (kind === 'video') job.totalBytes = expected;
      if (
        expected !== null &&
        (expected > maxBytes || (name && expected > this.maxBytes - this.usedBytes))
      )
        throw new HttpError('视频缓存空间不足或媒体文件过大，请清理缓存后重试', 507);
      if (name) handle = await open(join(this.directory, job.id, name), 'wx', 0o600);
      for (;;) {
        result.signal.throwIfAborted();
        const { done, value } = await reader.read();
        result.touch();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes) throw new HttpError('媒体文件超过缓存限制', 507);
        if (!checked) {
          prefix = Buffer.concat([prefix, chunk.subarray(0, Math.max(0, 512 - prefix.length))]);
          if (prefix.length >= 512 || (expected !== null && size >= expected)) {
            checkContent(response.headers.get('content-type') || '', prefix, kind);
            checked = true;
          }
        }
        if (name) {
          this.reserve(job, chunk.length);
          await handle.writeFile(chunk);
        } else chunks.push(chunk);
      }
      if (!checked) checkContent(response.headers.get('content-type') || '', prefix, kind);
      if (expected !== null && size !== expected)
        throw new HttpError('视频下载不完整，请重试', 502);
      if (!size) throw new HttpError('媒体服务器返回了空文件', 502);
      if (kind === 'key' && size !== 16) throw new HttpError('HLS AES-128 密钥长度无效', 422);
      complete = true;
      return {
        size,
        bytes: name ? undefined : Buffer.concat(chunks),
        contentType: response.headers.get('content-type') || '',
      };
    } finally {
      result.release();
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
      await handle?.close();
    }
  }

  async video(job) {
    const result = await this.request(job, job.source.url);
    const contentType = result.response.headers.get('content-type') || '';
    const name = `video${extension(result.url, contentType)}`;
    // consume owns cancellation even when a malformed length is encountered.
    const { size } = await this.consume(job, result, { name, kind: 'video' });
    job.mainFile = name;
    job.files.push({
      name,
      size,
      contentType: /^(?:video|audio)\//i.test(contentType)
        ? contentType
        : 'application/octet-stream',
    });
    job.completedFiles = 1;
  }

  async hls(job) {
    const seen = new Map();
    const active = new Set();
    let sequence = 0;
    const cache = async (input, kind, depth = 0, root = false) => {
      const url = checkedUrl(input, { allowPrivate: this.http.allowPrivate }).href;
      if (depth > MAX_DEPTH) throw new HttpError('HLS 播放列表嵌套过深', 422);
      const identity = `${kind}:${url}`;
      if (active.has(identity)) throw new HttpError('HLS 播放列表存在循环引用', 422);
      if (seen.has(identity)) return seen.get(identity);
      if (seen.size >= MAX_FILES) throw new HttpError('HLS 文件数量超过缓存限制', 422);
      const number = ++sequence;
      const name = root
        ? 'index.m3u8'
        : kind === 'manifest'
          ? `playlist-${number}.m3u8`
          : `asset-${number}${kind === 'key' ? '.key' : extension(url)}`;
      seen.set(identity, name);
      job.totalFiles = seen.size;
      active.add(identity);
      const result = await this.request(job, url);
      if (kind !== 'manifest') {
        const file = await this.consume(job, result, {
          name,
          kind,
          ...(kind === 'key' ? { maxBytes: 16 } : {}),
        });
        job.files.push({
          name,
          size: file.size,
          contentType:
            kind === 'key'
              ? 'application/octet-stream'
              : /^(?:video|audio)\/|^text\/vtt/i.test(file.contentType)
                ? file.contentType
                : 'application/octet-stream',
        });
      } else {
        const { bytes } = await this.consume(job, result, { kind, maxBytes: MAX_MANIFEST_BYTES });
        const raw = bytes.toString('utf8').replace(/^\uFEFF/, '');
        if (!raw.trimStart().startsWith('#EXTM3U'))
          throw new HttpError('HLS 播放列表格式无效', 422);
        if (
          /#EXT-X-(?:DEFINE|PART|PRELOAD-HINT|RENDITION-REPORT|CONTENT-STEERING|SESSION-DATA):/i.test(
            raw,
          )
        )
          throw new HttpError('当前 HLS 播放列表含有不支持离线缓存的扩展', 422);
        const master = /^#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF):/im.test(raw);
        if (!master && !/^#EXT-X-ENDLIST\s*$/im.test(raw))
          throw new HttpError('直播流不支持离线缓存，请选择点播视频', 422);
        if (!master && !/^#EXTINF:/im.test(raw))
          throw new HttpError('HLS 播放列表中没有视频分片', 422);
        let nextPlaylist = false;
        let references = 0;
        let mediaReferences = 0;
        const lines = [];
        const target = (uri) => {
          if (!uri || /\{\$|[\x00-\x20\\]/.test(uri))
            throw new HttpError('HLS 媒体地址不支持离线缓存', 422);
          return checkedUrl(new URL(uri, result.url).href, { allowPrivate: this.http.allowPrivate })
            .href;
        };
        for (const sourceLine of raw.split(/\r?\n/)) {
          const line = sourceLine.trim();
          if (!line) {
            lines.push('');
            continue;
          }
          if (!line.startsWith('#')) {
            const child = nextPlaylist ? 'manifest' : 'segment';
            if (master && !nextPlaylist) throw new HttpError('HLS 主播放列表格式无效', 422);
            lines.push(await cache(target(line), child, depth + (child === 'manifest' ? 1 : 0)));
            references++;
            if (child === 'segment') mediaReferences++;
            nextPlaylist = false;
            continue;
          }
          if (/^#EXT-X-STREAM-INF:/i.test(line)) nextPlaylist = true;
          const isKey = /^#EXT-X-(?:SESSION-)?KEY:/i.test(line);
          if (isKey) {
            const method = /(?:^|[:,])\s*METHOD=([^,\s]+)/i.exec(line)?.[1];
            const format = /(?:^|[:,])\s*KEYFORMAT="([^"]+)"/i.exec(line)?.[1];
            const formatPresent = /(?:^|[:,])\s*KEYFORMAT\s*=/i.test(line);
            if (!['NONE', 'AES-128'].includes(method) || (formatPresent && format !== 'identity'))
              throw new HttpError('暂不支持缓存 DRM 或此加密方式的视频', 422);
            if (method === 'AES-128' && !/(?:^|[:,])\s*URI="[^"]+"/i.test(line))
              throw new HttpError('HLS 加密密钥地址无效', 422);
          }
          if (/(?:^|[:,])\s*[^,=:]*URI\s*=/i.test(line)) {
            if (!/^#EXT-X-(?:KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF):/i.test(line))
              throw new HttpError('HLS 播放列表含有不支持的外部引用', 422);
            const matches = [...line.matchAll(/(?:^|[:,])\s*URI="([^"]+)"/gi)];
            if (
              matches.length !== 1 ||
              (line.match(/(?:^|[:,])\s*[^,=:]*URI\s*=/gi) || []).length !== 1
            )
              throw new HttpError('HLS 媒体地址格式无效', 422);
            const uri = matches[0][1];
            const child = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/i.test(line)
              ? 'manifest'
              : isKey
                ? 'key'
                : 'segment';
            const local = await cache(target(uri), child, depth + (child === 'manifest' ? 1 : 0));
            lines.push(line.replace(/((?:^|[:,])\s*URI=")[^"]+("?)/i, `$1${local}$2`));
            references++;
          } else lines.push(line);
        }
        if (nextPlaylist || !references || (!master && !mediaReferences))
          throw new HttpError('HLS 播放列表不完整', 422);
        const rewritten = Buffer.from(lines.join('\n'));
        this.reserve(job, rewritten.length);
        await writeFile(join(this.directory, job.id, name), rewritten, { mode: 0o600, flag: 'wx' });
        job.files.push({
          name,
          size: rewritten.length,
          contentType: 'application/vnd.apple.mpegurl',
        });
      }
      job.completedFiles++;
      active.delete(identity);
      return name;
    };
    job.mainFile = await cache(job.source.url, 'manifest', 0, true);
  }

  remove(id) {
    return this.lock(async () => {
      const job = this.jobs.get(id);
      if (!job || job.removed) throw new HttpError('缓存任务不存在', 404);
      job.removed = true;
      job.controller?.abort();
      await job.promise?.catch(() => {});
      await rm(join(this.directory, job.id), { recursive: true, force: true });
      this.usedBytes -= job.bytes;
      this.jobs.delete(id);
      await this.persist();
      return this.list();
    });
  }

  removeBatch(ids) {
    return this.lock(async () => {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > MAX_JOBS ||
        ids.some((id) => typeof id !== 'string' || !ID.test(id))
      )
        throw new HttpError('请选择 1 至 200 个有效缓存任务');
      const jobs = [...new Set(ids)].map((id) => this.jobs.get(id)).filter(Boolean);
      for (const job of jobs) {
        job.removed = true;
        job.controller?.abort();
      }
      try {
        await Promise.all(jobs.map((job) => job.promise?.catch(() => {})));
        for (const job of jobs) {
          await rm(join(this.directory, job.id), { recursive: true, force: true });
          this.usedBytes -= job.bytes;
          this.jobs.delete(job.id);
        }
      } finally {
        for (const job of jobs) {
          if (!this.jobs.has(job.id)) continue;
          job.removed = false;
          job.status = 'error';
          job.error = '缓存未能删除，请重试';
          delete job.source;
          delete job.rule;
        }
        await this.persist();
      }
      return this.list();
    });
  }

  clear() {
    return this.lock(async () => {
      this.paused = true;
      try {
        const jobs = [...this.jobs.values()];
        for (const job of jobs) {
          job.removed = true;
          job.controller?.abort();
        }
        await Promise.all(jobs.map((job) => job.promise?.catch(() => {})));
        for (const job of jobs)
          await rm(join(this.directory, job.id), { recursive: true, force: true });
        this.jobs.clear();
        this.usedBytes = 0;
        await this.persist();
        return this.list();
      } finally {
        this.paused = false;
      }
    });
  }

  ready(id) {
    const job = this.jobs.get(id);
    if (!job || job.removed) throw new HttpError('缓存任务不存在', 404);
    if (job.status !== 'complete') throw new HttpError('视频尚未缓存完成', 409);
    return job;
  }

  file(id, name) {
    const job = this.ready(id);
    const file = FILE.test(name) && job.files.find((entry) => entry.name === name);
    if (!file) throw new HttpError('缓存文件不存在', 404);
    return { path: join(this.directory, job.id, name), contentType: file.contentType };
  }

  download(id) {
    const job = this.ready(id);
    const stem =
      `${job.title} ${job.episodeName}`
        .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_')
        .slice(0, 120)
        .trim() || 'video';
    if (job.type === 'video')
      return {
        ...this.file(id, job.mainFile),
        filename: `${stem}${extname(job.mainFile)}`,
        type: 'video',
      };
    return {
      type: 'hls',
      directory: join(this.directory, job.id),
      files: job.files,
      contentType: 'application/gzip',
      filename: `${stem}.tar.gz`,
    };
  }

  async serveDownload(req, res, id) {
    const file = this.download(id);
    res.set('Cache-Control', 'no-store');
    if (file.type === 'video') {
      await new Promise((resolve, reject) =>
        res.download(file.path, file.filename, (error) => (error ? reject(error) : resolve())),
      );
      return;
    }
    res.type(file.contentType).attachment(file.filename);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await streamArchive(file.directory, file.files, res);
  }

  close() {
    return this.lock(async () => {
      this.closed = true;
      const jobs = [...this.jobs.values()];
      for (const job of jobs) {
        job.controller?.abort();
        if (job.status === 'queued') {
          job.status = 'error';
          job.error = '缓存任务已中断，请重试';
          delete job.source;
          delete job.rule;
        }
      }
      await Promise.all(jobs.map((job) => job.promise?.catch(() => {})));
      await this.persist();
    });
  }
}
