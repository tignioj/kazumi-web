import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJsonFields,
  createRuleDraft,
  formatRule,
  parseRuleDocument,
  ruleField,
  withRuleField,
} from '../../src/features/rules/editor.js';

test('form edits preserve unknown fields and inactive advanced configuration through JSON', () => {
  const original = {
    ...createRuleDraft(),
    name: 'Source',
    custom: { future: [1, { key: 'value' }] },
    searchApiConfig: {
      request: { url: 'https://example.com', headers: { Authorization: 'token' } },
    },
    antiCrawlerConfig: { enabled: true, captchaType: 3, captchaScript: 'return true;', extra: 7 },
  };
  const before = formatRule(original);
  let edited = withRuleField(parseRuleDocument(before), 'name', 'Renamed');
  edited = withRuleField(edited, 'antiCrawlerConfig.enabled', false);
  edited = withRuleField(edited, 'searchApiConfig.request.method', 'POST');
  const result = parseRuleDocument(formatRule(edited));
  assert.equal(formatRule(original), before);
  assert.deepEqual(result.custom, original.custom);
  assert.equal(result.name, 'Renamed');
  assert.deepEqual(result.antiCrawlerConfig, { ...original.antiCrawlerConfig, enabled: false });
  assert.deepEqual(result.searchApiConfig.request, {
    ...original.searchApiConfig.request,
    method: 'POST',
  });
  assert.equal(ruleField(result, 'chapterApiConfig.format', 'nested'), 'nested');
  assert.equal(ruleField(result, 'enabled', false), true);
});

test('JSON source rejects arrays, primitives and syntax errors without replacing the document', () => {
  for (const content of ['[]', 'null', 'false', '"text"', '1'])
    assert.throws(() => parseRuleDocument(content), /单个 JSON 对象/);
  assert.throws(() => parseRuleDocument('{'), /JSON 格式错误/);
  assert.deepEqual(parseRuleDocument('{"extra": false}'), { extra: false });
});

test('advanced JSON edits retain headers and typed bodies, and report the exact invalid field', () => {
  const original = { searchApiConfig: { request: { url: 'https://example.com' }, extra: true } };
  const result = applyJsonFields(original, {
    'searchApiConfig.request.headers': '{"X-Test": "@keyword"}',
    'searchApiConfig.request.body': '["@keyword", 2, true]',
  });
  assert.deepEqual(result.searchApiConfig.request, {
    url: 'https://example.com',
    headers: { 'X-Test': '@keyword' },
    body: ['@keyword', 2, true],
  });
  assert.equal(result.searchApiConfig.extra, true);
  assert.deepEqual(original.searchApiConfig.request, { url: 'https://example.com' });
  assert.throws(
    () => applyJsonFields(original, { 'searchApiConfig.request.headers': '{' }),
    /headers JSON 格式错误/,
  );
  assert.throws(
    () => applyJsonFields(original, { 'searchApiConfig.request.query': '[]' }),
    /query 必须是 JSON 对象/,
  );
  const removed = withRuleField(
    { chapterApiConfig: { episodePage: { url: '/play' }, extra: 1 } },
    'chapterApiConfig.episodePage',
    undefined,
  );
  assert.deepEqual(parseRuleDocument(formatRule(removed)), { chapterApiConfig: { extra: 1 } });
});
