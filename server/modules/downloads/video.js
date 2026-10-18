import { open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from '../../lib/http.js';
import { checkContent, contentLength } from './content.js';
import { fingerprint, parallel } from './transfers.js';

function rangeHeader(response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (!match || response.headers.get('content-encoding')) return null;
  const [start, end, total] = match.slice(1).map(Number);
  return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total
    ? { start, end, total }
    : null;
}

function validator(response) {
  const etag = response.headers.get('etag');
  if (etag && /^"[^\r\n]*"$/.test(etag)) return etag;
  const modified = response.headers.get('last-modified');
  return modified && Number.isFinite(Date.parse(modified)) ? modified : null;
}

async function cancel(result) {
  result.release();
  await result.response.body.cancel().catch(() => {});
}

export async function restoreVideo(manager, job, resume) {
  if (resume.mode === 'sequential') {
    if (
      resume.type !== 'video' ||
      !/^[a-f0-9]{64}$/.test(resume.identity) ||
      (resume.validator !== null && !/^[a-f0-9]{64}$/.test(resume.validator)) ||
      !/^video\.[a-z0-9]{1,8}$/.test(resume.name) ||
      !Number.isSafeInteger(resume.received) ||
      resume.received < 0 ||
      (resume.total !== null &&
        (!Number.isSafeInteger(resume.total) || resume.total < resume.received))
    )
      throw new Error('invalid sequential checkpoint');
    const info = await stat(join(manager.directory, job.id, 'video.part'));
    if (!info.isFile() || info.size < resume.received) throw new Error('missing partial file');
    job.resume = structuredClone(resume);
    job.bytes = resume.received;
    job.totalBytes = resume.total;
    job.totalFiles = 1;
    return;
  }
  if (
    resume.type !== 'video' ||
    !/^[a-f0-9]{64}$/.test(resume.identity) ||
    (resume.validator !== null && !/^[a-f0-9]{64}$/.test(resume.validator || '')) ||
    !/^video\.[a-z0-9]{1,8}$/.test(resume.name) ||
    !Number.isSafeInteger(resume.total) ||
    resume.total < 1 ||
    !Array.isArray(resume.ranges) ||
    !resume.ranges.length ||
    resume.ranges.length > 8
  )
    throw new Error('invalid checkpoint');
  let next = 0;
  let bytes = 0;
  let extent = 0;
  for (const range of resume.ranges) {
    if (
      ![range.start, range.end, range.received].every(Number.isSafeInteger) ||
      range.start !== next ||
      range.end < range.start ||
      range.received < 0 ||
      range.received > range.end - range.start + 1
    )
      throw new Error('invalid range');
    next = range.end + 1;
    bytes += range.received;
    if (range.received) extent = Math.max(extent, range.start + range.received);
  }
  if (next !== resume.total) throw new Error('invalid total');
  const info = await stat(join(manager.directory, job.id, 'video.part'));
  if (!info.isFile() || info.size < extent || info.size > resume.total)
    throw new Error('missing partial file');
  job.resume = structuredClone(resume);
  job.bytes = bytes;
  job.totalBytes = resume.total;
  job.totalFiles = 1;
}

export async function downloadVideo(manager, job, extension) {
  let probe = await manager.request(job, job.source.url, {
    headers: { range: 'bytes=0-0' },
    statuses: [200, 206, 416],
  });
  const range = rangeHeader(probe.response);
  const tag = validator(probe.response);
  const contentType = probe.response.headers.get('content-type') || '';
  const name = `video${extension(probe.url, contentType)}`;
  const identity = fingerprint(probe.url);
  // A real 206 probe is required: Accept-Ranges alone is not reliable.
  if (probe.response.status !== 206 || !range || range.start !== 0 || range.end !== 0) {
    if (probe.response.status !== 200) {
      await cancel(probe);
      probe = null;
    }
    return sequential(manager, job, probe, extension);
  }
  await cancel(probe);
  checkContent(contentType, Buffer.alloc(0), 'video');
  if (range.total > manager.maxBytes - manager.usedBytes + job.bytes)
    throw new HttpError('视频缓存空间不足，请清理缓存后重试', 507);
  const previous = job.resume;
  const reusable =
    previous?.type === 'video' &&
    previous.mode !== 'sequential' &&
    previous.identity === identity &&
    previous.validator === (tag ? fingerprint(tag) : null) &&
    previous.total === range.total &&
    previous.name === name;
  if (!reusable) {
    await manager.discard(job);
    await manager.ensureDirectory(job);
    const count = Math.min(job.threads, range.total);
    job.resume = {
      type: 'video',
      identity,
      validator: tag ? fingerprint(tag) : null,
      name,
      total: range.total,
      ranges: Array.from({ length: count }, (_, i) => ({
        start: Math.floor((i * range.total) / count),
        end: Math.floor(((i + 1) * range.total) / count) - 1,
        received: 0,
      })),
    };
  }
  const resume = job.resume;
  // Raising the setting on retry can split unfinished ranges without moving
  // any bytes that have already been downloaded.
  while (resume.ranges.length < job.threads) {
    const part = resume.ranges.reduce((largest, candidate) =>
      candidate.end - candidate.start - candidate.received >
      largest.end - largest.start - largest.received
        ? candidate
        : largest,
    );
    const remaining = part.end - part.start - part.received + 1;
    if (remaining < 2) break;
    const end = part.end;
    part.end = part.start + part.received + Math.floor(remaining / 2) - 1;
    resume.ranges.splice(resume.ranges.indexOf(part) + 1, 0, {
      start: part.end + 1,
      end,
      received: 0,
    });
  }
  job.totalBytes = range.total;
  job.totalFiles = 1;
  const path = join(manager.directory, job.id, 'video.part');
  const handle = await open(path, reusable ? 'r+' : 'w+', 0o600);
  try {
    await manager.persist();
    await parallel(job, resume.ranges, job.threads, async (part) => {
      const start = tag ? part.start + part.received : part.start;
      if (start > part.end) return;
      const result = await manager.request(job, job.source.url, {
        headers: { range: `bytes=${start}-${part.end}`, ...(tag ? { 'if-range': tag } : {}) },
        statuses: [200, 206, 416],
      });
      if (result.response.status !== 206) {
        await cancel(result);
        const error = new HttpError('源站不支持范围下载，改用单连接', 502);
        error.rangeUnsupported = true;
        throw error;
      }
      const actual = rangeHeader(result.response);
      let reader;
      try {
        if (
          !actual ||
          actual.start !== start ||
          actual.end !== part.end ||
          actual.total !== resume.total ||
          (contentLength(result.response) !== null &&
            contentLength(result.response) !== part.end - start + 1) ||
          (tag && validator(result.response) !== tag)
        )
          throw new HttpError('源站返回的下载范围或文件版本不一致，请重试', 502);
        checkContent(result.response.headers.get('content-type') || '', Buffer.alloc(0), 'video');
        reader = result.response.body.getReader();
        let position = start;
        for (;;) {
          result.signal.throwIfAborted();
          const { done, value } = await reader.read();
          result.touch();
          if (done) break;
          if (position + value.length > part.end + 1)
            throw new HttpError('源站返回的数据超出下载范围', 502);
          let skip = Math.min(value.length, Math.max(0, part.start + part.received - position));
          if (skip) {
            const saved = Buffer.alloc(skip);
            const { bytesRead } = await handle.read(saved, 0, skip, position);
            if (bytesRead !== skip || !saved.equals(Buffer.from(value.subarray(0, skip)))) {
              const lost = part.start + part.received - position;
              manager.usedBytes -= lost;
              job.bytes -= lost;
              part.received -= lost;
              skip = 0;
            }
          }
          const suffix = value.subarray(skip);
          manager.reserve(job, suffix.length);
          let written = 0;
          while (written < suffix.length) {
            const { bytesWritten } = await handle.write(
              suffix,
              written,
              suffix.length - written,
              part.start + part.received,
            );
            if (!bytesWritten) throw new Error('无法写入视频缓存');
            written += bytesWritten;
            part.received += bytesWritten;
          }
          position += value.length;
          if (Date.now() - (job.checkpointAt || 0) > 1000) {
            job.checkpointAt = Date.now();
            await manager.persist();
          }
        }
        if (part.received !== part.end - part.start + 1)
          throw new HttpError('视频下载不完整，请重试', 502);
      } finally {
        result.release();
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        } else await result.response.body.cancel().catch(() => {});
      }
    });
    const prefix = Buffer.alloc(Math.min(512, resume.total));
    await handle.read(prefix, 0, prefix.length, 0);
    checkContent(contentType, prefix, 'video');
    await handle.sync();
  } catch (error) {
    const retained = resume.ranges.reduce((sum, part) => sum + part.received, 0);
    manager.usedBytes -= job.bytes - retained;
    job.bytes = retained;
    if (!error.rangeUnsupported) throw error;
    await handle.close();
    job.transferController = new AbortController();
    return sequential(manager, job, null, extension);
  } finally {
    await handle.close();
  }
  await rename(path, join(manager.directory, job.id, name));
  job.mainFile = name;
  job.files = [{ name, size: resume.total, contentType: mediaType(contentType) }];
  job.completedFiles = 1;
}

function mediaType(value) {
  return /^(?:video|audio)\//i.test(value) ? value : 'application/octet-stream';
}

async function sequential(manager, job, result, extension) {
  result ||= await manager.request(job, job.source.url);
  const contentType = result.response.headers.get('content-type') || '';
  const name = `video${extension(result.url, contentType)}`;
  const reader = result.response.body.getReader();
  let handle;
  let complete = false;
  try {
    const total = contentLength(result.response);
    const identity = fingerprint(result.url);
    const tag = validator(result.response);
    const version = tag ? fingerprint(tag) : null;
    checkContent(contentType, Buffer.alloc(0), 'video');
    const previous = job.resume;
    const reusable =
      previous?.mode === 'sequential' &&
      previous.identity === identity &&
      previous.validator === version &&
      previous.name === name &&
      previous.total === total;
    if (!reusable) {
      await manager.discard(job);
      await manager.ensureDirectory(job);
      job.resume = {
        type: 'video',
        mode: 'sequential',
        identity,
        validator: version,
        name,
        total,
        received: 0,
      };
    }
    const resume = job.resume;
    job.totalBytes = total;
    job.totalFiles = 1;
    if (total !== null && total > manager.maxBytes - manager.usedBytes + job.bytes)
      throw new HttpError('视频缓存空间不足，请清理缓存后重试', 507);
    handle = await open(
      join(manager.directory, job.id, 'video.part'),
      reusable ? 'r+' : 'w+',
      0o600,
    );
    await handle.truncate(resume.received);
    await manager.persist();
    let size = 0;
    let prefix = Buffer.alloc(0);
    for (;;) {
      result.signal.throwIfAborted();
      const { done, value } = await reader.read();
      result.touch();
      if (done) break;
      const chunk = Buffer.from(value);
      const offset = size;
      size += chunk.length;
      if (size > manager.maxBytes || (total !== null && size > total))
        throw new HttpError('媒体文件超过缓存限制', 507);
      if (prefix.length < 512) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
        checkContent(contentType, prefix, 'video');
      }
      // A 200 response always starts at byte zero. Verify retained bytes before
      // skipping them; only new bytes count against the cache quota.
      let skip = Math.min(chunk.length, Math.max(0, resume.received - offset));
      if (skip) {
        const saved = Buffer.alloc(skip);
        const { bytesRead } = await handle.read(saved, 0, skip, offset);
        if (bytesRead !== skip || !saved.equals(chunk.subarray(0, skip))) {
          await handle.truncate(offset);
          manager.usedBytes -= job.bytes - offset;
          job.bytes = resume.received = offset;
          skip = 0;
        }
      }
      const suffix = chunk.subarray(skip);
      if (suffix.length) {
        manager.reserve(job, suffix.length);
        let written = 0;
        while (written < suffix.length) {
          const { bytesWritten } = await handle.write(
            suffix,
            written,
            suffix.length - written,
            offset + skip + written,
          );
          if (!bytesWritten) throw new Error('无法写入视频缓存');
          written += bytesWritten;
          resume.received += bytesWritten;
        }
      }
      if (Date.now() - (job.checkpointAt || 0) > 1000) {
        job.checkpointAt = Date.now();
        await manager.persist();
      }
    }
    if (!size || (total !== null && size !== total) || size < resume.received)
      throw new HttpError('视频下载不完整，请重试', 502);
    await handle.sync();
    complete = true;
  } finally {
    result.release();
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
    await handle?.close();
    if (job.resume?.mode === 'sequential') {
      manager.usedBytes -= job.bytes - job.resume.received;
      job.bytes = job.resume.received;
    }
  }
  await rename(
    join(manager.directory, job.id, 'video.part'),
    join(manager.directory, job.id, name),
  );
  job.mainFile = name;
  job.files = [{ name, size: job.bytes, contentType: mediaType(contentType) }];
  job.completedFiles = 1;
}
