import { HttpError } from '../../lib/http.js';

const CHUNK_BYTES = 512 * 1024;
const PREFETCH_BYTES = 2 * 1024 * 1024;
const HEDGE_DELAY_MS = 400;
const RESUME_DELAY_MS = 4000;

function fileVersion(response, total) {
  const etag = response.headers.get('etag');
  const modified = response.headers.get('last-modified');
  return etag && !etag.startsWith('W/')
    ? { header: 'etag', value: etag, total }
    : modified
      ? { header: 'last-modified', value: modified, total }
      : null;
}

async function readChunk(response, size, progress) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > size) throw new HttpError('媒体范围响应超出请求大小', 502);
      chunks.push(value);
      progress?.(chunks, length);
    }
    if (length !== size) throw new HttpError('媒体范围响应不完整', 502);
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Preserve the browser's Range while fetching bounded pieces independently.
// A slow CDN connection must not hold a seek behind the rest of an episode.
export async function requestVideoRange(http, url, options, onHeaders) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(options.headers.range || '');
  const start = Number(match?.[1]);
  const requestedEnd = match?.[2] ? Number(match[2]) : Infinity;
  if (
    !match ||
    !Number.isSafeInteger(start) ||
    (requestedEnd !== Infinity && !Number.isSafeInteger(requestedEnd)) ||
    requestedEnd < start ||
    requestedEnd - start + 1 <= CHUNK_BYTES
  )
    return http.request(url, options);

  const lifetime = new AbortController();
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), lifetime.signal]);
  async function fetchChunk(from, to, isFirst, attemptSignal, version, progress) {
    const range = `bytes=${from}-${to}`;
    const applyRange = (headers) => ({
      ...headers,
      range,
      ...(version && { 'if-range': version.value }),
    });
    const result = await http.request(url, {
      ...options,
      headers: applyRange(options.headers),
      ...(options.headersForUrl && {
        headersForUrl: (target) => applyRange(options.headersForUrl(target)),
      }),
      signal: attemptSignal,
    });
    const { response } = result;
    if (isFirst) onHeaders?.();
    if (
      isFirst &&
      !version &&
      (response.status !== 206 || response.headers.get('content-encoding'))
    )
      return result;
    try {
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get('content-range') || '',
      );
      const first = Number(contentRange?.[1]);
      const last = Number(contentRange?.[2]);
      const total = Number(contentRange?.[3]);
      if (
        response.status !== 206 ||
        !contentRange ||
        !Number.isSafeInteger(total) ||
        total <= 0 ||
        first !== from ||
        last !== Math.min(to, total - 1) ||
        last < first ||
        response.headers.get('content-encoding') ||
        (version &&
          (total !== version.total || response.headers.get(version.header) !== version.value))
      )
        throw new HttpError('媒体范围或文件版本已变化，请重新解析', 502);
      const bytes = await readChunk(response, last - first + 1, (chunks, length) =>
        progress({ response, total, last, chunks, length }),
      );
      return { ...result, bytes, total, last };
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
  }
  async function chunk(from, to, isFirst, partSignal, version) {
    partSignal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const attempts = Array(4).fill(null);
      const errors = [];
      const timers = [];
      let settled = false;
      function finish(error, result, winner) {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        partSignal.removeEventListener('abort', aborted);
        for (const attempt of attempts)
          if (attempt && attempt !== winner) attempt.controller.abort();
        if (error) reject(error);
        else resolve(result);
      }
      const aborted = () => finish(partSignal.reason);
      function launch(index) {
        if (settled || attempts[index]) return;
        if (partSignal.aborted) return aborted();
        const best = attempts
          .map((attempt) => attempt?.progress)
          .filter(
            (p) =>
              p && p.length > 0 && p.length < p.last - from + 1 && fileVersion(p.response, p.total),
          )
          .sort((a, b) => b.length - a.length)[0];
        const prefix = best ? Buffer.concat(best.chunks, best.length) : Buffer.alloc(0);
        const expected = best ? fileVersion(best.response, best.total) : version;
        // At most two connections per piece. If both drip slowly, keep the
        // verified prefix and fetch only its missing suffix on a new connection.
        const active = attempts.filter((attempt) => attempt?.active);
        if (active.length >= 2) {
          const slowest = active.sort(
            (a, b) => (a.progress?.length || 0) - (b.progress?.length || 0),
          )[0];
          slowest.active = false;
          slowest.superseded = true;
          slowest.controller.abort();
        }
        const attempt = { controller: new AbortController(), active: true };
        attempts[index] = attempt;
        fetchChunk(
          from + prefix.length,
          to,
          isFirst,
          AbortSignal.any([partSignal, attempt.controller.signal]),
          expected,
          (progress) => {
            attempt.progress = {
              ...progress,
              chunks: prefix.length ? [prefix, ...progress.chunks] : progress.chunks,
              length: prefix.length + progress.length,
            };
          },
        ).then(
          (result) =>
            finish(
              null,
              prefix.length ? { ...result, bytes: Buffer.concat([prefix, result.bytes]) } : result,
              attempt,
            ),
          (error) => {
            attempt.active = false;
            if (settled) return;
            if (!attempt.superseded) {
              errors.push(error);
              const next = attempts.findIndex((item) => !item);
              if (next !== -1) launch(next);
            }
            if (attempts.every((item) => item && !item.active))
              finish(errors.find((item) => item instanceof HttpError) || errors[0] || error);
          },
        );
      }
      partSignal.addEventListener('abort', aborted, { once: true });
      timers.push(setTimeout(() => launch(1), HEDGE_DELAY_MS));
      timers.push(setTimeout(() => launch(2), RESUME_DELAY_MS));
      timers.push(setTimeout(() => launch(3), RESUME_DELAY_MS * 2));
      launch(0);
    });
  }

  try {
    // Start together so a seek does not pay one CDN round trip per piece.
    // Only matching validators are emitted; speculative pieces are cancelled
    // if the first response ignores Range or cannot identify a file version.
    const parts = [];
    const partControllers = [];
    const windowEnd = Math.min(requestedEnd, start + PREFETCH_BYTES - 1);
    for (let from = start; from <= windowEnd; from += CHUNK_BYTES) {
      const controller = new AbortController();
      partControllers.push(controller);
      const pending = chunk(
        from,
        Math.min(from + CHUNK_BYTES - 1, windowEnd),
        from === start,
        AbortSignal.any([signal, controller.signal]),
      );
      pending.catch(() => {});
      parts.push(pending);
    }
    const first = await parts[0];
    if (!first.bytes) {
      for (const controller of partControllers.slice(1)) controller.abort();
      return first;
    }
    const version = fileVersion(first.response, first.total);
    const end = version ? Math.min(requestedEnd, first.total - 1) : first.last;
    const partCount = Math.ceil((end - start + 1) / CHUNK_BYTES);
    for (const controller of partControllers.slice(partCount)) controller.abort();
    parts.length = Math.min(parts.length, partCount);
    let nextFrom = start + parts.length * CHUNK_BYTES;
    const headers = new Headers(first.response.headers);
    headers.set('content-range', `bytes ${start}-${end}/${first.total}`);
    headers.set('content-length', String(end - start + 1));
    let index = 0;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const part = await parts.shift();
          index++;
          if (
            part.total !== first.total ||
            (version && part.response.headers.get(version.header) !== version.value)
          )
            throw new HttpError('媒体文件版本已变化，请重新解析', 502);
          if (nextFrom <= end) {
            const pending = chunk(
              nextFrom,
              Math.min(nextFrom + CHUNK_BYTES - 1, end),
              false,
              signal,
              version,
            );
            pending.catch(() => {});
            parts.push(pending);
            nextFrom += CHUNK_BYTES;
          }
          controller.enqueue(part.bytes);
          if (index === partCount) {
            controller.close();
            lifetime.abort();
          }
        } catch (error) {
          lifetime.abort();
          controller.error(error);
        }
      },
      cancel() {
        lifetime.abort();
      },
    });
    return { ...first, response: new Response(body, { status: 206, headers }) };
  } catch (error) {
    lifetime.abort();
    throw error;
  }
}
