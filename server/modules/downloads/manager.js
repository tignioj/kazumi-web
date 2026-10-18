import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { checkedUrl, cleanHeaders, HttpError } from '../../lib/http.js';
import { headersForSession } from '../playback/session-store.js';
import { filterHlsAds } from '../playback/hls-ad-filter.js';
import { streamArchive } from './archive.js';
import { contentLength, checkContent } from './content.js';
import { fingerprint, parallel } from './transfers.js';
import { downloadVideo, restoreVideo } from './video.js';
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  normalizeDownloadSettings,
} from '../../../shared/download-settings.js';

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
    resumable: Boolean(job.resume && job.bytes > 0),
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
  constructor({ directory, http, media, getRule, maxBytes = 10 * 1024 ** 3, concurrency = 2 }) {
    this.directory = resolve(directory);
    this.http = http;
    this.media = media;
    this.getRule = getRule;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new HttpError('视频缓存容量必须为正整数');
    this.maxBytes = maxBytes;
    this.concurrency = Math.min(4, Math.max(1, Number(concurrency) || 2));
    this.settings = { ...DEFAULT_DOWNLOAD_SETTINGS };
    this.jobs = new Map();
    this.usedBytes = 0;
    this.active = new Set();
    this.mutations = Promise.resolve();
    this.persistence = Promise.resolve();
    this.closed = false;
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.settings = normalizeDownloadSettings(
        JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8')),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw new HttpError('下载设置损坏，无法读取', 500);
    }
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
        job.files = [];
        job.bytes = 0;
        let recovered = false;
        if (data.status !== 'complete') {
          try {
            if (data.resume?.type === 'video' && data.type === 'video') {
              await restoreVideo(this, job, data.resume);
              recovered = true;
            } else if (
              data.resume?.type === 'hls' &&
              data.type === 'hls' &&
              /^[a-f0-9]{64}$/.test(data.resume.identity) &&
              Array.isArray(data.files) &&
              data.files.length <= MAX_FILES
            ) {
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
              job.resume = data.resume;
              job.completedFiles = job.files.length;
              job.totalFiles = Number.isSafeInteger(data.totalFiles) ? data.totalFiles : 0;
              recovered = true;
            }
          } catch {
            /* Discard an invalid or missing checkpoint. */
          }
        }
        if (recovered) {
          this.usedBytes += job.bytes;
          const keep = new Set(
            job.resume.type === 'video' ? ['video.part'] : job.files.map((file) => file.name),
          );
          for (const name of await readdir(join(this.directory, job.id)))
            if (!keep.has(name))
              await rm(join(this.directory, job.id, name), { recursive: true, force: true });
        } else {
          await rm(join(this.directory, job.id), { recursive: true, force: true });
          job.bytes = 0;
          job.files = [];
          job.completedFiles = 0;
          delete job.resume;
        }
        job.status = data.status === 'paused' ? 'paused' : 'error';
        if (job.status === 'error')
          job.error =
            data.status === 'error'
              ? textField(data.error, '缓存失败，请重试')
              : recovered
                ? '缓存任务已中断，重试后继续下载'
                : '缓存任务已中断或文件不完整，请重新缓存';
      }
      this.jobs.set(job.id, job);
    }
    // An interrupted atomic write or a crash before indexing may leave files.
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (
        (entry.isDirectory() && ID.test(entry.name) && !this.jobs.has(entry.name)) ||
        /^(?:index|settings)\.[a-f0-9-]+\.tmp$/.test(entry.name)
      )
        await rm(join(this.directory, entry.name), { recursive: true, force: true });
    }
    await this.persist();
    return this;
  }

  saveSettings(input) {
    return this.lock(async () => {
      let next;
      try {
        next = normalizeDownloadSettings(input);
      } catch (error) {
        throw new HttpError(error.message);
      }
      const temporary = join(this.directory, `settings.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, join(this.directory, 'settings.json'));
      } finally {
        await rm(temporary, { force: true });
      }
      this.settings = next;
      return next;
    });
  }

  async discard(job) {
    await rm(join(this.directory, job.id), { recursive: true, force: true });
    this.usedBytes -= job.bytes;
    job.bytes = 0;
    job.files = [];
    job.completedFiles = 0;
    job.totalBytes = null;
    delete job.resume;
  }

  ensureDirectory(job) {
    return mkdir(join(this.directory, job.id), { recursive: true, mode: 0o700 });
  }

  retryJob(existing, input, media) {
    Object.assign(existing, media, { status: 'queued' });
    delete existing.needsResolve;
    for (const key of ['title', 'episodeName', 'image'])
      if (typeof input[key] === 'string') existing[key] = textField(input[key]);
    delete existing.error;
    return existing;
  }

  pause(id) {
    return this.lock(async () => {
      if (this.closed) throw new HttpError('缓存服务已关闭', 503);
      const job = this.jobs.get(id);
      if (!job || job.removed) throw new HttpError('缓存任务不存在', 404);
      if (['paused', 'complete'].includes(job.status)) return publicJob(job);
      if (!['queued', 'downloading'].includes(job.status))
        throw new HttpError('当前任务无法暂停', 409);
      job.pauseRequested = true;
      if (job.status === 'queued') job.status = 'paused';
      job.controller?.abort();
      await job.promise?.catch(() => {});
      delete job.pauseRequested;
      delete job.error;
      await this.persist();
      return publicJob(job);
    });
  }

  resume(id, { sessionOwner } = {}) {
    return this.lock(async () => {
      if (this.closed) throw new HttpError('缓存服务已关闭', 503);
      const job = this.jobs.get(id);
      if (!job || job.removed) throw new HttpError('缓存任务不存在', 404);
      if (['queued', 'downloading', 'complete'].includes(job.status)) return publicJob(job);
      if (job.status !== 'paused') throw new HttpError('当前任务未暂停，请重试下载', 409);
      await job.promise?.catch(() => {});
      if (!job.source || job.needsResolve || job.type === 'pending') {
        job.rule = this.getRule(job.ruleName);
        job.needsResolve = true;
      }
      if (sessionOwner !== undefined) job.sessionOwner = sessionOwner;
      job.status = 'queued';
      delete job.error;
      await this.persist();
      const result = publicJob(job);
      this.pump();
      return result;
    });
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
      if (this.usedBytes >= this.maxBytes && !existing?.resume)
        throw new HttpError('视频缓存空间不足，请先清理缓存', 507);
      const media = this.mediaSource(input.mediaUrl);
      if (existing?.status === 'error') await existing.promise?.catch(() => {});
      if (existing && !existing.resume) {
        await rm(join(this.directory, existing.id), { recursive: true, force: true });
        this.jobs.delete(existing.id);
      }
      const job = existing?.resume ? this.retryJob(existing, input, media) : newJob(input, media);
      this.jobs.set(job.id, job);
      await this.persist();
      const result = publicJob(job);
      this.pump();
      return result;
    });
  }

  createBatch(input, rule, { sessionOwner } = {}) {
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
      if (pending.some(({ existing }) => !existing?.resume) && this.usedBytes >= this.maxBytes)
        throw new HttpError('视频缓存空间不足，请先清理缓存', 507);
      for (const entry of pending) {
        await entry.existing?.promise?.catch(() => {});
        if (entry.existing && !entry.existing.resume) {
          await rm(join(this.directory, entry.existing.id), { recursive: true, force: true });
          this.jobs.delete(entry.existing.id);
        }
        const media = { rule, sessionOwner };
        const job = entry.existing?.resume
          ? this.retryJob(entry.existing, entry.input, media)
          : newJob(entry.input, { type: 'pending', ...media });
        job.needsResolve = true;
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
      adBlocker: verified.adBlocker === true,
      headers: cleanHeaders(verified.headers),
      session: verified.sessionId
        ? structuredClone(this.media.sessions.get(verified.sessionId))
        : null,
    };
    delete source.headers.range;
    delete source.headers['if-range'];
    return { type: verified.kind, source };
  }

  persist() {
    const write = async () => {
      const items = [...this.jobs.values()]
        .filter((job) => !job.removed)
        .map((job) => ({
          ...publicJob(job),
          mainFile: job.mainFile,
          files: job.files.map((file) => ({ ...file })),
          resume: job.resume ? structuredClone(job.resume) : undefined,
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
      job.transferController = new AbortController();
      job.threads = this.settings.threads;
      this.active.add(job.id);
      job.promise = this.run(job).finally(() => {
        this.active.delete(job.id);
        if (job.status !== 'paused') {
          delete job.source;
          delete job.rule;
          delete job.sessionOwner;
        }
        delete job.controller;
        delete job.transferController;
        this.pump();
      });
      // run() records expected failures; a failed index write must not create
      // an unhandled rejection or prevent later queued jobs from running.
      job.promise.catch(() => {});
    }
  }

  async run(job) {
    try {
      await mkdir(join(this.directory, job.id), { recursive: true, mode: 0o700 });
      await this.persist();
      if (job.type === 'pending' || job.needsResolve) {
        const resolved = await this.media.resolve(job.rule, job.episodeUrl, {
          signal: job.controller.signal,
          ...(job.sessionOwner !== undefined ? { sessionOwner: job.sessionOwner } : {}),
        });
        job.controller.signal.throwIfAborted();
        if (!['video', 'hls'].includes(resolved.type))
          throw new HttpError('当前播放来源暂不支持视频缓存，请切换可直接播放的视频线路', 422);
        Object.assign(job, this.mediaSource(resolved.url));
        delete job.needsResolve;
      }
      if (job.resume && job.resume.type !== job.type) {
        await this.discard(job);
        await mkdir(join(this.directory, job.id), { mode: 0o700 });
      }
      if (job.type === 'hls') await this.hls(job);
      else await this.video(job);
      // A pause arriving during finalization may race with a finished file.
      if (!job.pauseRequested || job.removed) job.controller.signal.throwIfAborted();
      delete job.resume;
      job.status = 'complete';
      job.totalBytes = job.bytes;
      job.totalFiles = job.completedFiles;
      await this.persist();
    } catch (error) {
      if (
        !job.resume ||
        (job.resume.type === 'video' && !job.resume.validator && !job.pauseRequested) ||
        job.removed ||
        [400, 422, 507].includes(error.status)
      ) {
        await this.discard(job);
      } else if (job.resume.type === 'hls') {
        // Only finished, validated assets are checkpoints; discard partial files.
        const keep = new Set(job.files.map((file) => file.name));
        for (const name of await readdir(join(this.directory, job.id)))
          if (!keep.has(name)) await rm(join(this.directory, job.id, name), { force: true });
        const retained = job.files.reduce((sum, file) => sum + file.size, 0);
        this.usedBytes -= job.bytes - retained;
        job.bytes = retained;
        job.completedFiles = job.files.length;
      }
      job.status = job.pauseRequested && !job.removed ? 'paused' : 'error';
      if (job.status === 'paused') delete job.error;
      else
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

  async request(job, url, { headers: extraHeaders = {}, statuses = [200] } = {}) {
    checkedUrl(url, { allowPrivate: this.http.allowPrivate });
    const controller = new AbortController();
    const signal = AbortSignal.any([
      job.controller.signal,
      job.transferController.signal,
      controller.signal,
    ]);
    let timer = setTimeout(() => controller.abort(), 20000);
    const headersForUrl = (target) => {
      if (job.source.session)
        return { ...headersForSession(job.source.session, target), ...extraHeaders };
      const headers = { ...job.source.headers, ...extraHeaders };
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
      if (!statuses.includes(result.response.status) || !result.response.body) {
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
    await downloadVideo(this, job, extension);
  }

  async hls(job) {
    const seen = new Map();
    const active = new Set();
    const assets = [];
    const manifests = [];
    const identities = [];
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
      if (kind !== 'manifest') {
        assets.push({ name, kind, url });
        active.delete(identity);
        return name;
      } else {
        const result = await this.request(job, url);
        const { bytes } = await this.consume(job, result, { kind, maxBytes: MAX_MANIFEST_BYTES });
        const original = bytes.toString('utf8').replace(/^\uFEFF/, '');
        const raw = job.source.adBlocker ? filterHlsAds(original, result.url) : original;
        identities.push([url, raw]);
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
        manifests.push({ name, bytes: rewritten });
      }
      active.delete(identity);
      return name;
    };
    const mainFile = await cache(job.source.url, 'manifest', 0, true);
    const identity = fingerprint(JSON.stringify({ identities, assets }));
    if (job.resume?.type !== 'hls' || job.resume.identity !== identity) {
      await this.discard(job);
      await this.ensureDirectory(job);
      job.resume = { type: 'hls', identity };
    }
    job.totalFiles = seen.size;
    job.completedFiles = job.files.length;
    const completed = new Set(job.files.map((file) => file.name));
    await this.persist();
    await parallel(
      job,
      assets.filter((asset) => !completed.has(asset.name)),
      job.threads,
      async ({ name, kind, url }) => {
        const result = await this.request(job, url);
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
        job.completedFiles++;
        await this.persist();
      },
    );
    for (const { name, bytes } of manifests) {
      if (completed.has(name)) continue;
      this.reserve(job, bytes.length);
      await writeFile(join(this.directory, job.id, name), bytes, { mode: 0o600, flag: 'wx' });
      job.files.push({ name, size: bytes.length, contentType: 'application/vnd.apple.mpegurl' });
      job.completedFiles++;
      await this.persist();
    }
    job.mainFile = mainFile;
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
