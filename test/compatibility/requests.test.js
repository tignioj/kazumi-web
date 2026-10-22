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

test('request comparison ignores transport defaults added after the engine request', () => {
  const url = 'https://example.com/search';
  const headers = {
    Referer: 'https://example.com/',
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Source-Token': 'fixture-token',
  };
  const options = { method: 'POST', headers, body: 'q=search' };
  assert.deepEqual(
    canonicalRequest(url, options),
    canonicalRequest(url, {
      ...options,
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'User-Agent': 'Runtime default UA',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': '*',
        Host: 'example.com',
        Connection: 'keep-alive',
        'Content-Length': '8',
        'Sec-Fetch-Mode': 'cors',
      },
    }),
  );
  assert.deepEqual(canonicalRequest(url, options).headers, {
    'content-type': 'application/x-www-form-urlencoded',
    referer: 'https://example.com/',
    'x-source-token': 'fixture-token',
  });
});

test('referer and custom request headers remain part of the compatibility contract', () => {
  const url = 'https://example.com/search';
  const headers = { referer: 'https://example.com/', 'x-source-token': 'fixture-token' };
  const expected = canonicalRequest(url, { headers });
  for (const changed of [
    { ...headers, referer: 'https://example.com/playback-only' },
    { ...headers, referer: 'https://example.com//' },
    { ...headers, 'x-source-token': 'wrong-token' },
    { referer: headers.referer },
  ])
    assert.notDeepEqual(canonicalRequest(url, { headers: changed }), expected);
});

test('explicit API UA and Accept are compared case-insensitively without dropping their values', () => {
  const url = 'https://example.com/search';
  const headers = {
    Referer: 'https://example.com/api',
    'User-Agent': 'Rule UA',
    Accept: 'application/vnd.kazumi+json',
    'X-Phase': 'search',
  };
  const rule = { searchMode: 'api', searchApiConfig: { request: { headers } } };
  const context = { rule, phase: 'search' };
  const expected = canonicalRequest(url, { headers }, context);
  assert.deepEqual(expected.headers, {
    accept: 'application/vnd.kazumi+json',
    referer: 'https://example.com/api',
    'user-agent': 'Rule UA',
    'x-phase': 'search',
  });
  assert.deepEqual(
    canonicalRequest(url, { headers: Object.fromEntries(new Headers(headers)) }, context),
    expected,
  );
  for (const changed of [
    { ...headers, 'User-Agent': 'Runtime default UA' },
    { ...headers, Accept: '*/*' },
    { Referer: headers.Referer, 'X-Phase': 'search' },
  ])
    assert.notDeepEqual(canonicalRequest(url, { headers: changed }, context), expected);

  // A header declared only for search must not turn a chapter transport's
  // unrelated default UA/Accept into a compatibility difference.
  assert.deepEqual(canonicalRequest(url, { headers }, { rule, phase: 'chapter' }).headers, {
    referer: headers.Referer,
    'x-phase': 'search',
  });
});

test('an accidentally forwarded playback UA is visible even when default UA is ignored', () => {
  const url = 'https://example.com/search';
  const rule = { userAgent: 'Playback-only UA', referer: 'https://example.com/player' };
  const context = { rule, phase: 'search' };
  const headers = { referer: 'https://example.com/' };
  const expected = canonicalRequest(url, { headers }, context);
  assert.deepEqual(
    canonicalRequest(url, { headers: { ...headers, 'user-agent': 'Runtime UA' } }, context),
    expected,
  );
  const leaked = canonicalRequest(
    url,
    { headers: { ...headers, 'user-agent': rule.userAgent } },
    context,
  );
  assert.equal(leaked.headers['user-agent'], rule.userAgent);
  assert.notDeepEqual(leaked, expected);
});

test('explicit Content-Type parameters are retained while implicit runtime charset is normalized', () => {
  const url = 'https://example.com/search';
  const headers = { 'Content-Type': 'application/vnd.kazumi+json; version=2' };
  const context = {
    rule: { searchMode: 'api', searchApiConfig: { request: { headers } } },
    phase: 'search',
  };
  const result = canonicalRequest(url, { headers, body: '{"id":1}' }, context);
  assert.equal(result.headers['content-type'], headers['Content-Type']);
  assert.deepEqual(result.body, { id: 1 });
});
