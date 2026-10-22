import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RuleEngine } from '../../server/modules/rules/engine.js';
import { parseImport } from '../../server/modules/rules/store.js';
import { buildCases, canonicalRequest, normalizeOrigin, searchCase } from './corpus.mjs';

const origin = 'http://fixture.example';
const golden = JSON.parse(await readFile(new URL('./golden.json', import.meta.url)));
test('the complete pinned official catalog imports locally as JSON and share links', async () => {
  const catalog = JSON.parse(
    await readFile(new URL('../../server/defaults/official-rules.json', import.meta.url)),
  );
  assert.equal(catalog.commit, golden.rulesCommit);
  assert.deepEqual(
    parseImport(catalog.rules).map((rule) => rule.name),
    golden.imports,
  );
  for (const rule of catalog.rules) {
    const share = `kazumi://${Buffer.from(JSON.stringify(rule)).toString('base64url')}`;
    assert.equal(parseImport(share)[0].name, rule.name);
  }
});
for (const c of buildCases(origin)) {
  test(`official ${golden.upstream.slice(0, 12)}: ${c.id}`, async () => {
    const requests = [];
    const http = {
      async request(url, options) {
        const search = requests.length === 0;
        requests.push(
          canonicalRequest(url, options, { rule: c.rule, phase: search ? 'search' : 'chapter' }),
        );
        const raw = search ? c.search : c.chapters;
        return {
          url,
          response:
            typeof raw === 'string'
              ? new Response(raw, search ? c.searchResponse : undefined)
              : Response.json(raw),
        };
      },
      async text(url, options) {
        const { response } = await this.request(url, options);
        return { text: await response.text(), url };
      },
    };
    const engine = new RuleEngine(http);
    parseImport(c.rule);
    const actual = {
      id: c.id,
      search: normalizeOrigin(await searchCase(engine, c), origin),
      chapters: normalizeOrigin(await engine.chapters(c.rule, c.source), origin),
      requests: normalizeOrigin(requests, origin),
    };
    assert.deepEqual(
      actual,
      golden.cases.find((entry) => entry.id === c.id),
    );
  });
}
