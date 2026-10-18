import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
} from '../../shared/network-settings.js';

test('proxy settings accept supported endpoints and reject malformed addresses and credentials', () => {
  for (const url of ['http://127.0.0.1:7890', 'https://proxy.example:8443', 'socks5://[::1]:1080'])
    assert.equal(normalizeNetworkSettings({ enabled: true, url }).enabled, true);
  for (const input of [
    null,
    [],
    { enabled: 'true' },
    { enabled: true },
    { enabled: true, url: 'localhost:7890' },
    { enabled: true, url: 'ftp://localhost' },
    { enabled: true, url: 'http://user:secret@localhost' },
    { enabled: true, url: 'http://localhost/path' },
    { enabled: true, url: 'http://localhost?query' },
    { enabled: true, url: 'http://localhost:99999' },
    { enabled: true, url: 'http://localhost:0' },
    { enabled: false, username: 'bad:name' },
    { enabled: false, password: 'orphan' },
    { enabled: true, url: 'socks5://localhost', username: '名'.repeat(86) },
  ])
    assert.throws(() => normalizeNetworkSettings(input));
});

test('ECH settings default off for existing files and survive proxy-only changes', () => {
  const legacy = { enabled: false, url: '', username: '', password: '' };
  assert.deepEqual(normalizeNetworkSettings(legacy), {
    ...legacy,
    bangumiEch: false,
    echDohUrl: DEFAULT_NETWORK_SETTINGS.echDohUrl,
  });
  const configured = normalizeNetworkSettings({
    ...legacy,
    bangumiEch: true,
    echDohUrl: ' https://dns.example/dns-query ',
  });
  assert.deepEqual(normalizeNetworkSettings({ enabled: false }, configured), {
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
