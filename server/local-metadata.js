import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.js';

export const METADATA_SCHEMA = 1;
export const DATABASE_NAME = /^metadata-[a-f0-9-]{36}\.sqlite$/;
export const foldText = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase();

function subject(row) {
  return {
    id: row.id,
    name: row.name,
    name_cn: row.name_cn,
    summary: row.summary,
    date: row.date,
    score: row.score,
    rank: row.rank,
    eps: row.eps,
    tags: JSON.parse(row.tags),
    image: row.image || `https://api.bgm.tv/v0/subjects/${row.id}/image?type=large`,
  };
}

export class LocalMetadataStore {
  constructor(directory) {
    this.directory = directory;
    this.db = null;
    this.file = null;
    this.manifest = null;
    this.refreshing = null;
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    await this.refresh();
    return this;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(this.directory, 'current.json'), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw new HttpError('本地元数据库版本信息损坏，请重新导入归档', 503);
      }
      if (!DATABASE_NAME.test(manifest.file || '') || manifest.schema !== METADATA_SCHEMA)
        throw new HttpError('本地元数据库版本不兼容，请重新导入归档', 503);
      if (manifest.file === this.file) return;
      let next;
      try {
        next = new DatabaseSync(join(this.directory, manifest.file), { readOnly: true });
        next.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192;');
        if (next.prepare('PRAGMA user_version').get().user_version !== METADATA_SCHEMA)
          throw new Error('schema mismatch');
        const count = next.prepare('SELECT count(*) count FROM subjects').get().count;
        if (!count || count !== manifest.subjects) throw new Error('subject count mismatch');
      } catch {
        next?.close();
        throw new HttpError('本地元数据库无法读取，请重新导入归档', 503);
      }
      const previous = this.db;
      this.db = next;
      this.file = manifest.file;
      this.manifest = manifest;
      previous?.close();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async info() {
    await this.refresh();
    return this.manifest ? { ...this.manifest } : null;
  }

  async ready() {
    await this.refresh();
    if (!this.db)
      throw new HttpError('本地番剧资料尚未就绪，请在「偏好设置」查看归档导入进度', 503);
  }

  async search(keyword, { sort = 'match', page = 1, tags = [], airDate = [] } = {}) {
    await this.ready();
    if (
      !['match', 'heat', 'rank', 'score'].includes(sort) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 1000
    )
      throw new HttpError('搜索参数无效');
    const terms = foldText(keyword).trim().split(/\s+/).filter(Boolean);
    const where = [];
    const values = [];
    const indexed = terms.filter((term) => [...term].length >= 3);
    if (indexed.length) {
      where.push('s.id IN (SELECT rowid FROM subject_fts WHERE subject_fts MATCH ?)');
      values.push(indexed.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND '));
    }
    for (const term of terms.filter((term) => [...term].length < 3)) {
      where.push('instr(s.search_text, ?) > 0');
      values.push(term);
    }
    for (const tag of [...new Set(tags)]) {
      where.push('EXISTS (SELECT 1 FROM subject_tags t WHERE t.subject_id=s.id AND t.tag=?)');
      values.push(tag);
    }
    for (const bound of airDate) {
      const match = /^(>=|<)(\d{4}-\d{2}-\d{2})$/.exec(bound);
      if (!match) throw new HttpError('日期范围无效');
      where.push(`s.date ${match[1]} ?`);
      values.push(match[2]);
    }
    if (sort === 'rank') where.push('s.rank > 0');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare(`SELECT count(*) total FROM subjects s ${clause}`)
      .get(...values).total;
    const order = {
      heat: 's.favorite DESC, s.id ASC',
      rank: 's.rank ASC, s.favorite DESC, s.id ASC',
      score: 's.score DESC, s.favorite DESC, s.id ASC',
      match: terms.length
        ? 'CASE WHEN instr(s.search_text, ?) = 1 THEN 0 ELSE 1 END, s.favorite DESC, s.id ASC'
        : 's.favorite DESC, s.id ASC',
    }[sort];
    const orderValues = sort === 'match' && terms.length ? [foldText(keyword).trim()] : [];
    const rows = this.db
      .prepare(`SELECT s.* FROM subjects s ${clause} ORDER BY ${order} LIMIT 24 OFFSET ?`)
      .all(...values, ...orderValues, (page - 1) * 24);
    return { items: rows.map(subject), total, source: 'archive', version: this.manifest.version };
  }

  async subject(id) {
    if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)))
      throw new HttpError('条目 ID 无效');
    await this.ready();
    const row = this.db.prepare('SELECT * FROM subjects WHERE id=?').get(Number(id));
    if (!row) throw new HttpError('本地归档尚未收录这部番剧，请检查资料更新', 404);
    const episodes = this.db
      .prepare(
        'SELECT id,name,name_cn,sort,type,airdate,duration,description FROM episodes WHERE subject_id=? AND type=0 ORDER BY sort,id',
      )
      .all(Number(id));
    return { ...subject(row), episodes, source: 'archive', version: this.manifest.version };
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}
