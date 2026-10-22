import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.js';

async function fixture(t, httpClient = { async close() {} }) {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-app-'));
  const dist = join(directory, 'dist');
  const html = '<!doctype html><html><body>Kazumi fixture</body></html>';
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), html);
  await writeFile(join(dist, 'app.js'), 'console.log("fixture");');
  const application = await createApp({
    dataDir: directory,
    distDir: dist,
    seedRules: [],
    metadata: {},
    browserResolver: false,
    httpClient,
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, dist, html, request: (path, options) => fetch(`${base}${path}`, options) };
}

test('request guards run before JSON parsing and errors retain their HTTP responses', async (t) => {
  const { base, request } = await fixture(t);
  const health = await request('/api/health');
  assert.deepEqual(await health.json(), { status: 'ok' });
  for (const [header, value] of Object.entries({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'SAMEORIGIN',
    'cross-origin-resource-policy': 'same-origin',
  }))
    assert.equal(health.headers.get(header), value);
  assert.equal(health.headers.get('x-powered-by'), null);

  for (const [headers, status, error] of [
    [{ 'sec-fetch-site': 'cross-site' }, 403, '拒绝跨站修改请求'],
    [{ origin: 'null' }, 403, '请求 Origin 无效'],
    [{ origin: 'https://other.example' }, 403, '拒绝跨站修改请求'],
    [{ origin: base }, 400, '请求 JSON 格式无效'],
  ]) {
    const response = await request('/api/rules/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{',
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  const form = await request('/api/rules/import', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'content=rule',
  });
  assert.equal(form.status, 415);
  assert.deepEqual(await form.json(), { error: '请使用 application/json 请求' });
  const removed = await request('/api/watch-data/history', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await removed.json(), { library: {}, history: [] });
});

test('static files, frontend fallbacks and unknown APIs retain separate responses', async (t) => {
  const { request, dist, html } = await fixture(t);
  const asset = await request('/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /max-age=3600/);
  assert.equal(await asset.text(), 'console.log("fixture");');
  const page = await request('/bookmarked/page');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.equal(await page.text(), html);
  const head = await request('/bookmarked/page', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const api = await request('/api/not-a-route');
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: 'API 不存在' });
  const mutation = await request('/bookmarked/page', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(mutation.status, 404);
  assert.deepEqual(await mutation.json(), { error: '页面不存在' });
  await rm(join(dist, 'index.html'));
  const missing = await request('/bookmarked/page');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    error: '前端尚未构建，请先执行 npm run build 或使用 npm run dev',
  });
});

test('API limits stay per application and exempt streaming, images and health checks', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  for (let index = 0; index < 240; index++) {
    const response = await first.request('/api/rules');
    assert.equal(response.status, 200);
    await response.json();
  }
  const limited = await first.request('/api/rules');
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: '请求过于频繁，请稍后重试' });
  for (const [path, status] of [
    ['/api/health', 200],
    ['/api/image', 403],
    ['/api/media', 403],
    ['/api/downloads/missing/files/video.mp4', 404],
    ['/api/downloads/missing/download', 404],
  ]) {
    const response = await first.request(path);
    assert.equal(response.status, status, path);
    await response.text();
  }
  const independent = await second.request('/api/rules');
  assert.equal(independent.status, 200);
  assert.deepEqual(await independent.json(), {
    rules: [],
    compatibility: [],
    capabilities: { apiLevel: 9, dynamicResolver: false },
  });
});

test('official rule catalog caching stays local to each application', async (t) => {
  const calls = [];
  const client = (name) => ({
    async json(url) {
      calls.push({ name, url });
      return [{ name, version: '1' }];
    },
    async close() {},
  });
  const first = await fixture(t, client('First'));
  const second = await fixture(t, client('Second'));
  for (const [application, name] of [
    [first, 'First'],
    [first, 'First'],
    [second, 'Second'],
    [first, 'First'],
  ]) {
    const response = await application.request('/api/rules/catalog');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.rules, [{ name, version: '1' }]);
    assert.equal(data.catalog.source, 'network');
    assert.equal(data.catalog.stale, false);
  }
  assert.deepEqual(
    calls.map((call) => call.name),
    ['First', 'Second'],
  );
  assert.ok(calls.every((call) => call.url.endsWith('/index.json')));
});
