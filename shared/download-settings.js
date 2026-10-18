export const DEFAULT_DOWNLOAD_SETTINGS = { threads: 4 };
export const MAX_DOWNLOAD_THREADS = 8;

export function normalizeDownloadSettings(input) {
  if (
    !input ||
    !Number.isInteger(input.threads) ||
    input.threads < 1 ||
    input.threads > MAX_DOWNLOAD_THREADS
  )
    throw new Error('单集下载线程数必须是 1 至 8 的整数');
  return { threads: input.threads };
}
