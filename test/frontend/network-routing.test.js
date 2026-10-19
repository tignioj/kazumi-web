import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceRoutingRules, routingId } from '../../src/features/settings/network-routing.js';

test('source shortcuts include separate API hosts, deduplicate subdomains and retain visible rules', () => {
  const rules = sourceRoutingRules(
    {
      name: 'Source',
      baseURL: 'https://www.example.com/',
      searchURL: 'https://search.example.com/?wd=@keyword',
      searchApiConfig: { request: { url: 'https://api.other.test/v1/search' } },
      chapterApiConfig: { request: { url: 'https://api.other.test/v1/@source' } },
    },
    'direct',
  );
  assert.deepEqual(
    rules.map((rule) => rule.value),
    ['example.com', 'api.other.test'],
  );
  assert.ok(rules.every((rule) => rule.action === 'direct' && rule.scope === 'video'));
  assert.ok(rules.every((rule) => rule.matchType === 'domainSuffix'));
  assert.notEqual(rules[0].id, rules[1].id);
  const proxied = sourceRoutingRules(
    {
      name: 'API',
      baseURL: 'opaque',
      searchApiConfig: { request: { url: 'https://api.example.com/search' } },
    },
    'proxy-two',
  );
  assert.equal(proxied[0].proxyId, 'proxy-two');
  assert.equal(proxied[0].action, 'proxy');
  assert.match(routingId(), /^[a-f0-9]{32}$/);
});
