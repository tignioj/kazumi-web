import { normalizeWatchData } from '../../../shared/watch-data.js';

export function normalizeBackup(data) {
  if (
    data?.format !== 'kazumi-web-backup' ||
    !data.library ||
    Array.isArray(data.library) ||
    typeof data.library !== 'object' ||
    !Array.isArray(data.history)
  )
    throw new Error('这不是有效的 Kazumi Web 备份文件。');
  let records;
  try {
    records = normalizeWatchData(data);
  } catch (error) {
    throw new Error(`备份中的${error.message.replace('数据格式', '格式')}`);
  }
  return {
    ...records,
    settings: {
      theme: ['system', 'light', 'dark'].includes(data.settings?.theme)
        ? data.settings.theme
        : 'system',
      autoNext: !!data.settings?.autoNext,
    },
  };
}
