import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, checkedUrl } from '../../lib/http.js';

export const RULE_API_VERSION = 9;

export function normalizeRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError('每条规则必须是 JSON 对象');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
    throw new HttpError('规则名称不能为空且不能超过 100 个字符');
  if (
    !['string', 'number'].includes(typeof (input.api ?? 1)) ||
    !Number.isInteger(Number(input.api ?? 1)) ||
    Number(input.api ?? 1) < 1 ||
    Number(input.api ?? 1) > RULE_API_VERSION
  )
    throw new HttpError(`规则 API 版本不受支持（最高 ${RULE_API_VERSION}）`);
  const rule = {
    api: '1',
    type: 'anime',
    version: '',
    searchMode: 'xpath',
    chapterMode: 'xpath',
    ...input,
    name: input.name.trim(),
    enabled: input.enabled !== false,
  };
  rule.api = String(input.api ?? 1);
  if (rule.version == null) rule.version = '';
  else if (typeof rule.version === 'number' && Number.isFinite(rule.version))
    rule.version = String(rule.version);
  if (typeof rule.version !== 'string' || rule.version.length > 100)
    throw new HttpError('version 必须是文本或有限数字，长度不能超过 100 个字符');
  for (const field of ['type', 'author']) {
    if (rule[field] != null && typeof rule[field] !== 'string')
      throw new HttpError(`${field} 必须是文本`);
  }
  rule.type ??= 'anime';
  rule.author ??= '';
  if (typeof rule.baseURL !== 'string') throw new HttpError('规则缺少 baseURL');
  checkedUrl(rule.baseURL, { allowPrivate: true });
  for (const field of ['searchMode', 'chapterMode'])
    if (!['xpath', 'api'].includes(rule[field]))
      throw new HttpError(`${field} 必须是 xpath 或 api`);
  for (const field of [
    'searchURL',
    'searchList',
    'searchName',
    'searchResult',
    'chapterRoads',
    'chapterResult',
    'referer',
    'userAgent',
  ]) {
    if (rule[field] !== undefined && typeof rule[field] !== 'string')
      throw new HttpError(`${field} 必须是文本`);
  }
  return rule;
}

function decodeShare(value) {
  const payload = decodeURIComponent(value.replace(/^kazumi:(?:\/\/)?/i, '')).replace(/\s/g, '');
  if (!payload || !/^[A-Za-z0-9+/_=-]+$/.test(payload)) throw new HttpError('kazumi 分享链接无效');
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    throw new HttpError('kazumi 分享链接内容无效');
  }
}

export function parseImport(content) {
  let value = content;
  if (typeof content === 'string') {
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new HttpError('导入内容过大');
    try {
      value = JSON.parse(content);
    } catch {
      const markers = [...content.matchAll(/kazumi:(?:\/\/)?/gi)];
      if (!markers.length) throw new HttpError('请输入规则 JSON 或 kazumi:// 分享链接');
      value = markers.map((marker, index) => {
        const segment = content.slice(marker.index + marker[0].length, markers[index + 1]?.index);
        let payload = /^[A-Za-z0-9+/_=%\-\s]+/.exec(segment)?.[0]?.trim() || '';
        // Chat apps wrap Base64. Try the full wrapped value first, then shorten
        // at whitespace boundaries if ordinary prose followed the link.
        for (;;) {
          try {
            return decodeShare(`kazumi://${payload}`);
          } catch (error) {
            const whitespace = [...payload.matchAll(/\s+/g)].at(-1);
            if (!whitespace) throw error;
            payload = payload.slice(0, whitespace.index).trimEnd();
          }
        }
      });
    }
  }
  const items = Array.isArray(value) ? value : [value];
  if (!items.length || items.length > 500) throw new HttpError('一次导入 1 至 500 条规则');
  const rules = new Map();
  for (const item of items) {
    const rule = normalizeRule(typeof item === 'string' ? decodeShare(item) : item);
    rules.set(rule.name.toLowerCase(), rule);
  }
  return [...rules.values()];
}

export class RuleStore {
  constructor(directory, initialRules = []) {
    this.directory = directory;
    this.file = join(directory, 'rules.json');
    this.rules = [];
    this.initialRules = initialRules;
    this.pending = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      this.rules = Array.isArray(value) && value.length === 0 ? [] : parseImport(value);
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(`无法读取规则数据文件 ${this.file}: ${error.message}`);
      if (this.initialRules.length) await this.import(this.initialRules);
    }
    return this;
  }
  list() {
    return structuredClone(this.rules);
  }
  get(name) {
    const rule = this.rules.find((rule) => rule.name.toLowerCase() === String(name).toLowerCase());
    if (!rule) throw new HttpError('找不到指定规则', 404);
    return structuredClone(rule);
  }
  update(transform) {
    const operation = this.pending.then(async () => {
      const next = transform(this.list());
      if (next.length > 500) throw new HttpError('最多保存 500 条规则');
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
      this.rules = next;
      return this.list();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  import(content) {
    const incoming = parseImport(content);
    return this.update((existing) => {
      const map = new Map(existing.map((rule) => [rule.name.toLowerCase(), rule]));
      for (const rule of incoming) map.set(rule.name.toLowerCase(), rule);
      return [...map.values()];
    });
  }
  replace(name, input) {
    const replacement = normalizeRule(input);
    return this.update((rules) => {
      const index = rules.findIndex((rule) => rule.name.toLowerCase() === name.toLowerCase());
      if (index < 0) throw new HttpError('找不到指定规则', 404);
      if (
        rules.some(
          (rule, i) => i !== index && rule.name.toLowerCase() === replacement.name.toLowerCase(),
        )
      )
        throw new HttpError('规则名称已存在', 409);
      rules[index] = replacement;
      return rules;
    });
  }
  remove(name) {
    return this.update((rules) =>
      rules.filter((rule) => rule.name.toLowerCase() !== name.toLowerCase()),
    );
  }
}
