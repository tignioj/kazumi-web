import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { requestVideoRange } from '../../server/modules/playback/range-transport.js';

const chunkSize = 512 * 1024;
const bytes = Buffer.alloc(5 * 1024 * 1024);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

function fixture(handle) {
  const calls = [];
  const http = {
    async request(url, options) {
      const call = { ...options, index: calls.length };
      calls.push(call);
      const [from, to] = options.headers.range.slice(6).split('-').map(Number);
      const end = Math.min(to, bytes.length - 1);
      const headers = {
        'content-type': 'video/mp4',
        'content-range': `bytes ${from}-${end}/${bytes.length}`,
        'content-length': end - from + 1,
        etag: '"same-file"',
      };
      const response = await handle?.(call, { from, end, headers });
      return {
        url,
        response: response || new Response(bytes.subarray(from, end + 1), { status: 206, headers }),
      };
    },
  };
  const request = (range = 'bytes=123-', extra = {}) =>
    requestVideoRange(http, 'https://cdn.example/video.mp4', {
      headers: { range, cookie: 'scoped' },
      headersForUrl: () => ({ cookie: 'redirect-scoped', range }),
      ...extra,
    });
  return { calls, request };
}

test('open video ranges stream exact bytes with bounded upstream requests and scoped redirect headers', async () => {
  const { calls, request } = fixture();
  const { response } = await request();
  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get('content-range'),
    `bytes 123-${bytes.length - 1}/${bytes.length}`,
  );
  assert.equal(response.headers.get('content-length'), String(bytes.length - 123));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(123));
  assert.equal(calls.length, Math.ceil((bytes.length - 123) / chunkSize));
  for (const [index, call] of calls.entries()) {
    const from = 123 + index * chunkSize;
    assert.equal(
      call.headers.range,
      `bytes=${from}-${Math.min(from + chunkSize - 1, bytes.length - 1)}`,
    );
    assert.equal(call.headers.cookie, 'scoped');
    assert.equal(call.headersForUrl('https://redirect.example/').range, call.headers.range);
    assert.equal(call.headersForUrl('https://redirect.example/').cookie, 'redirect-scoped');
  }
});

test('all pieces start before the first body finishes and preserve browser If-Range', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, request } = fixture(() => gate);
  const pending = request('bytes=123-', {
    headers: { range: 'bytes=123-', 'if-range': '"same-file"' },
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.headers['if-range'] === '"same-file"'));
  release();
  const { response } = await pending;
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(123));
});

test('closed ranges and the final short window keep exact boundaries', async () => {
  for (const [start, end] of [
    [19, 800000],
    [bytes.length - 700000, bytes.length + 1000],
  ]) {
    const { request } = fixture();
    const { response } = await request(`bytes=${start}-${end}`);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      bytes.subarray(start, Math.min(end + 1, bytes.length)),
    );
    assert.equal(
      response.headers.get('content-range'),
      `bytes ${start}-${Math.min(end, bytes.length - 1)}/${bytes.length}`,
    );
  }
});

test('a slow chunk is replaced independently and its abandoned request is cancelled', async () => {
  let cancelled = false;
  const { calls, request } = fixture(async (call) => {
    if (call.index !== 0) return;
    try {
      await delay(5000, null, { signal: call.signal });
    } catch (error) {
      cancelled = error.name === 'AbortError';
      throw error;
    }
  });
  const { response } = await request();
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(123));
  assert.equal(calls.length, Math.ceil((bytes.length - 123) / chunkSize) + 1);
  assert.equal(cancelled, true);
});

test('two slow copies resume only their missing suffix with If-Range and exact output', async () => {
  const ranges = [];
  let active = 0;
  let maximum = 0;
  const { request } = fixture((call, { from, end, headers }) => {
    if (end !== 123 + chunkSize - 1) return;
    ranges.push(call.headers);
    if (ranges.length > 2) return;
    active++;
    maximum = Math.max(maximum, active);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(from, from + 98304));
          call.signal.addEventListener(
            'abort',
            () => {
              active--;
              controller.error(call.signal.reason);
            },
            { once: true },
          );
        },
      }),
      { status: 206, headers },
    );
  });
  const { response } = await request();
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(123));
  assert.deepEqual(
    ranges.map((headers) => headers.range),
    ['bytes=123-524410', 'bytes=98427-524410', 'bytes=196731-524410'],
  );
  assert.ok(ranges.slice(1).every((headers) => headers['if-range'] === '"same-file"'));
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

test('a disconnected prefix is never joined to a changed file version', async () => {
  let first = true;
  const { request } = fixture((call, { from, end, headers }) => {
    if (end !== 123 + chunkSize - 1) return;
    if (!first) {
      assert.equal(call.headers['if-range'], '"same-file"');
      return new Response(bytes.subarray(from, end + 1), {
        status: 206,
        headers: { ...headers, etag: '"changed"' },
      });
    }
    first = false;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(from, from + 98304));
          setTimeout(() => controller.error(new Error('origin disconnected')), 5);
        },
      }),
      { status: 206, headers },
    );
  });
  await assert.rejects(request(), { status: 502 });
});

test('cancelling a browser response cancels every pending chunk and duplicate', async () => {
  const pending = [];
  const { request } = fixture(async (call) => {
    if (call.index === 0) return;
    pending.push(call.signal);
    await delay(5000, null, { signal: call.signal });
  });
  const { response } = await request();
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await delay(0);
  assert.equal(pending.length, 4);
  assert.ok(pending.every((signal) => signal.aborted));
});

test('a paused consumer does not prefetch the rest of the file', async () => {
  const { calls, request } = fixture();
  const { response } = await request();
  await delay(10);
  assert.ok(calls.length <= 5, `only a few chunks can be buffered, got ${calls.length}`);
  await response.body.cancel();
});

test('changed file versions, malformed ranges and truncated chunks are rejected', async () => {
  for (const failure of ['version', 'range', 'truncated']) {
    const { request } = fixture((call, { from, end, headers }) => {
      if (from < chunkSize) return;
      if (failure === 'version') headers.etag = '"changed-file"';
      if (failure === 'range') headers['content-range'] = `bytes 0-${end}/${bytes.length}`;
      return new Response(bytes.subarray(from, end + (failure === 'truncated' ? 0 : 1)), {
        status: 206,
        headers,
      });
    });
    const { response } = await request();
    await assert.rejects(response.arrayBuffer(), { status: 502 });
  }
});

test('without a file validator only one verified chunk is returned', async () => {
  const { calls, request } = fixture((call, { from, end, headers }) => {
    delete headers.etag;
    return new Response(bytes.subarray(from, end + 1), { status: 206, headers });
  });
  const { response } = await request();
  assert.equal((await response.arrayBuffer()).byteLength, chunkSize);
  assert.ok(calls.slice(1).every((call) => call.signal.aborted));
});

test('an origin ignoring Range or rejecting If-Range remains a streaming 200 response', async () => {
  const { calls, request } = fixture(
    () => new Response(bytes, { headers: { etag: '"new-file"' } }),
  );
  const { response } = await request('bytes=123-', {
    headers: { range: 'bytes=123-', 'if-range': '"old-file"' },
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0].headers['if-range'], '"old-file"');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.ok(calls.slice(1).every((call) => call.signal.aborted));
});

test('small, suffix and multipart ranges are forwarded unchanged', async () => {
  for (const range of ['bytes=2-19', 'bytes=-50', 'bytes=0-9,20-29']) {
    let actual;
    const http = {
      request: async (url, options) => {
        actual = options;
        return { response: new Response('data') };
      },
    };
    const options = { headers: { range } };
    const { response } = await requestVideoRange(http, 'https://cdn.example/video.mp4', options);
    assert.equal(actual, options);
    assert.equal(await response.text(), 'data');
  }
});
