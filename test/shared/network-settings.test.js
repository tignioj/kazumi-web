import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNetworkSettings } from '../../shared/network-settings.js';

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
