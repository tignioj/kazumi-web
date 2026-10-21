import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const upstreamRepository = 'Predidit/Kazumi';
export const watchedPaths = [
  'lib/plugins/',
  'lib/services/plugin/',
  'lib/modules/plugin/',
  'lib/services/network/',
  'lib/services/video_source/',
  'lib/webview/',
  'lib/request/',
  'lib/utils/',
  'test/rule_engine_test.dart',
  'test/api_rule_engine_test.dart',
  'test/plugin',
  'test/video_source',
  'test/captcha',
  'pubspec.yaml',
  'pubspec.lock',
];
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
  return describeReferenceUpdate(pins, sha, api, {
    source: 'release',
    tag: release.tag_name,
    releaseUrl: `https://github.com/${upstreamRepository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    branch: `codex/kazumi-${sha.slice(0, 12)}`,
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
  // Compare full trees: the compare API only returns up to 300 changed files.
  const trees = await Promise.all(
    [pins.ref, sha].map((ref) => api(`repos/${upstreamRepository}/git/trees/${ref}?recursive=1`)),
  );
  for (const tree of trees) assert.equal(tree.truncated, false, 'Incomplete upstream tree');
  const entries = trees.map(
    ({ tree }) =>
      new Map(tree.filter((item) => item.type === 'blob').map((item) => [item.path, item.sha])),
  );
  const changedPaths = [...new Set([...entries[0].keys(), ...entries[1].keys()])]
    .filter((path) => entries[0].get(path) !== entries[1].get(path))
    .filter((path) => watchedPaths.some((watched) => path.startsWith(watched)))
    .sort();
  if (!changedPaths.length) return { available: false, source: 'main', commit: sha };
  return describeReferenceUpdate(pins, sha, api, {
    source: 'main',
    changedPaths,
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
  return (
    `Upgrade the development Kazumi reference from ${update.currentVersion} to ${update.version}` +
    (update.source === 'main' ? ' to review changes on upstream main.\n\n' : '.\n\n') +
    (update.releaseUrl ? `- Official release: ${update.releaseUrl}\n` : '') +
    `- Changes: ${update.compareUrl}\n` +
    `- Pinned commit: \`${update.commit}\`\n` +
    `- Flutter: ${update.sdk.version} (\`${update.sdk.revision}\`)\n` +
    `- Rule API: ${update.apiLevel}\n\n` +
    `The lockfile is resolved with the pinned Flutter toolchain. Official rule compatibility is dispatched explicitly ` +
    `on this branch to compare rule requests, dynamic playback and captcha flows with the real core.\n\n` +
    (update.changedPaths
      ? `Changed watched files:\n${update.changedPaths.map((path) => `- \`${path}\``).join('\n')}\n\n`
      : '') +
    `Review upstream changes, add fixtures for new behavior, and port relevant fixes to the local engine. ` +
    `Run compare:engines -- --record against this reference after resolving differences, and commit the reviewed golden corpus. ` +
    `The local API level is not raised automatically. Merge only after Verify and Official rule compatibility pass and a maintainer reviews this PR. No automatic merging.\n`
  );
}
