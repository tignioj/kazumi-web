export const titleOf = (s) => s?.name_cn || s?.name || '未命名动画';

export const timeLabel = (n) =>
  `${Math.floor((n || 0) / 60)}:${String(Math.floor((n || 0) % 60)).padStart(2, '0')}`;

export const prettyDate = (d) =>
  d ? new Date(d).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '时间未知';

export const bytesLabel = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent - 1]}`;
};
