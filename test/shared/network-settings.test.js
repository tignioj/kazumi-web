import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  proxySettingsFor,
} from '../../shared/network-settings.js';

const routeRule = (patch = {}) => ({
  id: 'route',
  name: 'AGE 直连',
  enabled: true,
  scope: 'video',
  matchType: 'domainSuffix',
  value: 'agedm.io',
  action: 'direct',
  proxyId: 'default',
  ...patch,
});

test('ordered routing overrides category defaults and selects independent proxy credentials', () => {
  const settings = normalizeNetworkSettings({
    videoProxy: true,
    url: 'http://localhost:17893',
    username: 'main',
    password: 'main-secret',
    proxies: [
      {
        id: 'other',
        name: '其他出口',
        url: 'socks5://localhost:1080',
        username: 'other',
        password: 'other-secret',
      },
    ],
    scopeProxies: { image: 'other' },
    imageProxy: true,
    routingRules: [
      routeRule(),
      routeRule({ id: 'sub', value: 'api.agedm.io', action: 'proxy', proxyId: 'other' }),
      routeRule({
        id: 'global',
        scope: 'all',
        value: 'github.com',
        action: 'proxy',
        proxyId: 'other',
      }),
    ],
  });
  const pick = (url, scope = 'video', config = settings) =>
    proxySettingsFor(config, scope, { url });
  assert.equal(pick('https://api.agedm.io/path').enabled, false);
  assert.equal(pick('https://www.agedm.io.:443/path').routing.ruleId, 'route');
  assert.equal(pick('https://agedm.io.evil.test/').routing.ruleId, null);
  assert.equal(pick('https://another-agedm.io/').enabled, true);
  assert.equal(pick('https://lain.bgm.tv/', 'image').password, 'other-secret');
  assert.equal(pick('https://github.com/', 'archive').enabled, true);
  assert.equal(pick('https://github.com/', 'archive').routing.proxyName, '其他出口');
  assert.equal(pick('https://www.agedm.io/', 'archive').enabled, false);
  assert.equal(pick('https://github.com/', undefined).enabled, true); // default function parameter is video
  assert.equal(
    proxySettingsFor(settings, undefined, { url: 'https://github.com/' }).enabled,
    false,
  );
  const reordered = {
    ...settings,
    routingRules: [settings.routingRules[1], settings.routingRules[0]],
  };
  assert.equal(pick('https://api.agedm.io/', 'video', reordered).password, 'other-secret');
  const disabled = {
    ...settings,
    routingRules: settings.routingRules.map((rule) => ({ ...rule, enabled: false })),
  };
  assert.equal(pick('https://agedm.io/', 'video', disabled).enabled, true);
  assert.equal(pick('https://agedm.io/', 'video', disabled).routing.ruleId, null);
});

test('all matchers normalize domains, respect suffix boundaries and match IPv4/IPv6 literals', () => {
  for (const [matchType, value, yes, no] of [
    ['domain', 'WWW.Example.COM.', 'https://www.example.com/', 'https://sub.www.example.com/'],
    ['domainSuffix', '*.example.com', 'https://api.example.com/', 'https://fakeexample.com/'],
    ['domainKeyword', 'EXAMPLE', 'https://an-example.test/', 'https://another.test/'],
    ['cidr', '203.0.113.0/24', 'https://203.0.113.25/', 'https://203.0.114.25/'],
    ['cidr', '2001:db8::/32', 'https://[2001:db8:1::1]/', 'https://[2001:db9::1]/'],
    ['all', '', 'https://anything.test/', null],
  ]) {
    const settings = normalizeNetworkSettings({
      url: 'http://localhost:7890',
      routingRules: [routeRule({ matchType, value, action: 'proxy' })],
    });
    assert.equal(proxySettingsFor(settings, 'video', { url: yes }).enabled, true, matchType);
    if (no)
      assert.equal(proxySettingsFor(settings, 'video', { url: no }).enabled, false, matchType);
  }
});

test('proxy updates preserve secrets by ID and reject dangling routes or malformed inputs', () => {
  const original = normalizeNetworkSettings({
    proxies: [
      { id: 'a', name: 'A', url: 'http://localhost:7890', username: 'a', password: 'secret-a' },
      { id: 'b', name: 'B', url: 'http://localhost:7891', username: 'b', password: 'secret-b' },
    ],
  });
  const reordered = normalizeNetworkSettings(
    {
      proxies: [
        { id: 'b', name: 'B2', url: 'http://localhost:7892' },
        { id: 'a', name: 'A2', url: 'http://localhost:7893', password: '' },
      ],
    },
    original,
  );
  assert.equal(reordered.proxies[0].password, 'secret-b');
  assert.equal(reordered.proxies[0].username, 'b');
  assert.equal(reordered.proxies[1].password, '');
  for (const patch of [
    { proxies: [{ id: 'default', url: 'http://localhost' }] },
    {
      proxies: [
        { id: 'a', url: 'http://localhost' },
        { id: 'a', url: 'http://localhost' },
      ],
    },
    { proxies: [{ id: 'x', url: 'http://user:secret@localhost' }] },
    { scopeProxies: { video: 'missing' } },
    { routingRules: [routeRule({ scope: 'invalid' })] },
    { routingRules: [routeRule({ action: 'invalid' })] },
    { routingRules: [routeRule({ action: 'proxy', proxyId: 'missing' })] },
    { routingRules: [routeRule({ value: 'https://agedm.io/' })] },
    { routingRules: [routeRule({ value: 'user@agedm.io' })] },
    { routingRules: [routeRule({ value: 'agedm.io:443' })] },
    { routingRules: [routeRule({ value: 'foo.*.agedm.io' })] },
    { routingRules: [routeRule({ matchType: 'cidr', value: '1.2.3.4/99' })] },
    { routingRules: [routeRule(), routeRule()] },
    { routingRules: Array.from({ length: 201 }, (_, i) => routeRule({ id: `r${i}` })) },
  ])
    assert.throws(() => normalizeNetworkSettings(patch, original));
  const selected = normalizeNetworkSettings(
    { videoProxy: true, scopeProxies: { video: 'a' } },
    original,
  );
  assert.equal(proxySettingsFor(selected, 'video').url, 'http://localhost:7890/');
  assert.throws(() => normalizeNetworkSettings({ proxies: [] }, selected), /不存在/);
});

test('proxy settings accept supported endpoints and reject malformed addresses and credentials', () => {
  for (const url of ['http://127.0.0.1:7890', 'https://proxy.example:8443', 'socks5://[::1]:1080'])
    assert.equal(normalizeNetworkSettings({ videoProxy: true, url }).videoProxy, true);
  for (const input of [
    null,
    [],
    { enabled: true, url: 'http://localhost' },
    { enabled: false },
    { videoProxy: 'true' },
    { imageProxy: null },
    { bangumiProxy: 1 },
    { rulesProxy: 'true' },
    { archiveProxy: null },
    { videoProxy: true },
    { imageProxy: true },
    { bangumiProxy: true },
    { rulesProxy: true },
    { archiveProxy: true },
    { videoProxy: true, url: 'localhost:7890' },
    { videoProxy: true, url: 'ftp://localhost' },
    { videoProxy: true, url: 'http://user:secret@localhost' },
    { videoProxy: true, url: 'http://localhost/path' },
    { videoProxy: true, url: 'http://localhost?query' },
    { videoProxy: true, url: 'http://localhost:99999' },
    { videoProxy: true, url: 'http://localhost:0' },
    { username: 'bad:name' },
    { password: 'orphan' },
    { videoProxy: true, url: 'socks5://localhost', username: '名'.repeat(86) },
  ])
    assert.throws(() => normalizeNetworkSettings(input));
});

test('ECH settings default off and survive proxy-only changes', () => {
  const legacy = { url: '', username: '', password: '' };
  assert.deepEqual(normalizeNetworkSettings(legacy), DEFAULT_NETWORK_SETTINGS);
  const configured = normalizeNetworkSettings({
    ...legacy,
    bangumiEch: true,
    echDohUrl: ' https://dns.example/dns-query ',
  });
  assert.deepEqual(normalizeNetworkSettings({ videoProxy: false }, configured), {
    ...configured,
    echDohUrl: 'https://dns.example/dns-query',
  });
  for (const bangumiEch of ['true', 1, null])
    assert.throws(() => normalizeNetworkSettings({ ...legacy, bangumiEch }), /ECH/);
  for (const echDohUrl of [
    '',
    null,
    'http://dns.example/dns-query',
    'https://user:secret@dns.example/dns-query',
    'https://dns.example/dns-query#fragment',
    'https://dns.example/\nquery',
  ])
    assert.throws(() => normalizeNetworkSettings({ ...legacy, echDohUrl }), /ECH DNS/);
});

test('image modes are validated and remain independent of API ECH and proxy updates', () => {
  for (const imageAcceleration of ['mirror', 'ech', 'direct']) {
    const configured = normalizeNetworkSettings({ imageAcceleration });
    assert.equal(configured.imageAcceleration, imageAcceleration);
    assert.equal(configured.bangumiEch, false);
    assert.equal(
      normalizeNetworkSettings({ bangumiEch: true }, configured).imageAcceleration,
      imageAcceleration,
    );
  }
  for (const imageAcceleration of ['proxy', '', null, false, 1, {}, ['ech']])
    assert.throws(() => normalizeNetworkSettings({ imageAcceleration }), /封面请求方式/);
});

test('proxy categories are independent and unclassified traffic has no proxy or API ECH', () => {
  const settings = normalizeNetworkSettings({
    videoProxy: false,
    imageProxy: true,
    bangumiProxy: true,
    rulesProxy: true,
    url: 'http://localhost:7890',
    bangumiEch: true,
  });
  const toggled = normalizeNetworkSettings({ videoProxy: true }, settings);
  assert.equal(toggled.imageProxy, true);
  assert.equal(toggled.bangumiProxy, true);
  assert.equal(toggled.rulesProxy, true);
  assert.equal(toggled.archiveProxy, false);
  assert.equal(toggled.enabled, undefined);
  for (const [scope, enabled, ech] of [
    ['video', false, false],
    ['image', true, false],
    ['bangumi', true, true],
    ['rules', true, false],
    ['archive', false, false],
    [undefined, false, false],
    ['invalid', false, false],
  ]) {
    const proxy = proxySettingsFor(settings, scope);
    assert.equal(proxy.enabled, enabled);
    assert.equal(proxy.bangumiEch, ech);
    assert.equal(proxy.url, settings.url);
  }
});
