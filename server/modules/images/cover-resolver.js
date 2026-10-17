import { bangumiImageUrl } from '../../../shared/images.js';
import { HttpError } from '../../lib/http.js';

// Official wiki archives omit cover filenames. Resolve only these stable
// subject-image placeholders, on a cache miss or background refresh, separately from local queries.
export function createCoverResolver(
  http,
  nextUrl = process.env.BANGUMI_NEXT_URL || 'https://next.bgm.tv',
) {
  return async (value, signal) => {
    const url = new URL(value);
    const match =
      url.hostname === 'api.bgm.tv' && /^\/v0\/subjects\/([1-9]\d*)\/image$/.exec(url.pathname);
    if (!match) return value;
    const data = await http.json(`${nextUrl.replace(/\/$/, '')}/p1/subjects/${match[1]}`, {
      signal,
    });
    const images = (data.subject || data).images;
    const target = bangumiImageUrl(images?.large || images?.common || images?.medium || '');
    if (!target || new URL(target).hostname !== 'lain.bgm.tv')
      throw new HttpError('暂时无法取得这部番剧的封面', 502);
    return target;
  };
}
