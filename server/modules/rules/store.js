import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/http.js';
import { normalizeRule } from './validation.js';
export { normalizeRule, RULE_API_VERSION } from './validation.js';

function decodeShare(value) {
  const payload = decodeURIComponent(value.replace(/^kazumi:(?:\/\/)?/i, '')).replace(/\s/g, '');
  if (!payload || !/^[A-Za-z0-9+/_=-]+$/.test(payload)) throw new HttpError('kazumi 分享链接无效');
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    throw new HttpError('kazumi 分享链接内容无效');
  }
}

export function parseImport(content, options) {
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
    const rule = normalizeRule(typeof item === 'string' ? decodeShare(item) : item, options);
    rules.set(rule.name.toLowerCase(), rule);
  }
  return [...rules.values()];
}

export class RuleStore {
  constructor(directory, initialRules = [], validationOptions = {}) {
    this.directory = directory;
    this.file = join(directory, 'rules.json');
    this.rules = [];
    this.initialRules = initialRules;
    this.validationOptions = validationOptions;
    this.pending = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      // Existing installations can contain rules accepted by older validators.
      // Keep them readable and report their compatibility through the API.
      this.rules =
        Array.isArray(value) && value.length === 0 ? [] : parseImport(value, { validate: false });
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(`无法读取规则数据文件 ${this.file}: ${error.message}`);
      if (this.initialRules.length) {
        const initial = parseImport(this.initialRules, { validate: false });
        await this.update(() => initial);
      }
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
  async import(content) {
    const incoming = (await this.validationOptions.core.validate(content)).map((rule) =>
      normalizeRule(rule),
    );
    return this.update((existing) => {
      const map = new Map(existing.map((rule) => [rule.name.toLowerCase(), rule]));
      for (const rule of incoming) map.set(rule.name.toLowerCase(), rule);
      return [...map.values()];
    });
  }
  async replace(name, input) {
    const [replacement] = (await this.validationOptions.core.validate(input)).map((rule) =>
      normalizeRule(rule),
    );
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
