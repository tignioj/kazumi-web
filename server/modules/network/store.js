import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/http.js';
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  PROXY_SCOPES,
} from '../../../shared/network-settings.js';

export class NetworkStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'network-settings.json');
    this.data = { ...DEFAULT_NETWORK_SETTINGS };
    this.pending = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.enabled !== undefined && typeof saved.enabled !== 'boolean')
        throw new Error('旧代理设置无效');
      for (const key of Object.values(PROXY_SCOPES))
        if (saved[key] === undefined) saved[key] = saved.enabled ?? false;
      delete saved.enabled;
      // Older versions used the API ECH switch for images as well.
      if (saved.imageAcceleration === undefined)
        saved.imageAcceleration = saved.bangumiEch === true ? 'ech' : 'direct';
      this.data = normalizeNetworkSettings(saved);
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('无法读取网络设置，请检查 network-settings.json');
    }
    return this;
  }
  publicSettings(data = this.data) {
    const { password, ...settings } = data;
    return { ...settings, hasPassword: Boolean(password) };
  }
  validate(input) {
    try {
      return normalizeNetworkSettings(input, this.data);
    } catch (error) {
      throw new HttpError(error.message);
    }
  }
  save(input) {
    const operation = this.pending.then(async () => {
      const next = this.validate(input);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.data = next;
      return this.publicSettings();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
