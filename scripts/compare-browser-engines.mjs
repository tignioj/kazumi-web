import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBrowserFixture, runBrowserCases } from '../test/compatibility/browser-corpus.mjs';
import { createHttpClient } from '../server/lib/http.js';
import { createBrowserEgress } from '../server/lib/browser-egress.js';
import { RuleEngine } from '../server/modules/rules/engine.js';
import { LocalSourceResolver } from '../server/modules/playback/source-resolver.js';
import { BrowserResolver } from '../server/modules/playback/browser-resolver.js';
import { KazumiCoreClient } from '../test/reference/core-client.js';
import { readPinnedKazumi, verifyPins } from './lib/kazumi-upstream.mjs';

const { values } = parseArgs({
  options: {
    'local-only': { type: 'boolean' },
    output: { type: 'string' },
  },
});
const fixture = await createBrowserFixture({ port: Number(process.env.COMPAT_PORT || 17334) });
const http = createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' });
const browser = new BrowserResolver(http, { timeout: 15000, dnsOverHttpsUrl: '' });
const rules = new RuleEngine(http, { browserResolver: browser });
const source = new LocalSourceResolver(http, { browserResolver: browser });
let egress;
const report = { reference: null, local: [], official: [] };
try {
  if (!values['local-only']) {
    const pins = await readPinnedKazumi(fileURLToPath(new URL('../', import.meta.url)));
    verifyPins(pins);
    const reference = new KazumiCoreClient({
      url: process.env.KAZUMI_REFERENCE_URL || 'http://127.0.0.1:17331',
    });
    const health = await reference.request('/health');
    assert.equal(health.upstream, pins.ref);
    assert.equal(health.apiLevel, pins.apiLevel);
    report.reference = { commit: pins.ref, apiLevel: pins.apiLevel };
    egress = await createBrowserEgress({
      host: '0.0.0.0',
      port: Number(process.env.COMPAT_EGRESS_PORT || 17332),
      allowPrivate: true,
      dnsOverHttpsUrl: '',
      resolver: (host) =>
        host === 'host.docker.internal'
          ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
          : dns.lookup(host, { all: true }),
    });
    await runBrowserCases({
      engine: reference,
      origin: process.env.COMPAT_REFERENCE_ORIGIN || 'http://host.docker.internal:17334',
      fixture,
      official: true,
      onResult: (entry) => {
        report.official.push(entry);
        console.log(`official: ${entry.id}`);
      },
    });
  }
  await runBrowserCases({
    engine: {
      search: rules.search.bind(rules),
      chapters: rules.chapters.bind(rules),
      resolve: source.resolve.bind(source),
    },
    origin: fixture.origin,
    fixture,
    onResult: (entry) => {
      report.local.push(entry);
      console.log(`local: ${entry.id}`);
    },
  });
  assert.equal(browser.active.size, 0, 'All browser leases must be released');
  assert.equal(browser.browser.contexts().length, 0, 'All browser contexts must be closed');
  if (!values['local-only']) assert.deepEqual(report.local, report.official);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  throw error;
} finally {
  if (values.output) {
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  await browser.close();
  await http.close();
  await egress?.close();
  await fixture.close();
}
