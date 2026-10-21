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
  upgradeTitle,
} from '../../scripts/lib/kazumi-upstream.mjs';
import { dependencyChanges } from '../../scripts/lib/kazumi-relevance.mjs';
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
    if (path.includes('/compare/'))
      return {
        status,
        commits: [{ sha: commit, commit: { message: 'Fix rule request parsing\n\nDetails' } }],
        total_commits: 1,
      };
    if (path.includes('/git/trees/'))
      return {
        truncated: false,
        tree: [
          {
            path: 'lib/services/plugin/rule_engine.dart',
            type: 'blob',
            sha: path.includes(previous) ? previous : commit,
          },
        ],
      };
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
    if (path.includes('/compare/')) return { ...(await release.api(path, options)), status };
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
  assert.match(upgradeBody(update), /Fix rule request parsing/);
  assert.match(upgradeBody(update), /版本号未变/);
  assert.match(upgradeBody(update), /线上 Node 引擎/);
  assert.match(upgradeTitle(update), /视频解析、验证码/);
});

function dependencyApi({ names, before, after, changed = [] }) {
  const base = mainApi({ changed: ['pubspec.yaml', 'pubspec.lock', ...changed] });
  const lock = (versions) =>
    'packages:\n' +
    Object.entries(versions)
      .map(
        ([name, version]) =>
          `  ${name}:\n    dependency: transitive\n    description:\n      name: ${name}\n      url: "https://pub.dev"\n    source: hosted\n    version: "${version}"\n`,
      )
      .join('');
  const manifest = (versions) =>
    `version: 2.4.0+20400\nenvironment:\n  flutter: 3.47.7\ndependencies:\n${names.map((name) => (versions[name] ? `  ${name}: ^${versions[name]}\n` : '')).join('')}`;
  return async (path, options) => {
    const versions = path.endsWith(`?ref=${previous}`) ? before : after;
    if (path.includes('/contents/pubspec.yaml')) return manifest(versions);
    if (path.includes('/contents/pubspec.lock')) return lock(versions);
    return base.api(path, options);
  };
}

test('PR #5 native progress bar removal does not create a main or stable upgrade', async () => {
  const config = {
    names: ['audio_video_progress_bar'],
    before: { audio_video_progress_bar: '2.0.3' },
    after: {},
    changed: [
      'lib/pages/player/player_seek_controller.dart',
      'lib/pages/player/player_progress_bar.dart',
      'lib/utils/theme.dart',
    ],
  };
  for (const discover of [discoverMainUpdate, discoverUpdate]) {
    const update = await discover(pinned(), dependencyApi(config));
    assert.equal(update.available, false);
    assert.match(update.reason, /No Web-relevant/);
    assert.deepEqual(update.ignoredDependencies, ['audio_video_progress_bar']);
    assert.ok(update.ignoredPaths.includes('pubspec.lock'));
    assert.deepEqual(update.changedPaths, []);
  }
});

test('dependency-only HTTP, parser and browser changes qualify, including transitive lock changes', async () => {
  for (const [name, areas] of [
    ['dio', ['network']],
    ['http_parser', ['network']],
    ['html', ['rules']],
    ['json_path', ['rules']],
    ['flutter_inappwebview_platform_interface', ['video', 'captcha']],
  ]) {
    const api = dependencyApi({
      names: name === 'http_parser' ? [] : [name],
      before: { [name]: '1.0.0' },
      after: { [name]: '1.1.0' },
    });
    const update = await discoverMainUpdate(pinned(), api);
    assert.equal(update.available, true, name);
    assert.deepEqual(update.areas, areas);
    assert.deepEqual(update.sourceChanges, []);
    assert.deepEqual(
      update.dependencyChanges[0].fields.find(({ field }) => field === 'lock.version'),
      {
        field: 'lock.version',
        before: '1.0.0',
        after: '1.1.0',
      },
    );
    assert.match(upgradeBody(update), /1\.0\.0 → 1\.1\.0/);
    assert.ok(
      upgradeTitle(update).includes(
        areas[0] === 'network' ? '网络' : areas[0] === 'rules' ? '规则引擎' : '视频解析',
      ),
    );
    assert.equal(
      (await discoverUpdate(pinned(), api)).available,
      true,
      'Stable uses the same policy',
    );
  }
});

test('mixed UI and relevant changes keep only relevant dependency evidence and source statuses', async () => {
  const update = await discoverMainUpdate(
    pinned(),
    dependencyApi({
      names: ['audio_video_progress_bar', 'dio'],
      before: { audio_video_progress_bar: '2.0.3', dio: '5.11.0' },
      after: { dio: '5.12.0' },
      changed: [
        'lib/services/plugin/rule_engine.dart',
        'lib/utils/async_single_flight.dart',
        'lib/utils/theme.dart',
      ],
    }),
  );
  assert.deepEqual(
    update.dependencyChanges.map(({ name }) => name),
    ['dio'],
  );
  assert.deepEqual(update.ignoredDependencies, ['audio_video_progress_bar']);
  assert.ok(update.sourceChanges.some(({ path }) => path === 'lib/utils/async_single_flight.dart'));
  assert.ok(!update.changedPaths.includes('lib/utils/theme.dart'));
  assert.match(upgradeBody(update), /audio\\_video\\_progress\\_bar/);
  assert.match(upgradeBody(update), /5\.11\.0 → 5\.12\.0/);
});

test('dependency comparison includes Git/source/hash/override changes at the same version and ignores formatting', () => {
  const snapshot = {
    pubspec:
      'dependencies:\n  webview_windows:\n    git:\n      url: https://github.com/example/webview.git\n      ref: old\ndev_dependencies:\n  flutter_lints: ^1.0.0\n',
    lock: 'packages:\n  webview_windows:\n    dependency: "direct main"\n    description:\n      resolved-ref: old\n      url: https://github.com/example/webview.git\n    source: git\n    version: "1.0.0"\n',
  };
  const next = {
    pubspec:
      snapshot.pubspec.replace('ref: old', 'ref: new') + 'dependency_overrides:\n  http: ^2.0.0\n',
    lock: snapshot.lock.replace('resolved-ref: old', 'resolved-ref: new'),
  };
  const changes = dependencyChanges(snapshot, next);
  assert.deepEqual(
    changes.map(({ name }) => name),
    ['http', 'webview_windows'],
  );
  assert.deepEqual(
    changes[1].fields.map(({ field }) => field),
    ['constraint.git.ref', 'lock.description.resolved-ref'],
  );
  const formatted = {
    pubspec: snapshot.pubspec.replace('^1.0.0', '^2.0.0'),
    lock: snapshot.lock
      .replace('"1.0.0"', "'1.0.0' # comment")
      .replace('"direct main"', 'transitive'),
  };
  assert.deepEqual(dependencyChanges(snapshot, formatted), []);
  const hashed = {
    ...snapshot,
    lock: snapshot.lock.replace('      resolved-ref:', '      sha256: abc\n      resolved-ref:'),
  };
  assert.deepEqual(
    dependencyChanges(hashed, {
      ...hashed,
      lock: hashed.lock.replace('sha256: abc', 'sha256: def'),
    })[0].fields,
    [{ field: 'lock.description.sha256', before: 'abc', after: 'def' }],
  );
  assert.deepEqual(
    dependencyChanges(snapshot, {
      ...snapshot,
      lock: snapshot.lock.replace('source: git', 'source: hosted'),
    })[0].fields,
    [{ field: 'lock.source', before: 'git', after: 'hosted' }],
  );
  assert.throws(
    () =>
      dependencyChanges(snapshot, {
        ...snapshot,
        pubspec: 'dependencies:\n  http: &unsupported 1.0\n',
      }),
    /Unsupported pubspec YAML/,
  );
  assert.throws(
    () => dependencyChanges(snapshot, { ...snapshot, pubspec: 'dependencies: {http: ^1.0.0}\n' }),
    /Unsupported pubspec YAML section/,
  );
});

test('version, SDK and development dependency changes alone do not request an upgrade', async () => {
  const base = mainApi({ changed: ['pubspec.yaml', 'pubspec.lock'] });
  const api = (path, options) => {
    if (path.includes('/contents/pubspec.yaml'))
      return path.includes(previous)
        ? 'version: 2.3.9\nenvironment:\n  flutter: 3.47.7\ndev_dependencies:\n  flutter_lints: ^1.0.0\n'
        : 'version: 2.4.0\nenvironment:\n  flutter: 3.48.0\ndev_dependencies:\n  flutter_lints: ^2.0.0\n';
    if (path.includes('/contents/pubspec.lock')) return 'packages:\n';
    return base.api(path, options);
  };
  for (const discover of [discoverMainUpdate, discoverUpdate])
    assert.equal((await discover(pinned(), api)).available, false);
});

test('complete trees retain new/removed critical files beyond compare limits and bodies show available evidence', async () => {
  const base = mainApi();
  const removed = 'lib/services/plugin/old.dart';
  const added = 'lib/services/plugin/new.dart';
  const api = async (path, options) => {
    if (path.includes('/git/trees/'))
      return {
        truncated: false,
        tree: [
          { path: path.includes(previous) ? removed : added, type: 'blob', sha: commit },
          ...Array.from({ length: 301 }, (_, index) => ({
            path: `lib/pages/ui${index}.dart`,
            type: 'blob',
            sha: path.includes(previous) ? previous : commit,
          })),
        ],
      };
    if (path.includes('/compare/'))
      return {
        status: 'ahead',
        total_commits: 1,
        commits: [{ sha: commit, commit: { message: 'Handle @reviewer <script> in rules' } }],
        files: [{ filename: added, patch: '@@ -1 +1 @@\n-oldRequest();\n+newRequest();' }],
      };
    return base.api(path, options);
  };
  const update = await discoverMainUpdate(pinned(), api);
  assert.deepEqual(update.changedPaths, [added, removed]);
  assert.deepEqual(
    update.sourceChanges.map(({ status }) => status),
    ['added', 'removed'],
  );
  const body = upgradeBody(update);
  assert.match(body, /newRequest\(\)/);
  assert.match(body, /没有可用的 compare 差异片段/);
  assert.match(body, /&#64;reviewer/);
  assert.ok(!body.includes('<script>'));
  assert.match(body, /已过滤 301 个非相关文件/);
});

test('main ignores unchanged pins and unrelated files without proposing upgrade PRs', async () => {
  for (const config of [{ head: previous }, { changed: ['README.md', 'lib/pages/about.dart'] }]) {
    const { api, calls } = mainApi(config);
    assert.equal((await discoverMainUpdate(pinned(), api)).available, false);
    assert.ok(!calls.some((path) => path.includes('/contents/')));
  }
});

test('mixed header/UI constants ignore native styles but retain UA changes even after a semicolon', async () => {
  const base = mainApi({ changed: ['lib/utils/constants.dart'] });
  const before =
    "const List<String> userAgentsList = ['Mozilla/5.0 (Windows; Chrome/1)'];\nconst sliderStyle = 1;";
  for (const [after, available] of [
    [before.replace('sliderStyle = 1', 'sliderStyle = 2'), false],
    [before.replace('Chrome/1', 'Chrome/2'), true],
  ]) {
    const update = await discoverMainUpdate(pinned(), (path, options) =>
      path.includes('/contents/lib/utils/constants.dart')
        ? path.includes(previous)
          ? before
          : after
        : base.api(path, options),
    );
    assert.equal(update.available, available);
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
