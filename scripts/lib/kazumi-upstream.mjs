import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  const source = (path) =>
    api(`repos/${upstreamRepository}/contents/${path}?ref=${sha}`, { raw: true });
  const [pubspec, endpoints] = await Promise.all([
    source('pubspec.yaml'),
    source('lib/request/config/api_endpoints.dart'),
  ]);
  const version = capture(pubspec, /^version:\s*['"]?([^\s'"\r\n]+)/m, 'release package version');
  assert.equal(
    compareVersions(version, release.tag_name),
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
    tag: release.tag_name,
    commit: sha,
    sdk,
    apiLevel: Number(
      capture(endpoints, /static const int apiLevel = (\d+);/, 'upstream rule API level'),
    ),
    branch: `codex/kazumi-${sha.slice(0, 12)}`,
    releaseUrl: `https://github.com/${upstreamRepository}/releases/tag/${encodeURIComponent(release.tag_name)}`,
    compareUrl: `https://github.com/${upstreamRepository}/compare/${pins.ref}...${sha}`,
  };
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
    `Upgrade the development Kazumi reference from ${update.currentVersion} to ${update.version}.\n\n` +
    `- Official release: ${update.releaseUrl}\n` +
    `- Changes: ${update.compareUrl}\n` +
    `- Pinned commit: \`${update.commit}\`\n` +
    `- Flutter: ${update.sdk.version} (\`${update.sdk.revision}\`)\n` +
    `- Rule API: ${update.apiLevel}\n\n` +
    `The lockfile is resolved with the pinned Flutter toolchain. Official rule compatibility is dispatched explicitly ` +
    `on this branch to build and start the real core, check its revision, and run the browser suite. ` +
    `Review and merge only after Official rule compatibility passes; this PR does not enable automatic merging.\n`
  );
}
