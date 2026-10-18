import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  proxySettingsFor,
} from '../../shared/network-settings.js';

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
