import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeCoreImpact,
  readCoreImports,
  renderCoreImpact,
} from '../../scripts/lib/kazumi-impact.mjs';

const previous = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const sdk = { version: '3.47.7', revision: 'c'.repeat(40) };
const rule = 'lib/services/plugin/rule_engine.dart';
const compareUrl = `https://github.com/Predidit/Kazumi/compare/${previous}...${commit}`;
function analyze(files, options = {}) {
  return analyzeCoreImpact({
    pins: { ref: previous, sdk, apiLevel: 9, directImports: [rule], ...options.pins },
    update: { commit, sdk, apiLevel: 9, ...options.update },
    comparison: { files },
    repository: 'Predidit/Kazumi',
    api:
      options.api ||
      (async (path) => {
        throw new Error(`Unexpected GitHub call: ${path}`);
      }),
  });
}
const file = (filename, options = {}) => ({
  filename,
  status: 'modified',
  additions: 3,
  deletions: 1,
  ...options,
});

test('runtime imports include nested Dart files and new modules without scanning tests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-imports-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'nested'));
  await writeFile(
    join(directory, 'main.dart'),
    `import 'dart:io';\nimport 'package:kazumi/services/plugin/rule_engine.dart';\nimport 'package:dio/dio.dart';\n`,
  );
  await writeFile(
    join(directory, 'nested/adapter.dart'),
    `export "package:kazumi/request/core/network_config.dart";\nimport 'package:kazumi/services/plugin/rule_engine.dart';\nimport 'package:kazumi/new_core.dart';\n`,
  );
  await writeFile(join(directory, 'ignore.md'), `import 'package:kazumi/ignored.dart';`);
  assert.deepEqual(await readCoreImports(directory), [
    'lib/new_core.dart',
    'lib/request/core/network_config.dart',
    rule,
  ]);
});

test('direct core changes flag possible adaptation even when SDK, API and dependency versions stay unchanged', async () => {
  const report = await analyze([
    file(rule, {
      patch:
        '@@ -1,3 +1,3 @@\n-class OldEngine {\n+class RuleEngine {\n-  Future<Trace> search(\n+  Future<Result> query(\n+    required this.timeout,\n+    return await execute(request);',
    }),
  ]);
  assert.equal(report.level, 'adaptation');
  const change = report.modules.find((module) => module.id === 'rules').files[0];
  assert.equal(change.direct, true);
  assert.deepEqual(change.symbols, ['OldEngine', 'RuleEngine', 'query', 'search', 'timeout']);
  const markdown = renderCoreImpact(report, compareUrl);
  assert.match(markdown, /可能需要适配/);
  assert.ok(
    markdown.includes(`${compareUrl}#diff-${createHash('sha256').update(rule).digest('hex')}`),
  );
  assert.match(markdown, /\+3\/−1/);
  assert.match(markdown, /适配层直接引用/);
  assert.match(markdown, /不是完整的传递依赖或 Dart 语义分析/);
});

test('related implementations require regression checks, while UI-only and version-only changes stay low', async () => {
  const related = await analyze([file('lib/services/plugin/api_rule_engine.dart')]);
  assert.equal(related.level, 'regression');
  assert.equal(related.modules.find((module) => module.id === 'rules').files[0].direct, false);
  const uiOnly = await analyze([
    file('lib/pages/home.dart'),
    file('pubspec.yaml', { patch: '@@ -1 +1 @@\n-version: 2.3.9+20309\n+version: 2.4.0+20400' }),
  ]);
  assert.equal(uiOnly.level, 'low');
  assert.equal(uiOnly.metadataFiles, 1);
  assert.equal(uiOnly.otherFiles, 1);
  assert.match(renderCoreImpact(uiOnly, compareUrl), /监控范围内未发现核心变更/);
  const dependencies = await analyze([
    file('pubspec.yaml', { patch: '@@ -5 +5 @@\n-  dio: ^5.11.0\n+  dio: ^6.0.0' }),
  ]);
  assert.equal(dependencies.level, 'regression');
  assert.equal(dependencies.modules.find((module) => module.id === 'runtime').files.length, 1);
});

test('protocol and SDK changes require review even if no watched file was listed', async () => {
  const report = await analyze([], {
    update: { apiLevel: 10, sdk: { version: '3.48.0', revision: 'd'.repeat(40) } },
  });
  assert.equal(report.level, 'adaptation');
  assert.equal(report.apiChange, '9 → 10');
  const markdown = renderCoreImpact(report, compareUrl);
  assert.match(markdown, /3\.47\.7 → 3\.48\.0/);
  assert.match(markdown, /9 → 10/);
});

test('changed configuration fields, named parameters and settings keys are included as navigation hints', async () => {
  const path = 'lib/services/storage/settings_keys.dart';
  const report = await analyze([
    file(path, {
      patch:
        '@@ -1 +1,4 @@\n-  oldSetting,\n+  proxyEnable,\n+  static const int apiLevel = 10;\n+  required Duration timeout,\n+  final String token;',
    }),
  ]);
  assert.deepEqual(report.modules.find((module) => module.id === 'storage').files[0].symbols, [
    'apiLevel',
    'oldSetting',
    'proxyEnable',
    'timeout',
    'token',
  ]);
});

test('renaming a direct import outside watched directories still reports the old path and possible adaptation', async () => {
  const report = await analyze([
    file('lib/moved/engine.dart', { status: 'renamed', previous_filename: rule }),
  ]);
  assert.equal(report.level, 'adaptation');
  assert.equal(report.modules.find((module) => module.id === 'rules').files[0].direct, true);
  assert.match(
    renderCoreImpact(report, compareUrl),
    /rule\\_engine\.dart → lib\/moved\/engine\.dart/,
  );
  const deleted = await analyze([
    file('lib/webview/video/impl/video_webview_linux_impl.dart', { status: 'removed' }),
  ]);
  assert.equal(deleted.level, 'adaptation');
});

test('an uncategorized direct import is monitored automatically instead of being mistaken for UI-only changes', async () => {
  const path = 'lib/new_core/adapter.dart';
  const report = await analyze([file(path)], { pins: { directImports: [path] } });
  assert.equal(report.level, 'adaptation');
  assert.equal(report.modules.find((module) => module.id === 'other').files[0].filename, path);
});

test('300-file comparisons recover relevant changes beyond the API limit using both pinned trees', async () => {
  const listed = Array.from({ length: 300 }, (_, index) => file(`assets/${index}.png`));
  const calls = [];
  const report = await analyze(listed, {
    api: async (path) => {
      calls.push(path);
      assert.match(path, /git\/trees\/[ab]{40}\?recursive=1$/);
      return {
        truncated: false,
        tree: [
          {
            path: rule,
            type: 'blob',
            mode: '100644',
            sha: path.includes(previous) ? 'old' : 'new',
          },
          { path: 'lib/unmodified.dart', type: 'blob', mode: '100644', sha: 'same' },
        ],
      };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(report.complete, true);
  assert.equal(report.level, 'adaptation');
  assert.equal(report.modules.find((module) => module.id === 'rules').files[0].filename, rule);
  assert.equal(report.otherFiles, 0);
});

test('tree fallback preserves known renames and detects additional additions, removals and mode changes', async () => {
  const renamed = 'lib/services/plugin/moved.dart';
  const added = 'lib/services/plugin/added.dart';
  const removed = 'lib/services/plugin/removed.dart';
  const mode = 'lib/services/plugin/mode.dart';
  const listed = [
    file(renamed, { status: 'renamed', previous_filename: rule }),
    ...Array.from({ length: 299 }, (_, index) => file(`assets/${index}.png`)),
  ];
  const report = await analyze(listed, {
    api: async (path) => ({
      truncated: false,
      tree: path.includes(previous)
        ? [
            { path: rule, type: 'blob', sha: 'same' },
            { path: removed, type: 'blob', sha: 'x' },
            { path: mode, type: 'blob', sha: 'x', mode: '100644' },
          ]
        : [
            { path: renamed, type: 'blob', sha: 'same' },
            { path: added, type: 'blob', sha: 'x' },
            { path: mode, type: 'blob', sha: 'x', mode: '100755' },
          ],
    }),
  });
  const changes = report.modules.find((module) => module.id === 'rules').files;
  assert.equal(changes.length, 4);
  assert.deepEqual(Object.fromEntries(changes.map((change) => [change.filename, change.status])), {
    [added]: 'added',
    [mode]: 'modified',
    [renamed]: 'renamed',
    [removed]: 'removed',
  });
});

test('missing files, unavailable or truncated trees and missing import coverage never produce a low-risk claim', async () => {
  const capped = Array.from({ length: 300 }, (_, index) => file(`assets/${index}.png`));
  for (const report of [
    await analyze(undefined),
    await analyze(capped),
    await analyze(capped, { api: async () => ({ truncated: true, tree: [] }) }),
    await analyze([], { pins: { directImports: [] } }),
  ]) {
    assert.equal(report.level, 'unknown');
    assert.equal(report.complete, false);
    const markdown = renderCoreImpact(report, compareUrl);
    assert.match(markdown, /分析不完整/);
    assert.doesNotMatch(markdown, /通常只需更新/);
    assert.doesNotMatch(markdown, /监控范围内未发现变更文件/);
  }
  assert.match(renderCoreImpact(undefined, compareUrl), /分析不可用/);
});

test('long reports keep full counts and risk while limiting expanded files and escaping Markdown', async () => {
  const files = Array.from({ length: 80 }, (_, index) =>
    file(`lib/services/plugin/file_${index}.dart`),
  );
  const special = 'lib/services/plugin/[inject]|name.dart';
  files[79] = file(special);
  const report = await analyze(files, { pins: { directImports: [special] } });
  const markdown = renderCoreImpact(report, compareUrl);
  assert.equal(report.modules.find((module) => module.id === 'rules').files.length, 80);
  assert.equal(report.level, 'adaptation');
  assert.match(markdown, /仅展开前 60 个文件，其余 20 个文件/);
  assert.match(markdown, /\\\[inject\\\]\\\|name\.dart/);
});
