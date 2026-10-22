import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import {
  buildCases,
  canonicalRequest,
  normalizeOrigin,
  searchCase,
} from '../test/compatibility/corpus.mjs';
import { createHttpClient } from '../server/lib/http.js';
import { createBrowserEgress } from '../server/lib/browser-egress.js';
import { RuleEngine } from '../server/modules/rules/engine.js';
import { parseImport } from '../server/modules/rules/store.js';
import { KazumiCoreClient } from '../test/reference/core-client.js';
import { readPinnedKazumi } from './lib/kazumi-upstream.mjs';

const { values } = parseArgs({
  options: {
    record: { type: 'boolean' },
    rounds: { type: 'string', default: '10' },
    output: { type: 'string' },
  },
});
const port = Number(process.env.COMPAT_PORT || 17334);
const origin = `http://127.0.0.1:${port}`;
const referenceOrigin =
  process.env.COMPAT_REFERENCE_ORIGIN || `http://host.docker.internal:${port}`;
const cases = buildCases(origin),
  referenceCases = buildCases(referenceOrigin);
const observed = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const [, , id, phase] = new URL(request.url, origin).pathname.split('/');
  const corpus = request.headers.host === new URL(referenceOrigin).host ? referenceCases : cases;
  const c = corpus.find((item) => item.id === id);
  observed.push(
    canonicalRequest(
      new URL(request.url, origin),
      {
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString() || null,
      },
      { rule: c?.rule, phase: phase === 'search' ? 'search' : 'chapter' },
    ),
  );
  const body = phase === 'search' ? c?.search : c?.chapters;
  response.setHeader(
    'content-type',
    typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
  );
  if (phase === 'search' && c?.searchResponse) {
    response.statusCode = c.searchResponse.status;
    for (const [name, value] of Object.entries(c.searchResponse.headers))
      response.setHeader(name, value);
  }
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
});
server.listen(port, '0.0.0.0');
await once(server, 'listening');
const egress = await createBrowserEgress({
  host: '0.0.0.0',
  port: Number(process.env.COMPAT_EGRESS_PORT || 17332),
  allowPrivate: true,
  dnsOverHttpsUrl: '',
  resolver: (host) =>
    host === 'host.docker.internal'
      ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
      : dns.lookup(host, { all: true }),
});
const http = createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' });
const local = new RuleEngine(http);
const reference = new KazumiCoreClient({
  url: process.env.KAZUMI_REFERENCE_URL || 'http://127.0.0.1:17331',
});
const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const pins = await readPinnedKazumi(root);
  const health = await reference.request('/health');
  assert.equal(health.upstream, pins.ref);
  assert.equal(health.apiLevel, pins.apiLevel);
  const catalog = JSON.parse(
    await readFile(new URL('../server/defaults/official-rules.json', import.meta.url)),
  );
  const accepted = (await reference.validate(catalog.rules)).map((rule) => rule.name);
  assert.deepEqual(
    parseImport(catalog.rules).map((rule) => rule.name),
    accepted,
  );
  for (const rule of catalog.rules) {
    const share = `kazumi://${Buffer.from(JSON.stringify(rule)).toString('base64url')}`;
    assert.deepEqual(
      parseImport(share).map((item) => item.name),
      (await reference.validate(share)).map((item) => item.name),
    );
  }
  const golden = {
    upstream: pins.ref,
    apiLevel: pins.apiLevel,
    rulesCommit: catalog.commit,
    imports: accepted,
    cases: [],
  };
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i],
      r = referenceCases[i];
    observed.length = 0;
    const expected = {
      id: c.id,
      search: normalizeOrigin(await searchCase(reference, r, 'CAPTCHA_REQUIRED'), referenceOrigin),
      chapters: normalizeOrigin(await reference.chapters(r.rule, r.source), referenceOrigin),
      requests: normalizeOrigin(observed, referenceOrigin),
    };
    golden.cases.push(expected);
    observed.length = 0;
    const actual = {
      id: c.id,
      search: normalizeOrigin(await searchCase(local, c), origin),
      chapters: normalizeOrigin(await local.chapters(c.rule, c.source), origin),
      requests: normalizeOrigin(observed, origin),
    };
    try {
      assert.deepEqual(actual, expected);
    } catch (error) {
      console.error(`Mismatch: ${c.id}`);
      console.error(error.message);
      process.exitCode = 1;
    }
  }
  if (values.record) {
    if (process.exitCode)
      throw new Error('Resolve every compatibility difference before recording official output');
    await writeFile(
      new URL('../test/compatibility/golden.json', import.meta.url),
      JSON.stringify(golden, null, 2) + '\n',
    );
  } else {
    const saved = JSON.parse(
      await readFile(new URL('../test/compatibility/golden.json', import.meta.url)),
    );
    assert.deepEqual(
      golden,
      saved,
      'Official output changed: review and explicitly regenerate the golden corpus',
    );
  }
  if (process.exitCode) throw new Error('Compatibility differences remain');
  const rounds = Number(values.rounds);
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 1000);
  const timings = { local: [], reference: [] };
  for (let round = -2; round < rounds; round++) {
    // Alternate order after two warm-up rounds. Every operation uses the same fixture host and payload.
    for (const name of round % 2 ? ['local', 'reference'] : ['reference', 'local']) {
      for (let i = 0; i < cases.length; i++) {
        const engine = name === 'local' ? local : reference,
          c = name === 'local' ? cases[i] : referenceCases[i];
        const start = performance.now();
        await searchCase(
          engine,
          c,
          name === 'reference' ? 'CAPTCHA_REQUIRED' : 'VERIFICATION_REQUIRED',
        );
        await engine.chapters(c.rule, c.source);
        if (round >= 0) timings[name].push(performance.now() - start);
      }
    }
  }
  const metrics = Object.fromEntries(
    Object.entries(timings).map(([name, entries]) => {
      entries.sort((a, b) => a - b);
      return [
        name,
        {
          samples: entries.length,
          medianMs: entries[Math.floor(entries.length / 2)],
          p95Ms: entries[Math.ceil(entries.length * 0.95) - 1],
        },
      ];
    }),
  );
  const report = {
    upstream: pins.ref,
    cases: cases.length,
    rounds,
    measured:
      'search + chapters per source, HTTP fixture, two warm-up rounds; host Node versus Docker Flutter; not a pure parser microbenchmark',
    metrics,
  };
  console.log(JSON.stringify(report, null, 2));
  if (values.output) {
    await mkdir(new URL('.', new URL(values.output, `file://${process.cwd()}/`)), {
      recursive: true,
    });
    await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  await http.close();
  await egress.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
