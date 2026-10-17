export function bangumiImageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
      return null;
    if (
      url.hostname !== 'lain.bgm.tv' &&
      !(
        url.hostname === 'api.bgm.tv' &&
        /^\/v0\/(subjects|characters|persons)\/[1-9]\d*\/image$/.test(url.pathname)
      )
    )
      return null;
    url.protocol = 'https:';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

// Keep original URLs in watch data/backups; route every rendering surface through here.
export function imageSource(value) {
  const url = bangumiImageUrl(value);
  return url ? `/api/image?url=${encodeURIComponent(url)}` : value;
}
