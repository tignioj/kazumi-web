import { HttpError, USER_AGENT } from './http.js';

export function normalizeSubject(input) {
  const data = input.subject || input;
  // Bangumi Next's compact cards expose dates/episode counts only in their
  // display info, e.g. "12话 / 2026年10月1日 / ...". Preserve its actual precision.
  const infoDate = /(?:^|\s|\/)\s*(\d{4})年(?:(\d{1,2})月)?(?:(\d{1,2})日)?/.exec(data.info || '');
  const dateFromInfo = infoDate
    ? [
        infoDate[1],
        ...infoDate
          .slice(2)
          .filter(Boolean)
          .map((part) => part.padStart(2, '0')),
      ].join('-')
    : '';
  const episodesFromInfo = /(?:^|\/)\s*(\d+)话(?:\s|\/|$)/.exec(data.info || '')?.[1];
  const tags = data.tags?.length ? data.tags : data.metaTags || [];
  return {
    id: Number(data.id),
    name: data.name || '',
    name_cn: data.name_cn || data.nameCN || '',
    image: data.images?.large || data.images?.common || data.images?.medium || data.image || '',
    score: Number(data.rating?.score ?? data.rating?.scoreValue ?? data.score ?? 0),
    rank: Number(data.rating?.rank ?? data.rank ?? 0),
    summary: data.summary || '',
    date: data.date || data.air_date || data.airDate || dateFromInfo,
    eps: Number(
      data.eps ??
        data.total_episodes ??
        data.totalEpisodes ??
        data.epsCount ??
        episodesFromInfo ??
        0,
    ),
    tags: tags.map((tag) => (typeof tag === 'string' ? tag : tag.name)).filter(Boolean),
  };
}

export class MetadataService {
  constructor(
    http,
    {
      apiUrl = process.env.BANGUMI_API_URL || 'https://api.bgm.tv',
      nextUrl = process.env.BANGUMI_NEXT_URL || 'https://next.bgm.tv',
    } = {},
  ) {
    this.http = http;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.nextUrl = nextUrl.replace(/\/$/, '');
    this.cache = new Map();
  }
  async cached(key, action, ttl = 5 * 60000) {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.promise;
    const promise = action().catch((error) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, { promise, expires: Date.now() + ttl });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
  get(url, options = {}) {
    return this.http.json(url, {
      ...options,
      headers: { 'user-agent': process.env.BANGUMI_USER_AGENT || USER_AGENT, ...options.headers },
    });
  }
  async search(keyword, { sort = 'match', page = 1 } = {}) {
    return this.cached(`search:${keyword}:${sort}:${page}`, async () => {
      const data = await this.get(
        `${this.apiUrl}/v0/search/subjects?limit=24&offset=${(page - 1) * 24}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            keyword,
            sort,
            filter: { type: [2], ...(sort === 'rank' ? { rank: ['>0'] } : {}) },
          }),
        },
      );
      return { items: (data.data || []).map(normalizeSubject), total: Number(data.total || 0) };
    });
  }
  async catalog(sort, page) {
    if (sort !== 'trending') return this.search('', { sort: 'rank', page });
    return this.cached(`trending:${page}`, async () => {
      const data = await this.get(
        `${this.nextUrl}/p1/trending/subjects?type=2&limit=24&offset=${(page - 1) * 24}`,
      );
      return {
        items: (data.data || []).map(normalizeSubject),
        total: Number(data.total || (data.data || []).length),
      };
    });
  }
  async calendar() {
    return this.cached('calendar', async () => {
      let data;
      try {
        data = await this.get(`${this.nextUrl}/p1/calendar`);
      } catch {
        data = await this.get(`${this.apiUrl}/calendar`);
      }
      if (Array.isArray(data))
        return data.map((day) => ({
          weekday: day.weekday,
          items: (day.items || []).map(normalizeSubject),
        }));
      const names = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
      return names.map((cn, index) => ({
        weekday: { id: index + 1, cn },
        items: (data[index + 1] || []).map(normalizeSubject),
      }));
    });
  }
  async subject(id) {
    if (!/^\d+$/.test(String(id))) throw new HttpError('条目 ID 无效');
    return this.cached(`subject:${id}`, async () => {
      const data = await this.get(`${this.apiUrl}/v0/subjects/${id}`);
      const subject = normalizeSubject(data);
      try {
        const episodes = await this.get(
          `${this.apiUrl}/v0/episodes?subject_id=${id}&type=0&limit=200&offset=0`,
        );
        subject.episodes = episodes.data || [];
      } catch {
        subject.episodes = [];
      }
      return subject;
    });
  }
}
