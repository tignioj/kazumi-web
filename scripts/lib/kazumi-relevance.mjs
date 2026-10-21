import assert from 'node:assert/strict';

// Keep this policy about behavior shared with the Web engine. Native playback,
// rendering, themes and development tools do not qualify just by changing pubspec.
export const webAreas = {
  rules: {
    label: '规则引擎',
    paths:
      /^(?:lib\/(?:plugins\/|services\/plugin\/|modules\/plugin\/|modules\/roads\/|modules\/search\/plugin_search_module\.dart|request\/config\/api_endpoints\.dart)|test\/(?:api_)?rule_engine|test\/plugin)/,
    dependencies:
      /^(?:xpath_selector|xpath_selector_html_parser|html|csslib|json_path|rfc_6901|iregexp|expressions|petitparser|xml|antlr4)$/,
    impact: '核对规则导入、XPath/JSON 提取、请求模板及搜索和剧集结果，补充对应固定响应样本。',
  },
  network: {
    label: '网络',
    paths: /^lib\/(?:request\/|services\/network\/)/,
    dependencies:
      /^(?:dio(?:_web_adapter|_http2_adapter|_cookie_manager)?|cookie_jar|http|http_parser|mime|crypto|ech_http|connectivity_plus(?:_platform_interface)?|web_socket(?:_channel)?)$/,
    impact:
      '核对请求头、Cookie、代理/ECH、重定向、错误与超时行为；依赖版本变化本身不证明已有兼容性修复。',
  },
  video: {
    label: '视频解析',
    paths:
      /^(?:lib\/(?:services\/video_source\/|webview\/video\/|services\/platform\/webview_feature_service\.dart)|test\/video_source)/,
    dependencies:
      /^(?:flutter_inappwebview(?:_\w+)?|webview_flutter(?:_\w+)?|webview_windows|desktop_webview_window)$/,
    impact:
      '对照动态播放页面的脚本执行、请求嗅探、视频 URL/请求头提取及解析任务并发；不把原生播放器控件当成 Web 功能。',
  },
  captcha: {
    label: '验证码',
    paths:
      /^(?:lib\/webview\/captcha\/|test\/captcha)|^lib\/(?:services\/plugin\/captcha|plugins\/anti_crawler|services\/platform\/webview_feature_service\.dart)/,
    dependencies:
      /^(?:flutter_inappwebview(?:_\w+)?|webview_flutter(?:_\w+)?|webview_windows|desktop_webview_window)$/,
    impact:
      '对照图片、按钮与自定义脚本验证，以及验证后 Cookie、User-Agent 和 HTML 回传、取消与资源释放。',
  },
};

const sharedHelpers =
  /^lib\/utils\/(?:episode_url|encoding|http_headers|crypto|constants|async_serial_queue|async_single_flight|async_rate_limiter|media|m3u8_parser|m3u8_ad_filter)\.dart$/;
const sharedDependencies =
  /^(?:async|collection|convert|typed_data|string_scanner|source_span|synchronized|web|ffi|plugin_platform_interface|stream_channel|stream_transform)$/;
const manifests = ['pubspec.yaml', 'pubspec.lock'];

// constants.dart mixes network headers with native themes and controls. Only
// its header declarations belong to this monitor; don't alert on slider styles.
function headerConstants(text) {
  return ['userAgentsList', 'acceptLanguageList', 'bangumiHTTPHeader'].map((name) => {
    const value = new RegExp(`\\b${name}\\s*=\\s*([\\[{][\\s\\S]*?[\\]}]);`).exec(text)?.[1];
    assert.ok(
      value || !new RegExp(`\\b${name}\\s*=`).test(text),
      'Unsupported header constant declaration; review manually',
    );
    return value ?? null;
  });
}

// pubspec and Pub's generated lockfile use block mappings. Read just those
// mappings, preserving constraints, sources, hashes and Git revisions. Fail on
// unsupported YAML instead of silently treating an unreadable dependency as UI.
function scalar(value) {
  const clean = value.replace(/\s+#.*$/, '').trim();
  if (clean.startsWith('"')) return JSON.parse(clean);
  if (clean.startsWith("'")) {
    assert.ok(clean.endsWith("'"), 'Unclosed pubspec scalar');
    return clean.slice(1, -1).replaceAll("''", "'");
  }
  assert.ok(!/^[&*!\[\]{}>|]/.test(clean), 'Unsupported pubspec YAML; review manually');
  return clean;
}

function packages(text, section, lock = false) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${section}:\\s*(?:#.*)?$`).test(line));
  if (start < 0) {
    assert.ok(
      !lines.some((line) => line.startsWith(`${section}:`)),
      'Unsupported pubspec YAML section; review manually',
    );
    assert.ok(!lock, 'Cannot read upstream lockfile packages');
    return new Map();
  }
  const result = new Map();
  let fields;
  const parents = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const item = /^( +)([\w-]+):(?:\s+(.*))?$/.exec(line.replace(/\s+#.*$/, '').trimEnd());
    assert.ok(item, 'Unsupported pubspec mapping; review manually');
    const [, spaces, key, value = ''] = item;
    const depth = spaces.length;
    if (depth === 2) {
      assert.ok(!result.has(key), `Duplicate dependency: ${key}`);
      fields = {};
      result.set(key, fields);
      parents.length = 0;
      if (value) fields.constraint = scalar(value);
    } else {
      assert.ok(fields && depth >= 4 && depth % 2 === 0, 'Invalid dependency indentation');
      while (parents.length && parents.at(-1).depth >= depth) parents.pop();
      const field = [...parents.map((parent) => parent.key), key].join('.');
      // direct/transitive labels describe the resolver, not a behavior change.
      if (value && !(lock && field === 'dependency')) {
        assert.ok(!Object.hasOwn(fields, field), `Duplicate dependency field: ${field}`);
        fields[field] = scalar(value);
      }
      if (!value) parents.push({ depth, key });
    }
  }
  return result;
}

function dependencySnapshot(pubspec, lock) {
  const result = new Map();
  for (const [kind, values] of [
    ['constraint', packages(pubspec, 'dependencies')],
    ['override', packages(pubspec, 'dependency_overrides')],
    ['lock', packages(lock, 'packages', true)],
  ]) {
    for (const [name, fields] of values) {
      const entry = result.get(name) || {};
      for (const [field, value] of Object.entries(fields)) entry[`${kind}.${field}`] = value;
      result.set(name, entry);
    }
  }
  return result;
}

export function dependencyChanges(before, after) {
  const snapshots = [before, after].map(({ pubspec, lock }) => dependencySnapshot(pubspec, lock));
  return [...new Set(snapshots.flatMap((snapshot) => [...snapshot.keys()]))]
    .sort()
    .flatMap((name) => {
      const [old, next] = snapshots.map((snapshot) => snapshot.get(name) || {});
      const fields = [...new Set([...Object.keys(old), ...Object.keys(next)])]
        .sort()
        .filter((field) => old[field] !== next[field])
        .map((field) => ({ field, before: old[field] ?? null, after: next[field] ?? null }));
      if (!fields.length) return [];
      const areas = Object.keys(webAreas).filter(
        (key) => sharedDependencies.test(name) || webAreas[key].dependencies.test(name),
      );
      return [{ name, fields, areas }];
    });
}

export async function assessRelevance(previous, commit, api, repository, comparison) {
  const trees = await Promise.all(
    [previous, commit].map((ref) => api(`repos/${repository}/git/trees/${ref}?recursive=1`)),
  );
  for (const tree of trees) assert.equal(tree.truncated, false, 'Incomplete upstream tree');
  const entries = trees.map(
    ({ tree }) =>
      new Map(tree.filter((item) => item.type === 'blob').map((item) => [item.path, item.sha])),
  );
  // Full trees include deletions and changes beyond GitHub compare's 300-file cap.
  const changed = [...new Set(entries.flatMap((entry) => [...entry.keys()]))]
    .filter((path) => entries[0].get(path) !== entries[1].get(path))
    .sort();
  const constants = 'lib/utils/constants.dart';
  let headersChanged = true;
  if (changed.includes(constants)) {
    const texts = await Promise.all(
      [previous, commit].map((ref, index) =>
        entries[index].has(constants)
          ? api(`repos/${repository}/contents/${constants}?ref=${ref}`, { raw: true })
          : '',
      ),
    );
    headersChanged =
      JSON.stringify(headerConstants(texts[0])) !== JSON.stringify(headerConstants(texts[1]));
  }
  const sourceChanges = changed.flatMap((path) => {
    if (!path.endsWith('.dart')) return [];
    if (path === constants && !headersChanged) return [];
    const areas = Object.keys(webAreas).filter(
      (key) => webAreas[key].paths.test(path) || sharedHelpers.test(path),
    );
    if (!areas.length) return [];
    const patch = comparison.files?.find(({ filename }) => filename === path)?.patch;
    const excerpt = patch
      ?.split('\n')
      .filter((line) => /^[+-](?![+-]{2})/.test(line))
      .slice(0, 12)
      .join('\n');
    return [
      {
        path,
        areas,
        status: !entries[0].has(path) ? 'added' : !entries[1].has(path) ? 'removed' : 'modified',
        ...(excerpt ? { excerpt } : {}),
      },
    ];
  });
  let dependencies = [];
  if (manifests.some((path) => changed.includes(path))) {
    const snapshots = await Promise.all(
      [previous, commit].map(async (ref) => {
        const [pubspec, lock] = await Promise.all(
          manifests.map((path) =>
            api(`repos/${repository}/contents/${path}?ref=${ref}`, { raw: true }),
          ),
        );
        return { pubspec, lock };
      }),
    );
    dependencies = dependencyChanges(...snapshots);
  }
  const relevantDependencies = dependencies.filter(({ areas }) => areas.length);
  const changedPaths = sourceChanges.map(({ path }) => path);
  if (relevantDependencies.length)
    changedPaths.push(...manifests.filter((path) => changed.includes(path)));
  return {
    changedPaths: changedPaths.sort(),
    sourceChanges,
    dependencyChanges: relevantDependencies,
    ignoredDependencies: dependencies.filter(({ areas }) => !areas.length).map(({ name }) => name),
    ignoredPaths: changed.filter((path) => !changedPaths.includes(path)),
    areas: Object.keys(webAreas).filter((key) =>
      [...sourceChanges, ...relevantDependencies].some(({ areas }) => areas.includes(key)),
    ),
    upstreamCommits: (comparison.commits || []).slice(0, 10).map(({ sha, commit: info }) => ({
      sha,
      title: info.message.split(/\r?\n/)[0],
    })),
    totalCommits: comparison.total_commits ?? comparison.commits?.length ?? 0,
  };
}

export function markdown(value) {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('@', '&#64;')
    .replace(/[\\`*_{}[\]()<>|]/g, '\\$&');
}
