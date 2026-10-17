import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { HttpError } from './http.js';
import { DATABASE_NAME, METADATA_SCHEMA } from './local-metadata.js';

export const ARCHIVE_MANIFEST =
  'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json';
const MAX_ARCHIVE = 2 * 1024 ** 3;

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function archiveManifest(input) {
  const url = new URL(input.browser_download_url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !/^dump-[\w.-]+\.zip$/.test(input.name || '') ||
    !/^sha256:[a-f0-9]{64}$/i.test(input.digest || '') ||
    !Number.isSafeInteger(input.size) ||
    input.size <= 0 ||
    input.size > MAX_ARCHIVE
  )
    throw new Error('官方归档版本信息无效或归档超过 2 GiB');
  return {
    url: url.href,
    version: input.name,
    digest: input.digest.toLowerCase(),
    size: input.size,
    createdAt: input.created_at || null,
  };
}

async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

export class ArchiveManager {
  constructor({
    store,
    http,
    manifestUrl = process.env.METADATA_ARCHIVE_MANIFEST_URL || ARCHIVE_MANIFEST,
    intervalHours = Number(process.env.METADATA_UPDATE_INTERVAL_HOURS ?? 24),
    autoUpdate = process.env.METADATA_AUTO_UPDATE !== 'false',
  }) {
    if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 720)
      throw new Error('METADATA_UPDATE_INTERVAL_HOURS 必须在 1 到 720 小时之间');
    this.store = store;
    this.http = http;
    this.directory = store.directory;
    this.manifestUrl = manifestUrl;
    this.intervalHours = intervalHours;
    this.autoUpdate = autoUpdate;
    this.state = { phase: 'idle', updating: false, lastError: null };
    this.writes = Promise.resolve();
    this.pending = null;
    this.closed = false;
  }

  async status() {
    let state = this.state;
    if (!this.pending) {
      try {
        state = JSON.parse(await readFile(join(this.directory, 'status.json'), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') state = { ...state, lastError: '无法读取归档更新状态' };
      }
    }
    const current = await this.store.info();
    return {
      ...state,
      mode: 'local',
      ready: !!current,
      current,
      autoUpdate: this.autoUpdate,
      intervalHours: this.intervalHours,
    };
  }

  persist(changes) {
    Object.assign(this.state, changes);
    const snapshot = { ...this.state, updatedAt: new Date().toISOString() };
    this.writes = this.writes
      .catch(() => {})
      .then(() => atomicJson(join(this.directory, 'status.json'), snapshot));
    return this.writes;
  }

  start() {
    if (!this.autoUpdate || this.started || this.closed) return;
    this.started = true;
    const run = async () => {
      let failed = false;
      try {
        await this.update();
      } catch (error) {
        failed = true;
        if (!this.closed) console.warn('[metadata]', error.message);
      }
      if (!this.closed) {
        const delay = failed ? 15 * 60 * 1000 : this.intervalHours * 3600000;
        try {
          await this.persist({ nextCheckAt: new Date(Date.now() + delay).toISOString() });
        } finally {
          if (!this.closed) {
            this.timer = setTimeout(() => {
              void run().catch((error) => console.warn('[metadata]', error.message));
            }, delay);
            this.timer.unref();
          }
        }
      }
    };
    void run().catch((error) => console.warn('[metadata]', error.message));
  }

  update(options = {}) {
    if (this.closed) return Promise.reject(new Error('归档更新器已关闭'));
    if (this.pending) return this.pending;
    this.pending = this.perform(options).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async perform({ file, version } = {}) {
    let lock;
    try {
      // A SQLite write lock also serializes a running server and the CLI, and
      // is released by the OS if either process crashes.
      lock = new DatabaseSync(join(this.directory, 'update-lock.sqlite'));
      lock.exec(
        'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS update_lock(id INTEGER); BEGIN IMMEDIATE;',
      );
    } catch (error) {
      lock?.close();
      if (/locked|busy/i.test(error.message)) throw new HttpError('已有归档更新任务正在运行', 409);
      throw error;
    }
    const token = randomUUID();
    const downloaded = join(this.directory, `download-${token}.zip`);
    const output = join(this.directory, `metadata-${token}.sqlite`);
    this.controller = new AbortController();
    try {
      await this.persist({
        phase: 'checking',
        updating: true,
        lastError: null,
        progress: null,
        startedAt: new Date().toISOString(),
      });
      await this.cleanup();
      let source;
      let archive;
      if (file) {
        archive = resolve(file);
        const info = await stat(archive);
        if (!info.isFile() || info.size <= 0 || info.size > MAX_ARCHIVE)
          throw new Error('本地归档文件无效或超过 2 GiB');
        source = {
          version: version || basename(archive),
          digest: await fileDigest(archive),
          size: info.size,
          createdAt: null,
        };
      } else {
        source = archiveManifest(
          await this.http.json(this.manifestUrl, {
            signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)]),
          }),
        );
      }
      const current = await this.store.info();
      if (current?.digest === source.digest && current.schema === METADATA_SCHEMA) {
        await this.persist({
          phase: 'current',
          updating: false,
          lastCheckAt: new Date().toISOString(),
          progress: null,
        });
        return current;
      }
      if (!archive) {
        archive = downloaded;
        await this.download(source, archive);
      }
      this.controller.signal.throwIfAborted();
      const counts = await this.import(archive, output);
      const handle = await open(output, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.controller.signal.throwIfAborted();
      const next = {
        file: basename(output),
        schema: METADATA_SCHEMA,
        version: source.version,
        digest: source.digest,
        archiveCreatedAt: source.createdAt,
        importedAt: new Date().toISOString(),
        ...counts,
      };
      await atomicJson(join(this.directory, 'current.json'), next);
      await this.store.refresh();
      await this.persist({
        phase: 'current',
        updating: false,
        lastError: null,
        lastCheckAt: new Date().toISOString(),
        progress: null,
      });
      await this.cleanup().catch((error) => console.warn('[metadata] cleanup:', error.message));
      return next;
    } catch (error) {
      // The currently published database is never changed on download, parse,
      // validation, disk, or worker failure.
      await this.persist({
        phase: this.closed ? 'idle' : 'error',
        updating: false,
        lastError: this.closed ? null : error.message.slice(0, 1500),
        progress: null,
      }).catch(() => {});
      throw error;
    } finally {
      try {
        await rm(downloaded, { force: true });
        const current = await this.store.info().catch(() => null);
        if (current?.file !== basename(output)) await rm(output, { force: true }).catch(() => {});
      } finally {
        lock.close();
        this.controller = null;
      }
    }
  }

  async cleanup() {
    const current = await this.store.info();
    const snapshots = [];
    for (const name of await readdir(this.directory)) {
      if (/^(?:download-[a-f0-9-]{36}\.zip|.+\.json\.[a-f0-9-]{36}\.tmp)$/.test(name))
        await rm(join(this.directory, name), { force: true });
      if (DATABASE_NAME.test(name) && name !== current?.file)
        snapshots.push({ name, mtime: (await stat(join(this.directory, name))).mtimeMs });
    }
    // Retain one preceding snapshot. Readers on another process can finish on
    // their open old file; Windows may keep it until its reader releases it.
    snapshots.sort((a, b) => b.mtime - a.mtime);
    for (const { name } of snapshots.slice(1))
      await rm(join(this.directory, name), { force: true }).catch(() => {});
  }

  async download(source, path) {
    await this.persist({ phase: 'downloading', progress: { bytes: 0, totalBytes: source.size } });
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30 * 60000)]);
    const { response } = await this.http.request(source.url, { signal });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`归档下载返回 HTTP ${response.status}`);
    }
    const hash = createHash('sha256');
    let size = 0;
    let reported = 0;
    const meter = new Transform({
      transform: (chunk, encoding, callback) => {
        size += chunk.length;
        if (size > source.size || size > MAX_ARCHIVE)
          return callback(new Error('归档下载超过声明大小'));
        hash.update(chunk);
        if (Date.now() - reported > 1000) {
          reported = Date.now();
          void this.persist({ progress: { bytes: size, totalBytes: source.size } }).catch(() => {});
        }
        callback(null, chunk);
      },
    });
    if (!response.body) throw new Error('归档下载为空');
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(path, { flags: 'wx' }),
      { signal },
    );
    await this.persist({ phase: 'verifying', progress: { bytes: size, totalBytes: source.size } });
    if (size !== source.size || `sha256:${hash.digest('hex')}` !== source.digest)
      throw new Error('归档大小或 SHA-256 校验失败，保留原有数据库');
  }

  import(archive, output) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./archive-worker.js', import.meta.url), {
        workerData: { archive, output },
        // CLI/debug/test runner flags are not necessarily valid worker flags.
        execArgv: [],
      });
      this.worker = worker;
      let result;
      let failure;
      worker.on('message', (message) => {
        if (message.progress)
          void this.persist({ phase: message.progress.phase, progress: message.progress }).catch(
            () => {},
          );
        if (message.error) failure = new Error(message.error);
        if (message.result) result = message.result;
      });
      worker.on('error', (error) => {
        failure = error;
      });
      worker.on('exit', (code) => {
        this.worker = null;
        if (failure || code !== 0 || !result) reject(failure || new Error('归档导入任务未完成'));
        else resolve(result);
      });
    });
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    await this.worker?.terminate();
    await this.pending?.catch(() => {});
    await this.writes.catch(() => {});
  }
}
