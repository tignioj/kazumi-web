// Match the original iframe parser: the media URL is a query parameter of
// the player page. URLSearchParams decodes that parameter once, retaining the
// media URL's own escaped query/signature rather than decoding it again.
export function legacyIframeMedia(value, baseURL) {
  try {
    const frame = new URL(value, baseURL);
    if (!['http:', 'https:'].includes(frame.protocol)) return null;
    if (
      /googleads|googlesyndication|adtrafficquality|doubleclick|prestrain(?:\.|%2e)html/i.test(
        frame.href,
      )
    )
      return null;
    let result = null;
    for (const parameter of frame.searchParams.values()) {
      try {
        const media = new URL(parameter);
        if (!['http:', 'https:'].includes(media.protocol)) continue;
        const extension = /\.(m3u8|mp4)$/i.exec(media.pathname)?.[1];
        if (extension)
          result = { url: media.href, type: extension.toLowerCase() === 'm3u8' ? 'hls' : 'video' };
      } catch {
        // Other query parameters may contain opaque parser IDs.
      }
    }
    return result;
  } catch {
    return null;
  }
}
