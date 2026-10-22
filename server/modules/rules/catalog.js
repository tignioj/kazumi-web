import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { HttpError } from '../../lib/http.js';
import { normalizeRule } from './validation.js';

export const DEFAULT_RULES_REPOSITORY =
  'https://raw.githubusercontent.com/Predidit/KazumiRules/main/';
const ttl = 60 * 60 * 1000;
const retryDelay = 60 * 1000;
const maxCacheBytes = 16 * 1024 * 1024;

function ruleName(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 100 ||
    /[\x00-\x1f\x7f/\\]/.test(value) ||
    ['.', '..'].includes(value)
  )
    throw new HttpError('规则仓库中的名称无效', 502);
  return value;
}

function validateIndex(value) {
  if (!Array.isArray(value) || value.length > 500) throw new HttpError('规则仓库索引无效', 502);
  const names = new Set();
  for (const item of value) {
    const name = ruleName(item?.name).toLowerCase();
    if (names.has(name)) throw new HttpError('规则仓库存在重名规则', 502);
    names.add(name);
    if (item.version != null && !['string', 'number'].includes(typeof item.version))
      throw new HttpError('规则仓库版本号无效', 502);
  }
  return value;
}

function validateDetail(value, name) {
  if (ruleName(value?.name).toLowerCase() !== name.toLowerCase())
    throw new HttpError('规则仓库返回的名称与请求不一致', 502);
  normalizeRule(value);
  return value;
}

export function createOfficialRulesCatalog(http, options = {}) {
  const configured =
    (options.repository ?? process.env.RULES_REPOSITORY)?.trim() || DEFAULT_RULES_REPOSITORY;
  const local = isAbsolute(configured) ? resolve(configured) : null;
  let repository = local;
  if (!local) {
    const url = new URL(configured);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'RULES_REPOSITORY 必须是 HTTP(S) 目录地址或本地绝对目录，且不能包含认证、查询参数或片段',
      );
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    repository = url.href;
  }
  const now = options.now || Date.now;
  const cacheDirectory = options.directory && join(options.directory, 'rule-catalog');
  const cacheFile =
    cacheDirectory &&
    join(cacheDirectory, `${createHash('sha256').update(repository).digest('hex')}.json`);
  let index;
  let generation = 0;
  let pendingIndex;
  let writing = Promise.resolve();
  let warned = false;
  const details = new Map();
  const pending = new Map();
  const rejected = new Map();
  const entry = (value, updatedAt, source) => ({
    value,
    updatedAt,
    source,
    stale: false,
    expires: updatedAt + ttl,
  });
  const fresh = (cached, allowFallback) =>
    cached && cached.expires > now() && (allowFallback || !cached.stale);

  async function readJson(path, limit = 2 * 1024 * 1024) {
    const bytes = await readFile(path);
    if (bytes.length > limit) throw new HttpError('规则仓库文件过大', 502);
    return JSON.parse(bytes.toString('utf8'));
  }
  const load = (name) =>
    local ? readJson(join(local, name)) : http.json(`${repository}${encodeURIComponent(name)}`);
  const ready =
    cacheFile &&
    (async () => {
      try {
        const saved = await readJson(cacheFile, maxCacheBytes);
        if (
          saved.version !== 1 ||
          saved.repository !== repository ||
          !Array.isArray(saved.details) ||
          saved.details.length > 500
        )
          return;
        const validTime = (time) => Number.isFinite(time) && time > 0 && time <= now();
        if (saved.index && validTime(saved.index.updatedAt))
          index = entry(validateIndex(saved.index.value), saved.index.updatedAt, 'disk');
        for (const cached of saved.details) {
          try {
            if (validTime(cached.updatedAt))
              details.set(
                ruleName(cached.value?.name).toLowerCase(),
                entry(validateDetail(cached.value, cached.value.name), cached.updatedAt, 'disk'),
              );
          } catch {
            /* A damaged detail must not hide the rest of the cache. */
          }
        }
      } catch {
        /* Missing or damaged caches are rebuilt from the configured repository. */
      }
    })();

  async function persist() {
    if (!cacheFile) return;
    writing = writing
      .then(async () => {
        const saved = {
          version: 1,
          repository,
          index: index?.updatedAt ? { value: index.value, updatedAt: index.updatedAt } : null,
          details: [...details.values()]
            .filter(({ updatedAt }) => updatedAt)
            .map(({ value, updatedAt }) => ({ value, updatedAt })),
        };
        let json = JSON.stringify(saved);
        while (Buffer.byteLength(json) > maxCacheBytes && saved.details.length) {
          saved.details.shift();
          json = JSON.stringify(saved);
        }
        const temporary = `${cacheFile}.${randomUUID()}.tmp`;
        try {
          await mkdir(cacheDirectory, { recursive: true });
          await writeFile(temporary, json, { mode: 0o600 });
          await rename(temporary, cacheFile);
        } finally {
          await rm(temporary, { force: true });
        }
      })
      .catch(() => {
        if (!warned)
          console.warn('[rules] 规则目录缓存写入失败，本次数据仍可使用；请检查数据目录权限和空间');
        warned = true;
      });
    await writing;
  }

  const unavailable = (error) =>
    error.code === 'RULE_INCOMPATIBLE'
      ? error
      : new HttpError(`规则仓库暂不可用，无法确认更新：${error.message}`, 502);

  async function officialRules(refresh = false, { allowFallback = true } = {}) {
    if (ready) await ready;
    if (!refresh && fresh(index, allowFallback)) return structuredClone(index.value);
    if (refresh || !pendingIndex) {
      const request = { generation: ++generation };
      for (const cached of details.values()) cached.expires = 0;
      pending.clear();
      rejected.clear();
      request.promise = Promise.resolve()
        .then(() => load('index.json'))
        .then(async (value) => {
          const result = entry(validateIndex(value), now(), local ? 'local' : 'network');
          if (pendingIndex === request) {
            index = result;
            await persist();
          }
          return result;
        });
      pendingIndex = request;
    }
    const request = pendingIndex;
    try {
      return structuredClone((await request.promise).value);
    } catch (error) {
      if (index && request.generation === generation)
        index = { ...index, stale: true, expires: now() + retryDelay };
      if (!allowFallback) throw unavailable(error);
      if (!index) throw unavailable(error);
      return structuredClone(index.value);
    } finally {
      if (pendingIndex === request) pendingIndex = null;
    }
  }

  async function officialRule(name, refresh = false, { allowFallback = true } = {}) {
    ruleName(name);
    if (ready) await ready;
    const key = name.toLowerCase();
    const cached = details.get(key);
    if (!refresh && fresh(cached, allowFallback)) return structuredClone(cached.value);
    if (refresh || !pending.has(key)) {
      const started = generation;
      const operation = Promise.resolve()
        .then(() => {
          const failure = rejected.get(key);
          if (!refresh && failure?.expires > now()) throw failure.error;
          return load(`${name}.json`);
        })
        .then(async (value) => {
          const result = entry(validateDetail(value, name), now(), local ? 'local' : 'network');
          if (started === generation && pending.get(key) === operation) {
            rejected.delete(key);
            if (!details.has(key) && details.size >= 500)
              details.delete(details.keys().next().value);
            details.set(key, result);
            await persist();
          }
          return result;
        });
      pending.set(key, operation);
    }
    const operation = pending.get(key);
    try {
      return structuredClone((await operation).value);
    } catch (error) {
      // Cache incompatibility reports for previews without persisting an invalid rule.
      if (
        error.code === 'RULE_INCOMPATIBLE' &&
        pending.get(key) === operation &&
        rejected.get(key)?.error !== error
      ) {
        if (!rejected.has(key) && rejected.size >= 500)
          rejected.delete(rejected.keys().next().value);
        rejected.set(key, { error, expires: now() + ttl });
      }
      const current = details.get(key);
      if (current && pending.get(key) === operation)
        details.set(key, { ...current, stale: true, expires: now() + retryDelay });
      if (!allowFallback) throw unavailable(error);
      const fallback = details.get(key)?.value;
      if (!fallback) throw unavailable(error);
      return structuredClone(fallback);
    } finally {
      if (pending.get(key) === operation) pending.delete(key);
    }
  }
  function status(name) {
    const cached = (name && details.get(name.toLowerCase())) || index;
    return {
      repository,
      source: cached?.source ?? null,
      stale: cached?.stale ?? false,
      updatedAt: cached?.updatedAt ?? null,
    };
  }
  return { repository, officialRules, officialRule, status };
}
