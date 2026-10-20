import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRequest } from './corpus.mjs';

test('request comparison retains every query and form value in order, including blank values', () => {
  const request = canonicalRequest('https://example.com/search?tag=A&tag=B&empty&blank=', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'tag=A&tag=B&empty&blank=',
  });
  const pairs = [
    ['tag', 'A'],
    ['tag', 'B'],
    ['empty', ''],
    ['blank', ''],
  ];
  assert.deepEqual(request.query, pairs);
  assert.deepEqual(request.body, pairs);
});

test('duplicate parameter differences cannot be hidden by last-value object conversion', () => {
  const original = canonicalRequest('https://example.com/search?tag=A&tag=B');
  for (const query of ['tag=B', 'tag=X&tag=B', 'tag=B&tag=A', 'tag=A&tag=A&tag=B'])
    assert.notDeepEqual(canonicalRequest(`https://example.com/search?${query}`), original);
  const form = (body) =>
    canonicalRequest('https://example.com/search', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  for (const body of ['tag=B', 'tag=X&tag=B', 'tag=B&tag=A', 'tag=A&tag=A&tag=B'])
    assert.notDeepEqual(form(body), form('tag=A&tag=B'));
});

test('request comparison still decodes equivalent URL encoding and preserves JSON types', () => {
  assert.deepEqual(
    canonicalRequest('https://example.com/search?q=a+b&tag=%2F'),
    canonicalRequest('https://example.com/search?q=a%20b&tag=/'),
  );
  const body = { tags: ['A', 'B'], empty: null, enabled: false, page: 0 };
  assert.deepEqual(
    canonicalRequest('https://example.com', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).body,
    body,
  );
});
