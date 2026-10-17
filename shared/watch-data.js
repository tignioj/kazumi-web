export const WATCH_STATUSES = ['想看', '在看', '看过', '搁置', '抛弃'];
export const watchKey = (rule, url) => `${rule}:${url}`;

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const string = (value) => (typeof value === 'string' ? value : '');
const image = (value) => (/^https?:\/\//i.test(string(value)) ? value : '');
const nonnegative = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
const timestamp = (value) => nonnegative(value) || Date.now();

export function normalizeLibraryItem(item) {
  const subject = item?.subject;
  if (
    !object(subject) ||
    !Number.isSafeInteger(Number(subject.id)) ||
    Number(subject.id) <= 0 ||
    typeof subject.name !== 'string' ||
    !WATCH_STATUSES.includes(item.status)
  )
    throw new Error('收藏数据格式不完整。');
  return {
    subject: {
      id: Number(subject.id),
      name: subject.name,
      name_cn: string(subject.name_cn),
      image: image(subject.image),
      date: string(subject.date),
      summary: string(subject.summary),
      score: nonnegative(subject.score),
      rank: nonnegative(subject.rank),
      eps: nonnegative(subject.eps),
      tags: Array.isArray(subject.tags)
        ? subject.tags.filter((tag) => typeof tag === 'string')
        : [],
    },
    status: item.status,
    addedAt: timestamp(item.addedAt),
  };
}

export function normalizeHistoryItem(item) {
  if (
    !object(item) ||
    typeof item.ruleName !== 'string' ||
    !item.ruleName ||
    typeof item.sourceUrl !== 'string' ||
    !item.sourceUrl ||
    typeof item.title !== 'string' ||
    typeof item.episodeUrl !== 'string'
  )
    throw new Error('观看记录数据格式不完整。');
  return {
    key: watchKey(item.ruleName, item.sourceUrl),
    subjectId:
      Number.isSafeInteger(Number(item.subjectId)) && Number(item.subjectId) > 0
        ? Number(item.subjectId)
        : undefined,
    title: item.title,
    image: image(item.image),
    ruleName: item.ruleName,
    sourceUrl: item.sourceUrl,
    episodeUrl: item.episodeUrl,
    episodeName: string(item.episodeName),
    roadIndex: Math.floor(nonnegative(item.roadIndex)),
    episodeIndex: Math.floor(nonnegative(item.episodeIndex)),
    position: nonnegative(item.position),
    duration: nonnegative(item.duration),
    updatedAt: timestamp(item.updatedAt),
  };
}

export function normalizeWatchData(data) {
  if (!object(data) || !object(data.library) || !Array.isArray(data.history))
    throw new Error('收藏与观看记录数据格式无效。');
  if (Object.keys(data.library).length > 5000) throw new Error('最多保存 5000 部收藏。');
  const library = {};
  for (const value of Object.values(data.library)) {
    const item = normalizeLibraryItem(value);
    library[item.subject.id] = item;
  }
  const history = new Map();
  for (const value of data.history) {
    const item = normalizeHistoryItem(value);
    if (!history.has(item.key) || item.updatedAt > history.get(item.key).updatedAt)
      history.set(item.key, item);
  }
  return {
    library,
    history: [...history.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200),
  };
}
