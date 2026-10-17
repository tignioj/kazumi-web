import { deflateRawSync, crc32 } from 'node:zlib';

// Small ZIP fixtures with the exact official JSON Lines filenames and fields.
export function zipFiles(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(contents);
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

export const subjects = [
  {
    id: 1,
    type: 2,
    name: 'Original Story',
    name_cn: '日常故事',
    platform: 1,
    summary: '剧情简介',
    date: '2026-01-01',
    tags: [{ name: '日常', count: 10 }],
    meta_tags: ['原创'],
    score: 8,
    rank: 10,
    favorite: { wish: 5, done: 20, doing: 5 },
    infobox: '{{Infobox animanga/Anime\n|别名={\n[英文名|Hidden Alias]\n}\n|话数=12\n}}',
  },
  {
    id: 2,
    type: 2,
    name: 'A Movie',
    name_cn: '春天的故事',
    platform: 3,
    date: '2026-04-01',
    tags: [{ name: '原创' }],
    score: 9,
    rank: 1,
    favorite: { done: 100 },
  },
  { id: 3, type: 1, name: 'A Book', name_cn: '不应导入的书', tags: [] },
  ...Array.from({ length: 28 }, (_, i) => ({
    id: 10 + i,
    type: 2,
    name: `Space Tale ${i}`,
    name_cn: `星际物语 ${i}`,
    platform: 5,
    date: '2026-03-31',
    tags: [{ name: '科幻' }],
    score: 6,
    rank: 0,
    favorite: { done: i },
  })),
];
export const episodes = [
  {
    id: 1,
    subject_id: 1,
    name: 'Second',
    name_cn: '第二话',
    sort: 2,
    type: 0,
    airdate: '2026-01-08',
  },
  {
    id: 2,
    subject_id: 1,
    name: 'First',
    name_cn: '第一话',
    sort: 1,
    type: 0,
    airdate: '2026-01-01',
  },
  { id: 3, subject_id: 1, name: 'OP', sort: 1, type: 2 },
  { id: 4, subject_id: 3, name: 'Book chapter', sort: 1, type: 0 },
];
export function archiveZip(items = subjects, chapters = episodes) {
  return zipFiles({
    'subject.jsonlines': items.map((item) => JSON.stringify(item)).join('\n') + '\n',
    'episode.jsonlines': chapters.map((item) => JSON.stringify(item)).join('\n') + '\n',
    'person.jsonlines': 'ignored without decompression',
  });
}
