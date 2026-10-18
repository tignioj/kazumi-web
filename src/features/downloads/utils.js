export const cacheActive = (item) => ['queued', 'downloading'].includes(item.status);

export const sameCacheEpisode = (item, ruleName, episodeUrl) =>
  item.ruleName?.trim().toLowerCase() === ruleName?.trim().toLowerCase() &&
  item.episodeUrl === episodeUrl;

export const cacheStatus = (item) =>
  item.status === 'downloading' && item.type === 'pending'
    ? '正在解析'
    : {
        queued: '等待下载',
        downloading: '正在缓存',
        paused: '已暂停',
        complete: '已缓存',
        error: '缓存失败',
      }[item.status] || '未知状态';

export function groupDownloads(items) {
  const groups = new Map();
  for (const item of items) {
    const identity = item.sourceUrl?.trim()
      ? ['source', item.sourceUrl.trim()]
      : item.subjectId
        ? ['subject', String(item.subjectId)]
        : ['title', item.title.trim()];
    const key = JSON.stringify([item.ruleName.trim().toLowerCase(), ...identity]);
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key).items.push(item);
  }
  const order = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  return [...groups.values()].map((group) => ({
    ...group,
    items: group.items.sort((a, b) => order.compare(a.episodeName, b.episodeName)),
  }));
}
