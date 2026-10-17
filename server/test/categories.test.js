import test from 'node:test';
import assert from 'node:assert/strict';
import { categorySearchOptions } from '../modules/metadata/service.js';

test('category date ranges include the selected quarter and exclude the next', () => {
  for (const [season, start, end] of [
    ['1', '2026-01-01', '2026-04-01'],
    ['2', '2026-04-01', '2026-07-01'],
    ['3', '2026-07-01', '2026-10-01'],
    ['4', '2026-10-01', '2027-01-01'],
    ['', '2026-01-01', '2027-01-01'],
  ]) {
    assert.deepEqual(categorySearchOptions({ year: '2026', season }).airDate, [
      `>=${start}`,
      `<${end}`,
    ]);
  }
});

test('custom category tags are trimmed and deduplicated with the format', () => {
  assert.deepEqual(categorySearchOptions({ tag: [' TV ', '科幻', '科幻'], format: 'TV' }), {
    sort: 'heat',
    tags: ['TV', '科幻'],
    airDate: [],
  });
});
