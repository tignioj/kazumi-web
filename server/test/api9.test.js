import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../index.js';
import { normalizeRule, parseImport, RuleStore, RULE_API_VERSION } from '../modules/rules/store.js';

// https://github.com/Predidit/KazumiRules snapshots from 2026-10-17.
// No public site is required by tests.
const rules = JSON.parse(
  await readFile(new URL('./fixtures/api9-rules.json', import.meta.url), 'utf8'),
);
const examples = {
  giriGiriLove: {
    id: 27119,
    detail: 'https://ani.girigirilove.com/GV27119/',
    html: '<ul class="anthology-list-play size"><li><a href="/play/1">第 1 集</a></li></ul>',
  },
  mutefun: {
    id: 3079,
    detail: 'https://www.2kdm.com/voddetail/3079',
    html: '<div class="module-play-list-content"><a class="module-play-list-link" href="/play/1">第 1 集</a></div>',
  },
  mgnacg: {
    id: 1604,
    detail: 'https://www.mgnacg.com/media/1604',
    html: '<ul class="anthology-list-play size"><li><a href="/play/1">第 1 集</a></li></ul>',
  },
  dalvdm: {
    id: 123,
    detail: 'https://www.sbdl.cc/index.php/vod/detail/id/123.html',
    html: '<div id="playlist1" class="lists-box"><a href="/index.php/vod/play/123/sid/1/nid/1.html">第 1 集</a></div>',
  },
};

test('current API 9 rules import as JSON and share links while future API levels remain rejected', () => {
  assert.equal(RULE_API_VERSION, 9);
  assert.deepEqual(
    parseImport(JSON.stringify(rules)).map((rule) => rule.api),
    ['9', '9', '9', '9'],
  );
  for (const rule of rules) {
    const share = `kazumi://${Buffer.from(JSON.stringify(rule)).toString('base64')}`;
    assert.equal(parseImport(share)[0].api, '9');
  }
  assert.equal(normalizeRule({ ...rules[0], api: 9 }).api, '9');
  for (const api of [10, '10', 0, -1, 9.5, false, {}, []]) {
    assert.throws(() => normalizeRule({ ...rules[0], api }), /最高 9/);
  }
  assert.equal(normalizeRule({ ...rules[0], api: null }).api, '1');
});

test('all four API 9 rules update, install, persist, search, and read XPath chapters through REST', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-api9-'));
  const requests = [];
  const http = {
    allowPrivate: false,
    async json(input) {
      if (input.endsWith('/index.json'))
        return rules.map(({ name, version }) => ({ name, version }));
      const name = decodeURIComponent(
        new URL(input).pathname
          .split('/')
          .at(-1)
          .replace(/\.json$/, ''),
      );
      const rule = rules.find((rule) => rule.name === name);
      assert.ok(rule, `unexpected rule download ${input}`);
      return structuredClone(rule);
    },
    async request(input) {
      const url = new URL(input);
      requests.push(input);
      const rule = rules.find((rule) => new URL(rule.baseURL).origin === url.origin);
      assert.ok(rule, `unexpected origin ${input}`);
      const example = examples[rule.name];
      if (url.pathname === '/index.php/ajax/suggest') {
        assert.equal(url.searchParams.get('wd'), '无职转生 & 测试');
        assert.equal(url.searchParams.get('mid'), '1');
        return {
          url: input,
          response: Response.json({ list: [{ id: example.id, name: '测试番剧' }] }),
        };
      }
      if (input === example.detail) return { url: input, response: new Response(example.html) };
      assert.match(url.pathname, /\/play\//);
      return { url: input, response: new Response('<video src="/movie.mp4"></video>') };
    },
    async close() {},
  };
  const application = await createApp({
    dataDir: directory,
    httpClient: http,
    browserResolver: false,
    seedRules: rules.map((rule, index) => ({
      name: rule.name,
      version: '0.1',
      baseURL: 'https://old.example/',
      enabled: index !== 0,
    })),
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await application.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (path, body) => {
    const response = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const updated = await post('/rules/update', {});
  assert.equal(updated.results.length, 4);
  assert.ok(updated.results.every((result) => result.status === 'updated'));
  assert.equal(updated.rules[0].enabled, false);
  assert.ok((await new RuleStore(directory).init()).list().every((rule) => rule.api === '9'));
  for (const rule of rules) {
    await t.test(rule.name, async () => {
      const installed = await post('/rules/install', { name: rule.name });
      assert.equal(installed.rules.find((item) => item.name === rule.name).api, '9');
      const search = await post('/rules/search', {
        keyword: '无职转生 & 测试',
        ruleNames: [rule.name],
      });
      assert.equal(search.results[0].error, undefined);
      const item = search.results[0].items[0];
      assert.equal(
        item.url,
        rule.searchApiConfig.sourceTemplate
          ? examples[rule.name].detail
          : String(examples[rule.name].id),
      );
      const chapters = await post('/rules/chapters', { ruleName: rule.name, url: item.url });
      assert.ok(requests.includes(examples[rule.name].detail));
      assert.equal(chapters.roads[0].episodes[0].name, '第1集');
      const media = await post('/resolve', {
        ruleName: rule.name,
        url: chapters.roads[0].episodes[0].url,
      });
      assert.equal(media.type, 'video');
      assert.match(media.url, /^\/api\/media\?/);
    });
  }
  const imported = await post('/rules/import', { content: rules });
  assert.ok(imported.rules.every((rule) => rule.api === '9'));
});
