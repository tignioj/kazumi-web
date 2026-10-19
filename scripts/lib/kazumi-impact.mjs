import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const modules = [
  {
    id: 'captcha',
    name: '验证码',
    paths: ['lib/webview/captcha/', 'lib/services/plugin/captcha_verification_service.dart'],
    review: '核对验证码控制器、交互操作和 Cookie 回传',
  },
  {
    id: 'rules',
    name: '规则引擎与解析策略',
    paths: ['lib/services/plugin/'],
    review: '核对 RuleEngine、请求配置、搜索与剧集返回结构及 Cookie 行为',
  },
  {
    id: 'config',
    name: '规则模型与导入配置',
    paths: ['lib/plugins/', 'lib/modules/search/plugin_search_module.dart'],
    review: '核对规则字段、导入格式及搜索结果模型',
  },
  {
    id: 'sources',
    name: '视频解析与解析器池',
    paths: ['lib/services/video_source/'],
    review: '核对解析结果、媒体格式、超时和取消流程',
  },
  {
    id: 'webview',
    name: '视频 WebView',
    paths: ['lib/webview/video/'],
    review: '核对 Linux WebView、媒体嗅探、请求头和生命周期',
  },
  {
    id: 'network',
    name: '网络与代理',
    paths: [
      'lib/request/core/',
      'lib/request/clients/plugin_site_client.dart',
      'lib/services/network/',
    ],
    review: '核对 Dio、代理、TLS、错误映射及请求行为',
  },
  {
    id: 'storage',
    name: '存储与初始化',
    paths: ['lib/services/storage/'],
    review: '核对 GStorage、设置键、初始化和数据格式',
  },
  {
    id: 'protocol',
    name: '规则协议与 API 等级',
    paths: ['lib/request/config/api_endpoints.dart'],
    review: '核对规则 API 等级及兼容性声明',
  },
  {
    id: 'runtime',
    name: 'Flutter、依赖与 Linux 构建',
    paths: ['pubspec.yaml', 'pubspec.lock', 'linux/'],
    review: '核对 SDK、依赖约束、原生插件和 Linux 构建要求',
  },
  {
    id: 'other',
    name: '其他直接引用',
    paths: [],
    review: '核对新增引用的上游接口，并补充模块监控范围',
  },
];

export async function readCoreImports(directory) {
  const paths = new Set();
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.dart')) {
        const source = await readFile(child, 'utf8');
        for (const match of source.matchAll(
          /\b(?:import|export|part)\s+['"]package:kazumi\/([^'"]+)['"]/g,
        )) {
          paths.add(`lib/${match[1]}`);
        }
      }
    }
  }
  await visit(directory);
  return [...paths].sort();
}

function moduleFor(path, imports) {
  return (
    modules.find((module) =>
      module.paths.some((scope) => (scope.endsWith('/') ? path.startsWith(scope) : path === scope)),
    ) || (imports.has(path) ? modules.at(-1) : null)
  );
}

// Compare's files list is capped at 300. Tree hashes recover the entire range
// without mistaking a truncated list for unchanged core modules.
async function changedFiles(comparison, previous, commit, api, repository) {
  if (!Array.isArray(comparison.files)) throw new Error('GitHub 未返回变更文件列表');
  if (comparison.files.length < 300) return comparison.files;
  const trees = await Promise.all(
    [previous, commit].map((sha) => api(`repos/${repository}/git/trees/${sha}?recursive=1`)),
  );
  if (trees.some((tree) => tree.truncated || !Array.isArray(tree.tree)))
    throw new Error('GitHub 文件树不完整，无法排除遗漏的核心变更');
  const [before, after] = trees.map(
    (tree) =>
      new Map(tree.tree.filter((file) => file.type !== 'tree').map((file) => [file.path, file])),
  );
  const known = new Map(comparison.files.map((file) => [file.filename, file]));
  const renamed = new Set(
    comparison.files
      .filter((file) => file.status === 'renamed' && !after.has(file.previous_filename))
      .map((file) => file.previous_filename),
  );
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    if (renamed.has(path)) return [];
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (oldFile?.sha === newFile?.sha && oldFile?.mode === newFile?.mode) return [];
    return [
      known.get(path) || {
        filename: path,
        status: !oldFile ? 'added' : !newFile ? 'removed' : 'modified',
      },
    ];
  });
}

function declarationHints(patch = '') {
  const names = new Set();
  for (const line of patch.split('\n')) {
    if (!/^[+-](?![+-])/.test(line)) continue;
    const source = line.slice(1).trim();
    const type =
      /^(?:(?:abstract|base|final|sealed|interface)\s+)*(?:class|enum|mixin|typedef|extension(?:\s+type)?)\s+(\w+)/.exec(
        source,
      );
    const parameter = /^(?:required\s+)?(?:this|super)\.(\w+)/.exec(source);
    // These are navigation hints, not a Dart API compatibility parser.
    const method = /^(?:return|await|throw)\b/.test(source)
      ? null
      : /^(?:(?:static|external|factory)\s+)*(?:[\w<>?,\[\]]+\s+)+(\w+)\s*\(/.exec(source);
    const field =
      /^(?:(?:static|late|final|const|required|covariant)\s+)*(?:[\w<>?,\[\]]+\s+)(\w+)\s*(?:=|;|,)/.exec(
        source,
      );
    const enumValue = /^(\w+)\s*,(?:\s*\/\/.*)?$/.exec(source);
    const name = type?.[1] || parameter?.[1] || method?.[1] || field?.[1] || enumValue?.[1];
    if (
      name &&
      ![
        'if',
        'for',
        'while',
        'switch',
        'return',
        'await',
        'throw',
        'null',
        'true',
        'false',
      ].includes(name)
    )
      names.add(name);
  }
  return [...names].sort().slice(0, 8);
}

function versionMetadataOnly(file) {
  if (
    file.filename !== 'pubspec.yaml' ||
    file.status !== 'modified' ||
    file.previous_filename ||
    !file.patch
  )
    return false;
  const changed = file.patch.split('\n').filter((line) => /^[+-](?![+-])/.test(line));
  return changed.length > 0 && changed.every((line) => /^[+-](?:version:|\s*$)/.test(line));
}

export async function analyzeCoreImpact({ pins, update, comparison, api, repository }) {
  const imports = new Set(pins.directImports || []);
  const report = {
    complete: true,
    notices: [],
    modules: modules.map((module) => ({
      ...module,
      imports: [...imports].filter((path) => moduleFor(path, imports)?.id === module.id),
      files: [],
    })),
    apiChange: pins.apiLevel !== update.apiLevel ? `${pins.apiLevel} → ${update.apiLevel}` : null,
    sdkChange:
      pins.sdk.revision !== update.sdk.revision || pins.sdk.version !== update.sdk.version
        ? `${pins.sdk.version} → ${update.sdk.version}（SDK 提交有变更）`
        : null,
    otherFiles: 0,
    metadataFiles: 0,
  };
  try {
    const files = await changedFiles(comparison, pins.ref, update.commit, api, repository);
    for (const file of files) {
      if (versionMetadataOnly(file)) {
        report.metadataFiles++;
        continue;
      }
      const paths = [file.previous_filename, file.filename].filter(Boolean);
      const group = paths.map((path) => moduleFor(path, imports)).find(Boolean);
      if (!group) {
        report.otherFiles++;
        continue;
      }
      report.modules
        .find((module) => module.id === group.id)
        .files.push({
          filename: file.filename,
          previousFilename: file.previous_filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          direct: paths.some((path) => imports.has(path)),
          symbols: declarationHints(file.patch),
        });
    }
  } catch (error) {
    report.complete = false;
    report.notices.push(error.message);
  }
  if (imports.size === 0) {
    report.complete = false;
    report.notices.push('未识别到适配层的 Kazumi 直接引用，需人工核对监控范围');
  }
  const affected = report.modules.flatMap((module) => module.files);
  report.level = !report.complete
    ? 'unknown'
    : report.apiChange ||
        report.sdkChange ||
        affected.some((file) => file.direct || ['removed', 'renamed'].includes(file.status))
      ? 'adaptation'
      : affected.length
        ? 'regression'
        : 'low';
  return report;
}

function markdown(value) {
  return String(value)
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\`*_{}\[\]()<>|]/g, '\\$&');
}

export function renderCoreImpact(report, compareUrl) {
  if (!report) return '## 核心模块变更与适配提示\n\n**分析不可用，需人工核查完整上游差异。**\n';
  const labels = {
    unknown: '分析不完整，需人工核查；不能据此判断无需适配。',
    adaptation: '可能需要适配：直接引用、文件路径、规则协议或 SDK 有变化。',
    regression: '相关实现有变化，需重点回归；尚不能仅凭文件变更认定需要修改适配代码。',
    low: '监控范围内未发现核心变更，通常只需更新固定提交并通过 CI。',
  };
  const lines = ['## 核心模块变更与适配提示', '', `**初步判断：${labels[report.level]}**`, ''];
  if (report.apiChange) lines.push(`- 规则 API 等级：${markdown(report.apiChange)}。`);
  if (report.sdkChange) lines.push(`- Flutter SDK：${markdown(report.sdkChange)}。`);
  for (const notice of report.notices) lines.push(`- 分析提示：${markdown(notice)}。`);
  lines.push(
    '',
    '| 模块 | 直接引用文件数 | 变更文件数 | 审核重点 |',
    '| --- | ---: | ---: | --- |',
  );
  for (const module of report.modules) {
    if (module.id === 'other' && !module.imports.length && !module.files.length) continue;
    const direct = module.files.filter((file) => file.direct).length;
    const status = !report.complete
      ? '分析不完整'
      : !module.files.length
        ? '未发现文件变更'
        : `${direct ? `直接引用 ${direct} 个文件有变更；` : '相关实现有变更；'}${module.review}`;
    lines.push(
      `| ${module.name} | ${module.imports.length} | ${module.files.length} | ${status} |`,
    );
  }
  lines.push('', '### 变更文件与差异链接', '');
  const affected = report.modules
    .flatMap((module) => module.files.map((file) => ({ ...file, module: module.name })))
    .sort(
      (left, right) =>
        Number(right.direct) - Number(left.direct) ||
        Number(['removed', 'renamed'].includes(right.status)) -
          Number(['removed', 'renamed'].includes(left.status)),
    );
  const statuses = {
    added: '新增',
    modified: '修改',
    removed: '删除',
    renamed: '重命名',
    changed: '变更',
  };
  let listed = 0;
  let length = lines.join('\n').length;
  for (const file of affected) {
    if (listed >= 60) break;
    const anchor = createHash('sha256').update(file.filename).digest('hex');
    const name = file.previousFilename
      ? `${file.previousFilename} → ${file.filename}`
      : file.filename;
    const stats =
      Number.isInteger(file.additions) && Number.isInteger(file.deletions)
        ? `，+${file.additions}/−${file.deletions}`
        : '';
    const hints = file.symbols.length
      ? `；声明/参数线索：${file.symbols.map(markdown).join('、')}`
      : '';
    const line = `- **${file.module}**：[${markdown(name)}](${compareUrl}#diff-${anchor})（${statuses[file.status] || '变更'}${stats}；${file.direct ? '适配层直接引用' : '模块内相关实现'}${hints}）。`;
    if (length + line.length > 45000) break;
    lines.push(line);
    length += line.length;
    listed++;
  }
  if (!affected.length)
    lines.push(
      report.complete ? '监控范围内未发现变更文件。' : '无法确认完整变更文件列表，请核查完整差异。',
    );
  if (listed < affected.length)
    lines.push(
      `仅展开前 ${listed} 个文件，其余 ${affected.length - listed} 个文件请查看[完整上游差异](${compareUrl})；表格计数和初步判断包含全部已识别变更。`,
    );
  lines.push(
    '',
    `另有 ${report.otherFiles} 个文件不在上述监控范围，${report.metadataFiles} 个文件仅修改发布版本号。`,
    '',
    '直接引用从 services/kazumi-core/lib 下的 Dart 文件自动扫描；相关实现按上述模块目录监控，不是完整的传递依赖或 Dart 语义分析。声明/参数线索仅供定位，缺少线索不代表接口未变。仍需审阅差异并等待真实核心 CI 通过。',
    '',
  );
  return lines.join('\n');
}
