import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from '../../lib/http.js';

export const METADATA_SCHEMA = 1;
export const DATABASE_NAME = /^metadata-[a-f0-9-]{36}\.sqlite$/;
export const foldText = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase();

const DAY = 86400000;
const localDate = (now) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
const dateString = (time) => new Date(time).toISOString().slice(0, 10);

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
  constructor(directory, { now = Date.now } = {}) {
    this.directory = directory;
    this.db = null;
    this.file = null;
    this.manifest = null;
    this.refreshing = null;
    this.now = now;
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

  async search(
    keyword,
    { sort = 'match', page = 1, tags = [], airDate = [], completeDates = false } = {},
  ) {
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
    if (completeDates) where.push("length(s.date)=10 AND date(s.date,'+0 days')=s.date");
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

  async trending(page = 1) {
    const today = localDate(this.now());
    const time = Date.parse(`${today}T00:00:00Z`);
    const start = dateString(time - 364 * DAY);
    const end = dateString(time + DAY);
    const result = await this.search('', {
      sort: 'heat',
      page,
      airDate: [`>=${start}`, `<${end}`],
      completeDates: true,
    });
    return { ...result, basis: 'recent-favorites', startDate: start, endDate: today };
  }

  async calendar() {
    await this.ready();
    const today = localDate(this.now());
    const time = Date.parse(`${today}T00:00:00Z`);
    const monday = time - ((new Date(time).getUTCDay() + 6) % 7) * DAY;
    const start = dateString(monday);
    const end = dateString(monday + 7 * DAY);
    const names = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    const days = names.map((cn, index) => ({
      weekday: { id: index + 1, cn },
      date: dateString(monday + index * DAY),
      items: [],
    }));
    // Episode dates take priority. A premiere is a fallback only when no main
    // episode has a valid, complete date; never infer weekly recurrences.
    const rows = this.db
      .prepare(
        `WITH airings AS (
        SELECT subject_id, airdate FROM episodes
        WHERE type=0 AND airdate>=? AND airdate<?
          AND length(airdate)=10 AND date(airdate,'+0 days')=airdate
        UNION
        SELECT s.id, s.date FROM subjects s
        WHERE s.date>=? AND s.date<? AND length(s.date)=10 AND date(s.date,'+0 days')=s.date
          AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.subject_id=s.id AND e.type=0
            AND length(e.airdate)=10 AND date(e.airdate,'+0 days')=e.airdate)
      ) SELECT s.*, a.airdate AS scheduled_date FROM airings a
        JOIN subjects s ON s.id=a.subject_id ORDER BY a.airdate,s.favorite DESC,s.id`,
      )
      .all(start, end, start, end);
    const byDate = new Map(days.map((day) => [day.date, day]));
    for (const row of rows) byDate.get(row.scheduled_date).items.push(subject(row));
    return {
      items: days,
      source: 'archive',
      version: this.manifest.version,
      today,
      weekStart: start,
      weekEnd: days[6].date,
      timezone: 'Asia/Shanghai',
    };
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
