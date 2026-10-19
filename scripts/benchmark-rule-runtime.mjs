import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fixtureRule, fixtureUrl } from '../test/e2e/fixtures/upstream.mjs';
import { readPinnedKazumi } from './lib/kazumi-upstream.mjs';

const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    rounds: { type: 'string', default: '10' },
    output: { type: 'string' },
    'idle-ms': { type: 'string', default: '35000' },
  },
});
const rounds = Number(values.rounds),
  idle = Number(values['idle-ms']);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 1000);
assert.ok(Number.isFinite(idle) && idle >= 0 && idle <= 60000);
const configurations = {
  baseline: {
    url: process.env.BASELINE_URL || 'http://127.0.0.1:17300',
    containers: ['kazumi-engine-baseline-web', 'kazumi-engine-baseline-core'],
  },
  local: {
    url: process.env.LOCAL_URL || 'http://127.0.0.1:17301',
    containers: ['kazumi-engine-local-web'],
  },
};
const operations = {
  search: ['/rules/search', { keyword: '测试番剧', ruleNames: [fixtureRule.name] }],
  chapters: [
    '/rules/chapters',
    { ruleName: fixtureRule.name, url: `${fixtureUrl}/source/subject/101` },
  ],
  staticMP4: ['/resolve', { ruleName: fixtureRule.name, url: `${fixtureUrl}/source/watch/1` }],
  staticHLS: ['/resolve', { ruleName: fixtureRule.name, url: `${fixtureUrl}/source/watch/2` }],
  dynamicMP4: ['/resolve', { ruleName: fixtureRule.name, url: `${fixtureUrl}/source/dynamic/1` }],
};
async function post(config, path, body) {
  const response = await fetch(`${config.url}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: config.cookie || '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.notEqual(data.type, 'verification');
  return data;
}
async function cpu(config) {
  const samples = await Promise.all(
    config.containers.map(async (name) => {
      const { stdout } = await exec('docker', ['exec', name, 'cat', '/sys/fs/cgroup/cpu.stat']);
      return Number(/usage_usec (\d+)/.exec(stdout)[1]);
    }),
  );
  return samples.reduce((a, b) => a + b, 0);
}
async function memory(config) {
  const { stdout } = await exec('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{json .}}',
    ...config.containers,
  ]);
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const data = JSON.parse(line);
      return { name: data.Name, memory: data.MemUsage.split(' / ')[0], pids: Number(data.PIDs) };
    });
}
const report = {
  date: new Date().toISOString(),
  node: process.version,
  fixture: fixtureUrl,
  rounds,
  idleMs: idle,
  workloads:
    'Same Docker VM, same HTTP fixture and media bytes, sequential requests, two warm-up rounds; baseline = Node + pinned Flutter; local = Node + on-demand Chromium. Results include network and runtime overhead.',
  results: {},
};
const pins = await readPinnedKazumi(fileURLToPath(new URL('../', import.meta.url)));
let health;
const coreDeadline = Date.now() + 60000;
while (!health) {
  try {
    health = JSON.parse(
      (
        await exec('docker', [
          'exec',
          'kazumi-engine-baseline-core',
          'curl',
          '-fs',
          'http://127.0.0.1:7331/health',
        ])
      ).stdout,
    );
  } catch (error) {
    if (Date.now() >= coreDeadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
assert.equal(health.upstream, pins.ref);
report.upstream = health.upstream;
report.baselineCommit = '0a560d76555633d20609744cc8d5feb368079c35';
report.images = [];
for (const tag of [
  'kazumi-web:engine-baseline',
  'kazumi-core:engine-reference',
  'kazumi-web:local-engine',
]) {
  const image = JSON.parse((await exec('docker', ['image', 'inspect', tag])).stdout)[0];
  report.images.push({
    tag,
    id: image.Id,
    architecture: image.Architecture,
    os: image.Os,
    bytes: image.Size,
  });
}
for (const [name, config] of Object.entries(configurations)) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const ready = await fetch(`${config.url}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (ready.ok) break;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`${name} did not become ready`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const session = await fetch(`${config.url}/api/verification-session`);
  config.cookie = session.headers.get('set-cookie').split(';')[0];
  await post(config, '/rules/import', { content: fixtureRule });
  report.results[name] = { beforeRequests: await memory(config), coldMs: {}, latencies: {} };
  for (const [operation, [path, body]] of Object.entries(operations)) {
    const start = performance.now();
    const data = await post(config, path, body);
    report.results[name].coldMs[operation] = performance.now() - start;
    if (operation === 'search') {
      assert.equal(data.results[0].error, undefined);
      assert.equal(data.results[0].items.length, 2);
    } else if (operation === 'chapters') assert.equal(data.roads.length, 2);
    else {
      assert.equal(data.type, operation === 'staticHLS' ? 'hls' : 'video');
      const media = await fetch(new URL(data.url, config.url), {
        headers: { range: 'bytes=0-31' },
      });
      assert.equal(media.status, operation === 'staticHLS' ? 200 : 206);
      assert.ok((await media.arrayBuffer()).byteLength > 0);
    }
  }
}
for (let round = -2; round < rounds; round++) {
  for (const name of round % 2 ? ['local', 'baseline'] : ['baseline', 'local']) {
    const config = configurations[name];
    const startCpu = round >= 0 ? await cpu(config) : 0;
    for (const [operation, [path, body]] of Object.entries(operations)) {
      const start = performance.now();
      await post(config, path, body);
      if (round >= 0)
        (report.results[name].latencies[operation] ||= []).push(performance.now() - start);
    }
    if (round >= 0)
      report.results[name].cpuUsec =
        (report.results[name].cpuUsec || 0) + (await cpu(config)) - startCpu;
  }
}
for (const [name, config] of Object.entries(configurations))
  report.results[name].afterRequests = await memory(config);
await new Promise((resolve) => setTimeout(resolve, idle));
for (const [name, config] of Object.entries(configurations)) {
  const result = report.results[name];
  result.afterIdle = await memory(config);
  result.latencies = Object.fromEntries(
    Object.entries(result.latencies).map(([operation, entries]) => {
      entries.sort((a, b) => a - b);
      return [
        operation,
        {
          samples: entries.length,
          medianMs: entries[Math.floor(entries.length / 2)],
          p95Ms: entries[Math.ceil(entries.length * 0.95) - 1],
        },
      ];
    }),
  );
}
console.log(JSON.stringify(report, null, 2));
if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
