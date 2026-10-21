import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyUpdate,
  compareVersions,
  discoverUpdate,
  discoverMainUpdate,
  readPinnedKazumi,
  verifyPins,
  upgradeBody,
} from '../../scripts/lib/kazumi-upstream.mjs';
import { checkCore } from '../../scripts/check-kazumi-core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const previous = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const flutterCommit = 'c'.repeat(40);
function pinned() {
  return {
    ref: previous,
    version: '2.3.9+20309',
    lockedRef: previous,
    requestedRef: previous,
    reportedRef: previous,
    sdk: { version: '3.47.7', revision: 'd'.repeat(40) },
    apiLevel: 9,
  };
}
function releaseApi({ version = '2.4.0', flutter = '3.47.7', status = 'ahead', ...flags } = {}) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.endsWith('/releases/latest'))
      return {
        tag_name: version,
        target_commitish: 'main',
        draft: false,
        prerelease: false,
        ...flags,
      };
    if (path.endsWith(`/commits/${version}`)) return { sha: commit };
    if (path.includes('/compare/')) return { status };
    if (path.includes('/contents/pubspec.yaml'))
      return `version: ${version}+20400\nenvironment:\n  flutter: ${flutter}\n`;
    if (path.includes('/contents/lib/request/config/api_endpoints.dart'))
      return 'static const int apiLevel = 10;';
    if (path === `repos/flutter/flutter/commits/${flutter}`) return { sha: flutterCommit };
    throw new Error(`Unexpected GitHub request: ${path}`);
  };
  return { api, calls };
}

test('stable version comparison ignores build numbers and rejects prereleases or shell text', () => {
  assert.equal(compareVersions('v2.3.9', '2.3.9+20309'), 0);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('2.3.8', '2.3.9'), -1);
  for (const version of ['2.4.0-beta.1', '2.4.0;echo token', 'latest']) {
    assert.throws(() => compareVersions(version, '2.3.9'), /Unsupported stable version/);
  }
});

function mainApi({
  changed = ['lib/services/plugin/rule_engine.dart'],
  status = 'ahead',
  truncated = false,
  head = commit,
} = {}) {
  const release = releaseApi();
  const calls = [];
  const api = async (path, options) => {
    calls.push(path);
    if (path.endsWith('/commits/main')) return { sha: head };
    if (path.includes('/contents/pubspec.yaml'))
      return 'version: 2.3.9+20309\nenvironment:\n  flutter: 3.47.7\n';
    if (path.includes('/compare/')) return { status };
    if (path.includes('/git/trees/'))
      return {
        truncated,
        tree: changed.map((name) => ({
          path: name,
          type: 'blob',
          sha: path.includes(previous) ? previous : commit,
        })),
      };
    return release.api(path, options);
  };
  return { api, calls };
}

test('main monitoring detects unreleased behavior changes even when the version is unchanged', async () => {
  const changed = [
    'lib/webview/captcha/impl/new.dart',
    'lib/services/video_source/parser.dart',
    'README.md',
  ];
  const { api } = mainApi({ changed });
  const update = await discoverMainUpdate(pinned(), api);
  assert.equal(update.source, 'main');
  assert.equal(update.commit, commit);
  assert.equal(update.version, pinned().version);
  assert.deepEqual(update.changedPaths, changed.filter((path) => path !== 'README.md').sort());
  assert.equal(update.branch, `codex/kazumi-main-${commit.slice(0, 12)}`);
  assert.match(upgradeBody(update), /No automatic merging/);
  assert.match(upgradeBody(update), /captcha/);
});

test('main ignores unchanged pins and unrelated files without proposing upgrade PRs', async () => {
  for (const config of [{ head: previous }, { changed: ['README.md', 'lib/pages/about.dart'] }]) {
    const { api, calls } = mainApi(config);
    assert.equal((await discoverMainUpdate(pinned(), api)).available, false);
    assert.ok(!calls.some((path) => path.includes('/contents/')));
  }
});

test('main detects removed watched files using complete trees and fails on truncated or rewritten history', async () => {
  const { api } = mainApi();
  const update = await discoverMainUpdate(pinned(), (path, options) =>
    path.includes(`/git/trees/${commit}`) ? { tree: [], truncated: false } : api(path, options),
  );
  assert.deepEqual(update.changedPaths, ['lib/services/plugin/rule_engine.dart']);
  for (const config of [{ truncated: true }, { status: 'diverged' }, { head: 'main' }])
    await assert.rejects(discoverMainUpdate(pinned(), mainApi(config).api));
});

test('an equal or older stable release never rolls back a pin containing newer fixes', async () => {
  for (const version of ['2.3.9', '2.3.8']) {
    const { api, calls } = releaseApi({ version });
    assert.equal((await discoverUpdate(pinned(), api)).available, false);
    assert.deepEqual(calls, ['repos/Predidit/Kazumi/releases/latest']);
  }
});

test('release tags resolve to full SHAs, never the mutable release target branch', async () => {
  const { api, calls } = releaseApi();
  const update = await discoverUpdate(pinned(), api);
  assert.equal(update.commit, commit);
  assert.equal(update.branch, `codex/kazumi-${commit.slice(0, 12)}`);
  assert.equal(update.apiLevel, 10);
  assert.deepEqual(update.sdk, pinned().sdk);
  assert.ok(calls.includes(`repos/Predidit/Kazumi/compare/${previous}...${commit}`));
  assert.ok(
    calls
      .filter((path) => path.includes('/contents/'))
      .every((path) => path.endsWith(`?ref=${commit}`)),
  );
});

test('a newer Flutter requirement is resolved and pinned independently', async () => {
  const { api } = releaseApi({ flutter: '3.48.0' });
  assert.deepEqual((await discoverUpdate(pinned(), api)).sdk, {
    version: '3.48.0',
    revision: flutterCommit,
  });
});

test('drafts, prereleases and divergent or older commit histories need manual review', async () => {
  for (const flags of [
    { draft: true },
    { prerelease: true },
    { status: 'behind' },
    { status: 'diverged' },
  ]) {
    await assert.rejects(discoverUpdate(pinned(), releaseApi(flags).api));
  }
  const { api } = releaseApi();
  await assert.rejects(
    discoverUpdate(pinned(), async (path, options) =>
      path.endsWith('/commits/2.4.0') ? { sha: 'main' } : api(path, options),
    ),
    /immutable commit/,
  );
  await assert.rejects(
    discoverUpdate(pinned(), async (path, options) =>
      path.includes('/contents/pubspec.yaml')
        ? 'version: 2.5.0\nenvironment:\n  flutter: 3.47.7\n'
        : api(path, options),
    ),
    /tag and package version differ/,
  );
});

test('stale lockfiles and misleading health revision constants fail before checking releases', async () => {
  for (const key of ['lockedRef', 'requestedRef', 'reportedRef']) {
    await assert.rejects(
      discoverUpdate({ ...pinned(), [key]: commit }, async () => {
        assert.fail('An inconsistent pin must not make GitHub requests');
      }),
    );
  }
});

test('updating sources leaves lock generation to Flutter and verifies the resulting SHA', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = [
    'test/reference/kazumi-core/pubspec.yaml',
    'test/reference/kazumi-core/pubspec.lock',
    'test/reference/kazumi-core/lib/core.dart',
    'test/reference/kazumi-core/flutter-sdk.json',
    'test/reference/capabilities.js',
    'server/modules/rules/validation.js',
  ];
  for (const path of paths) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await copyFile(join(root, path), join(directory, path));
  }
  const pins = await readPinnedKazumi(directory);
  verifyPins(pins);
  const { api } = releaseApi();
  const update = await discoverUpdate(pinned(), api);
  await applyUpdate(directory, pins, update);
  const updated = await readPinnedKazumi(directory);
  assert.equal(updated.ref, commit);
  assert.equal(updated.reportedRef, commit);
  assert.equal(updated.apiLevel, 10);
  assert.equal(await readFile(join(directory, paths[1]), 'utf8'), pins.sources.lock);
  assert.throws(() => verifyPins(updated), /pubspec.lock/);
  assert.equal(
    await readFile(join(directory, 'server/modules/rules/validation.js'), 'utf8'),
    await readFile(join(root, 'server/modules/rules/validation.js'), 'utf8'),
    'Reference upgrades must not raise the local API level',
  );
});

test('core readiness retries startup but rejects a stale binary or a mismatched API', async () => {
  const pins = await readPinnedKazumi(root);
  const health = { status: 'ok', upstream: pins.ref, apiLevel: pins.apiLevel };
  let attempts = 0;
  assert.deepEqual(
    await checkCore({
      root,
      url: 'http://core:7331',
      interval: 1,
      fetcher: async () => {
        if (++attempts === 1) throw new Error('ECONNREFUSED');
        return Response.json(health);
      },
    }),
    health,
  );
  assert.equal(attempts, 2);
  for (const invalid of [
    { ...health, upstream: commit },
    { ...health, apiLevel: 99 },
  ]) {
    await assert.rejects(
      checkCore({ root, url: 'http://core:7331', fetcher: async () => Response.json(invalid) }),
    );
  }
  await assert.rejects(
    checkCore({
      root,
      url: 'http://core:7331',
      timeout: 0,
      fetcher: async () => new Response('', { status: 503 }),
    }),
    /did not become ready/,
  );
});
