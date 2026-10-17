import assert from 'node:assert/strict';

const base = process.env.BASE_URL || 'http://localhost:3000';
async function json(path) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(45000) });
  assert.equal(
    response.status,
    200,
    `${path}: ${response.status} ${await response.clone().text()}`,
  );
  return response.json();
}
assert.equal((await json('/api/health')).status, 'ok');
const page = await fetch(base);
assert.equal(page.status, 200);
assert.match(await page.text(), /id="root"/);
const rules = await json('/api/rules');
assert.ok(Array.isArray(rules.rules));
const missing = await fetch(new URL('/api/not-a-route', base));
assert.equal(missing.status, 404);
assert.ok((await missing.json()).error);
console.log('PASS: health, production HTML, rule persistence endpoint, API 404');

if (process.env.SMOKE_LIVE === 'true') {
  const catalog = await json('/api/catalog?sort=trending');
  assert.ok(catalog.items.length > 0, 'Live catalog is empty');
  const calendar = await json('/api/calendar');
  assert.equal((Array.isArray(calendar) ? calendar : calendar.items).length, 7);
  const subject = await json(`/api/subjects/${catalog.items[0].id}`);
  assert.ok(subject.name);
  const search = await json('/api/search?q=CLANNAD');
  assert.ok(search.items.length > 0);
  const repository = await json('/api/rules/catalog');
  assert.ok(repository.rules.length > 0);
  console.log(
    `PASS: live catalog (${catalog.items.length}), calendar, subject, search, rule repository (${repository.rules.length})`,
  );
}
