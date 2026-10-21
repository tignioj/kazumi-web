import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessRelevance, markdown, webAreas } from './kazumi-relevance.mjs';

export const upstreamRepository = 'Predidit/Kazumi';
const shaPattern = /^[a-f0-9]{40}$/;
const files = {
  pubspec: 'test/reference/kazumi-core/pubspec.yaml',
  lock: 'test/reference/kazumi-core/pubspec.lock',
  core: 'test/reference/kazumi-core/lib/core.dart',
  sdk: 'test/reference/kazumi-core/flutter-sdk.json',
  validation: 'test/reference/capabilities.js',
};

function capture(text, pattern, label) {
  const value = pattern.exec(text)?.[1];
  assert.ok(value, `Cannot read ${label}; review the upstream adapter before upgrading`);
  return value;
}

export function compareVersions(a, b) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+\d+)?$/.exec(value);
    assert.ok(match, `Unsupported stable version: ${value}`);
    return match.slice(1).map(BigInt);
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export async function readPinnedKazumi(root) {
  const entries = await Promise.all(
    Object.entries(files).map(async ([key, path]) => [
      key,
      await readFile(join(root, path), 'utf8'),
    ]),
  );
  const sources = Object.fromEntries(entries);
  const dependency = capture(sources.pubspec, /^  kazumi:\n((?:    .*\n)*)/m, 'Kazumi dependency');
  const locked = capture(sources.lock, /^  kazumi:\n((?:    .*\n)*)/m, 'Kazumi lock');
  const ref = capture(dependency, /^      ref: ([a-f0-9]{40})$/m, 'pinned Kazumi SHA');
  return {
    ref,
    version: capture(locked, /^    version: "([^"]+)"$/m, 'locked Kazumi version'),
    lockedRef: capture(locked, /^      resolved-ref: "([a-f0-9]{40})"$/m, 'resolved Kazumi SHA'),
    requestedRef: capture(locked, /^      ref: "([a-f0-9]{40})"$/m, 'locked requested SHA'),
    reportedRef: capture(sources.core, /const upstreamRevision = '([a-f0-9]{40})';/, 'health SHA'),
    sdk: JSON.parse(sources.sdk),
    apiLevel: Number(
      capture(sources.validation, /export const RULE_API_VERSION = (\d+);/, 'rule API level'),
    ),
    sources,
  };
}

export function verifyPins(pins) {
  assert.match(pins.ref, shaPattern);
  assert.equal(pins.lockedRef, pins.ref, 'pubspec.lock does not resolve the pinned Kazumi commit');
  assert.equal(pins.requestedRef, pins.ref, 'pubspec.lock has a stale Git ref');
  assert.equal(pins.reportedRef, pins.ref, 'Core health reports a different Kazumi commit');
  assert.match(pins.sdk.revision, shaPattern);
  compareVersions(pins.sdk.version, pins.sdk.version);
}

export async function github(path, { raw = false } = {}) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `GitHub ${path}: HTTP ${response.status}`);
  return raw ? response.text() : response.json();
}

export async function discoverUpdate(pins, api = github) {
  verifyPins(pins);
  const release = await api(`repos/${upstreamRepository}/releases/latest`);
  assert.equal(release.draft, false, 'Draft releases cannot be upgraded automatically');
  assert.equal(release.prerelease, false, 'Prereleases cannot be upgraded automatically');
  // A local pin can include fixes newer than the current release tag. Never roll it back.
  if (compareVersions(release.tag_name, pins.version) <= 0) {
    return { available: false, currentVersion: pins.version, latestVersion: release.tag_name };
  }
  const { sha } = await api(
    `repos/${upstreamRepository}/commits/${encodeURIComponent(release.tag_name)}`,
  );
  assert.match(sha, shaPattern, 'Release must resolve to an immutable commit');
  const comparison = await api(`repos/${upstreamRepository}/compare/${pins.ref}...${sha}`);
  assert.equal(
    comparison.status,
    'ahead',
    'Release is not a descendant of the current pin; review manually',
  );
  const relevance = await assessRelevance(pins.ref, sha, api, upstreamRepository, comparison);
  if (!relevance.changedPaths.length)
    return {
      available: false,
      source: 'release',
      commit: sha,
      latestVersion: release.tag_name,
      reason: 'No Web-relevant source or dependency changes',
      ...relevance,
    };
  return describeReferenceUpdate(pins, sha, api, {
    source: 'release',
    tag: release.tag_name,
    releaseUrl: `https://github.com/${upstreamRepository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    branch: `codex/kazumi-${sha.slice(0, 12)}`,
    ...relevance,
  });
}

async function describeReferenceUpdate(pins, sha, api, details) {
  const source = (path) =>
    api(`repos/${upstreamRepository}/contents/${path}?ref=${sha}`, { raw: true });
  const [pubspec, endpoints] = await Promise.all([
    source('pubspec.yaml'),
    source('lib/request/config/api_endpoints.dart'),
  ]);
  const version = capture(pubspec, /^version:\s*['"]?([^\s'"\r\n]+)/m, 'release package version');
  if (details.tag)
    assert.equal(
      compareVersions(version, details.tag),
      0,
      'Release tag and package version differ',
    );
  const flutter = capture(
    pubspec,
    /^  flutter:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m,
    'required Flutter version',
  );
  let sdk = pins.sdk;
  if (compareVersions(flutter, pins.sdk.version) > 0) {
    const revision = await api(`repos/flutter/flutter/commits/${flutter}`);
    assert.match(revision.sha, shaPattern, 'Flutter must resolve to an immutable commit');
    sdk = { version: flutter, revision: revision.sha };
  }
  return {
    available: true,
    currentVersion: pins.version,
    previous: pins.ref,
    version,
    commit: sha,
    sdk,
    apiLevel: Number(
      capture(endpoints, /static const int apiLevel = (\d+);/, 'upstream rule API level'),
    ),
    compareUrl: `https://github.com/${upstreamRepository}/compare/${pins.ref}...${sha}`,
    ...details,
  };
}

export async function discoverMainUpdate(pins, api = github) {
  verifyPins(pins);
  const { sha } = await api(`repos/${upstreamRepository}/commits/main`);
  assert.match(sha, shaPattern, 'Main must resolve to an immutable commit');
  if (sha === pins.ref) return { available: false, source: 'main', commit: sha };
  const comparison = await api(`repos/${upstreamRepository}/compare/${pins.ref}...${sha}`);
  assert.equal(comparison.status, 'ahead', 'Main history changed; review manually');
  const relevance = await assessRelevance(pins.ref, sha, api, upstreamRepository, comparison);
  if (!relevance.changedPaths.length)
    return {
      available: false,
      source: 'main',
      commit: sha,
      reason: 'No Web-relevant source or dependency changes',
      ...relevance,
    };
  return describeReferenceUpdate(pins, sha, api, {
    source: 'main',
    ...relevance,
    branch: `codex/kazumi-main-${sha.slice(0, 12)}`,
  });
}

export async function applyUpdate(root, pins, update) {
  assert.equal(update.available, true);
  assert.match(update.commit, shaPattern);
  const changes = {
    pubspec: pins.sources.pubspec.replace(`ref: ${pins.ref}`, `ref: ${update.commit}`),
    core: pins.sources.core.replace(
      `upstreamRevision = '${pins.ref}'`,
      `upstreamRevision = '${update.commit}'`,
    ),
    sdk: `${JSON.stringify(update.sdk, null, 2)}\n`,
    validation: pins.sources.validation.replace(
      /RULE_API_VERSION = \d+;/,
      `RULE_API_VERSION = ${update.apiLevel};`,
    ),
  };
  // pubspec.lock is regenerated by the pinned Flutter toolchain, never fabricated here.
  for (const [key, content] of Object.entries(changes))
    await writeFile(join(root, files[key]), content);
}

export function upgradeBody(update) {
  const labels = (keys) => keys.map((key) => webAreas[key].label).join('、');
  const lines = [
    `同步官方${update.source === 'main' ? ' main' : '稳定版'}的 Web 相关变更：${labels(update.areas)}。`,
    '',
    `本 PR 只更新开发测试使用的官方参考核心、真实锁文件及必要的 Flutter/API 对照配置。线上 Node 引擎、Web 播放器和用户规则不会因此直接改变；需要移植的修复由维护者核查后实现，不能把参考升级当成已修复线上问题。`,
    '',
    '### 具体变化',
    '',
    `- 官方提交：${update.previous.slice(0, 12)} → ${update.commit.slice(0, 12)}（[完整差异](${update.compareUrl})）`,
    `- 官方包版本：${markdown(update.currentVersion)} → ${markdown(update.version)}${update.currentVersion === update.version ? '（版本号未变，按提交跟进）' : ''}`,
    `- Flutter：${update.sdk.version}（${update.sdk.revision}）；参考规则 API：${update.apiLevel}。本地 API 等级不会自动提高。`,
  ];
  if (update.releaseUrl) lines.push(`- [官方发布说明](${update.releaseUrl})`);
  if (update.upstreamCommits.length) {
    lines.push(
      '',
      `上游提交摘要（展示 ${update.upstreamCommits.length}/${update.totalCommits}，具体范围以文件差异为准）：`,
      '',
    );
    for (const item of update.upstreamCommits)
      lines.push(
        `- [${item.sha.slice(0, 12)}](https://github.com/${upstreamRepository}/commit/${item.sha}) ${markdown(item.title)}`,
      );
  }
  if (update.sourceChanges.length) {
    lines.push('', '相关源码：', '', '| 文件 | 变化 | 关联能力 |', '| --- | --- | --- |');
    const status = { added: '新增', modified: '修改', removed: '删除' };
    for (const item of update.sourceChanges) {
      const ref = item.status === 'removed' ? update.previous : update.commit;
      lines.push(
        `| [${markdown(item.path)}](https://github.com/${upstreamRepository}/blob/${ref}/${item.path.split('/').map(encodeURIComponent).join('/')}) | ${status[item.status]} | ${labels(item.areas)} |`,
      );
    }
    const excerpts = update.sourceChanges.filter(({ excerpt }) => excerpt).slice(0, 6);
    if (excerpts.length) {
      lines.push(
        '',
        '上游差异摘录（最多 6 个文件、每文件 12 行；以完整 diff 为准，尚未验证行为影响）：',
      );
      for (const { path, excerpt } of excerpts) {
        const fence = '~'.repeat(
          Math.max(3, ...[...excerpt.matchAll(/~+/g)].map(([run]) => run.length + 1)),
        );
        lines.push('', markdown(path), '', `${fence}diff`, excerpt, fence);
      }
    }
    if (update.sourceChanges.some(({ excerpt }) => !excerpt))
      lines.push(
        '',
        '部分文件没有可用的 compare 差异片段（例如超出 GitHub 文件上限），仍按完整 Git 树纳入审查，请打开源码和完整差异确认。',
      );
  }
  lines.push('', '相关依赖（约束、覆盖配置和锁定来源/版本/SHA 的实际差异）：', '');
  if (!update.dependencyChanges.length) lines.push('无 Web 相关依赖变化。');
  for (const item of update.dependencyChanges) {
    lines.push(`- **${markdown(item.name)}**（${labels(item.areas)}）`);
    for (const field of item.fields)
      lines.push(
        `  - ${markdown(field.field)}：${field.before === null ? '未设置' : markdown(field.before)} → ${field.after === null ? '移除' : markdown(field.after)}`,
      );
  }
  lines.push(
    '',
    '### 实际影响与审查重点',
    '',
    '以下是由变更路径/依赖用途判定的待核查行为，尚不代表已验证的功能改善：',
    '',
  );
  for (const key of update.areas)
    lines.push(`- **${webAreas[key].label}**：${webAreas[key].impact}`);
  lines.push(
    '',
    `已过滤 ${update.ignoredPaths.length} 个非相关文件；未纳入 Web 依赖策略的变化：${update.ignoredDependencies.map(markdown).join('、') || '无'}。完整清单见检查工作流摘要。`,
    '',
    '### 验证和合并',
    '',
    '- 用固定 Flutter 工具链生成真实锁文件，显式派发 Verify 和 Official rule compatibility；覆盖规则请求、动态播放与验证码。',
    '- 对照上游代码补充固定响应或浏览器样本，必要时移植修复；确认两边行为一致后再显式运行 compare:engines -- --record 并审查 golden。',
    '- 两项 CI 通过且维护者审查后才能合并。No automatic merging.',
  );
  return `${lines.join('\n')}\n`;
}

export function upgradeTitle(update) {
  const areas = update.areas.map((key) => webAreas[key].label).join('、');
  return `chore(core): 跟进${update.source === 'main' ? '上游 main' : ` Kazumi ${update.version}`}的${areas}变更`;
}
