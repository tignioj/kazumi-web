import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import yauzl from 'yauzl';
import { METADATA_SCHEMA, foldText } from './local-store.js';

const PLATFORMS = { 1: 'TV', 2: 'OVA', 3: '剧场版', 4: '短片', 5: 'WEB', 2006: '动态漫画' };
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const text = (value, max = 65536) => (typeof value === 'string' ? value.slice(0, max) : '');

async function* rows(stream) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.write(chunk);
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line.length > 4 * 1024 ** 2) throw new Error('归档单行超过 4 MiB');
      if (line) yield JSON.parse(line);
    }
    if (buffer.length > 4 * 1024 ** 2) throw new Error('归档单行超过 4 MiB');
  }
  buffer += decoder.end();
  if (buffer.trim()) yield JSON.parse(buffer);
}

export async function importArchive({ archive, output, progress = () => {} }) {
  const zip = await yauzl.openPromise(archive, { autoClose: false, strictFileNames: true });
  let db;
  try {
    const entries = new Map();
    for await (const entry of zip.eachEntry()) {
      if (!['subject.jsonlines', 'episode.jsonlines'].includes(entry.fileName)) continue;
      if (entries.has(entry.fileName) || entry.uncompressedSize > 2 * 1024 ** 3)
        throw new Error('归档数据文件重复或过大');
      entries.set(entry.fileName, entry);
    }
    if (entries.size !== 2) throw new Error('归档缺少 subject.jsonlines 或 episode.jsonlines');
    db = new DatabaseSync(output);
    db.exec(`
      PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-32768;
      CREATE TABLE subjects(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_cn TEXT NOT NULL, summary TEXT NOT NULL,
        date TEXT NOT NULL, platform TEXT NOT NULL, score REAL NOT NULL, rank INTEGER NOT NULL, favorite INTEGER NOT NULL,
        eps INTEGER NOT NULL, tags TEXT NOT NULL, image TEXT NOT NULL, search_text TEXT NOT NULL);
      CREATE TABLE subject_tags(subject_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(subject_id,tag)) WITHOUT ROWID;
      CREATE TABLE episodes(id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL, name TEXT NOT NULL, name_cn TEXT NOT NULL,
        sort REAL NOT NULL, type INTEGER NOT NULL, airdate TEXT NOT NULL, duration TEXT NOT NULL, description TEXT NOT NULL);
      BEGIN;
    `);
    const insert = db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertTag = db.prepare('INSERT OR IGNORE INTO subject_tags VALUES(?,?)');
    let subjects = 0;
    let processed = 0;
    progress({ phase: 'subjects', processed: 0 });
    const subjectsStream = await zip.openReadStreamPromise(entries.get('subject.jsonlines'));
    for await (const row of rows(subjectsStream)) {
      processed++;
      if (processed % 10000 === 0) progress({ phase: 'subjects', processed, subjects });
      if (Number(row.type) !== 2) continue;
      if (!positiveId(row.id) || !text(row.name)) throw new Error('归档动画条目 ID 或名称无效');
      const platform = PLATFORMS[row.platform] || '';
      const tags = [
        ...new Set(
          [
            ...(Array.isArray(row.tags) ? row.tags : []).map((tag) =>
              typeof tag === 'string' ? tag : tag?.name,
            ),
            ...(Array.isArray(row.meta_tags) ? row.meta_tags : []),
            platform,
          ]
            .filter((tag) => typeof tag === 'string' && tag.trim())
            .map((tag) => tag.trim().slice(0, 100)),
        ),
      ].slice(0, 100);
      const favorite =
        typeof row.favorite === 'object' && row.favorite
          ? Object.values(row.favorite).reduce(
              (sum, value) => sum + Math.max(0, Number(value) || 0),
              0,
            )
          : Number(row.favorite) || 0;
      const wiki = text(row.infobox);
      const aliases = [
        ...wiki.matchAll(/^\|(?:别名|别称|其他名称)\s*=\s*([\s\S]*?)(?=^\||\}\}$)/gm),
      ]
        .map((match) => match[1])
        .join('\n');
      const eps = Number(/(?:^|\n)\|话数\s*=\s*(\d+)/.exec(wiki)?.[1]) || 0;
      insert.run(
        Number(row.id),
        text(row.name),
        text(row.name_cn),
        text(row.summary),
        text(row.date, 10),
        platform,
        Math.max(0, Math.min(10, Number(row.score) || 0)),
        Math.max(0, Math.floor(Number(row.rank) || 0)),
        Math.min(1e12, favorite),
        eps,
        JSON.stringify(tags),
        '',
        foldText(`${text(row.name_cn)}\n${text(row.name)}\n${aliases}`),
      );
      for (const tag of tags) insertTag.run(Number(row.id), tag);
      subjects++;
    }
    if (!subjects) throw new Error('归档中没有可用的动画条目');
    db.exec('COMMIT; CREATE INDEX subject_tags_tag ON subject_tags(tag,subject_id); BEGIN;');
    const hasSubject = db.prepare('SELECT 1 FROM subjects WHERE id=?');
    const insertEpisode = db.prepare('INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?,?)');
    let episodes = 0;
    processed = 0;
    progress({ phase: 'episodes', processed, subjects, episodes });
    const episodesStream = await zip.openReadStreamPromise(entries.get('episode.jsonlines'));
    for await (const row of rows(episodesStream)) {
      processed++;
      if (processed % 10000 === 0) progress({ phase: 'episodes', processed, subjects, episodes });
      if (!positiveId(row.subject_id) || !hasSubject.get(Number(row.subject_id))) continue;
      if (
        !positiveId(row.id) ||
        !Number.isFinite(Number(row.sort)) ||
        !Number.isInteger(Number(row.type))
      )
        throw new Error('归档章节数据无效');
      insertEpisode.run(
        Number(row.id),
        Number(row.subject_id),
        text(row.name),
        text(row.name_cn),
        Number(row.sort),
        Number(row.type),
        text(row.airdate, 10),
        text(row.duration, 100),
        text(row.description),
      );
      episodes++;
    }
    progress({ phase: 'indexing', subjects, episodes });
    db.exec(`COMMIT;
      CREATE INDEX episodes_subject ON episodes(subject_id,type,sort,id);
      CREATE INDEX episodes_airdate ON episodes(airdate,subject_id) WHERE type=0;
      UPDATE subjects SET eps=max(eps,(SELECT count(*) FROM episodes WHERE subject_id=subjects.id AND type=0));
      CREATE INDEX subjects_heat ON subjects(favorite DESC,id);
      CREATE INDEX subjects_rank ON subjects(rank,id);
      CREATE INDEX subjects_score ON subjects(score DESC,favorite DESC,id);
      CREATE INDEX subjects_date ON subjects(date,id);
      CREATE VIRTUAL TABLE subject_fts USING fts5(search_text,content='subjects',content_rowid='id',tokenize='trigram');
      INSERT INTO subject_fts(subject_fts) VALUES('rebuild');
      INSERT INTO subject_fts(subject_fts) VALUES('optimize');
      PRAGMA user_version=${METADATA_SCHEMA};
      ANALYZE;
    `);
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
      throw new Error('元数据库完整性检查失败');
    db.close();
    db = null;
    return { subjects, episodes };
  } finally {
    db?.close();
    zip.close();
  }
}
