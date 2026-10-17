import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/http.js';
import {
  normalizeHistoryItem,
  normalizeLibraryItem,
  normalizeWatchData,
} from '../../../shared/watch-data.js';

function validated(normalize, value) {
  try {
    return normalize(value);
  } catch (error) {
    throw new HttpError(error.message);
  }
}

export class WatchStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'watch-data.json');
    this.data = { library: {}, history: [] };
    this.pending = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      this.data = normalizeWatchData(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(`无法读取收藏与观看记录文件 ${this.file}: ${error.message}`);
    }
    return this;
  }
  list() {
    return structuredClone(this.data);
  }
  update(transform) {
    const operation = this.pending.then(async () => {
      const next = validated(normalizeWatchData, transform(this.list()));
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.data = next;
      return this.list();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  saveLibrary(id, input) {
    const item = validated(normalizeLibraryItem, input);
    if (String(item.subject.id) !== id) throw new HttpError('收藏条目 ID 不一致。');
    return this.update((data) => {
      item.addedAt = data.library[id]?.addedAt || item.addedAt;
      data.library[id] = item;
      return data;
    });
  }
  removeLibrary(id) {
    return this.update((data) => {
      delete data.library[id];
      return data;
    });
  }
  saveHistory(input) {
    const item = validated(normalizeHistoryItem, input);
    return this.update((data) => {
      const previous = data.history.find((record) => record.key === item.key);
      // Delayed progress requests must not rewind a newer position or episode.
      if (!previous || item.updatedAt >= previous.updatedAt)
        data.history = [item, ...data.history.filter((record) => record.key !== item.key)];
      return data;
    });
  }
  removeHistory(key) {
    return this.update((data) => ({
      ...data,
      history: key === undefined ? [] : data.history.filter((record) => record.key !== key),
    }));
  }
  restore(input) {
    const incoming = validated(normalizeWatchData, input);
    return this.update(() => incoming);
  }
  migrate(input) {
    const incoming = validated(normalizeWatchData, input);
    return this.update((data) => ({
      // Keep server collection choices when importing an older browser copy.
      library: { ...incoming.library, ...data.library },
      history: [...data.history, ...incoming.history],
    }));
  }
}
