export const episodeLabel = (episode) =>
  `第 ${episode.sort ?? episode.ep} 话${episode.name_cn || episode.nameCN || episode.name ? ` · ${episode.name_cn || episode.nameCN || episode.name}` : ''}`;

// Source playlists can be reordered, reversed, or contain specials. Only match
// an explicit, single episode number; the viewer can select everything else.
export function matchCommentEpisode(episodes, name = '') {
  const label = name.normalize('NFKC').trim();
  if (/\d\s*[-~至到]\s*(?:第\s*)?\d|[集话話]\s*[-~至到]?\s*第\s*\d/.test(label)) return '';
  const match =
    /^(?:第\s*(\d+(?:\.\d+)?)\s*[集话話]|(?:EP(?:ISODE)?\s*)?(\d+(?:\.\d+)?)(?:\s*[集话話])?)(?:$|\s+(?![-~至到\d])|[：:、](?!\d))/i.exec(
      label,
    );
  if (!match) return '';
  const number = Number(match[1] ?? match[2]);
  const candidates = episodes.filter(
    (episode) => Number(episode.type) === 0 && Number(episode.sort ?? episode.ep) === number,
  );
  return candidates.length === 1 ? String(candidates[0].id) : '';
}
