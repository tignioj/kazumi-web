// Port of Kazumi's M3u8AdFilter: group segments by DISCONTINUITY and
// compare each group's total duration with the longest content group.
// Keep encryption and byte ranges tied to the original segment positions.
export function filterHlsAds(text) {
  if (!text.trimStart().startsWith('#EXTM3U')) return text;
  if (/#EXT-X-(?:STREAM-INF|MEDIA|PART|PRELOAD-HINT|SKIP|DEFINE):/i.test(text)) return text;
  const header = [],
    footer = [],
    segments = [],
    durations = new Map();
  let tags = [],
    key = null,
    map = null,
    group = 0,
    duration = null,
    range = null;
  let sequence = 0n,
    discontinuitySequence = 0n,
    previousRange = null;
  for (const source of text.split(/\r?\n/)) {
    const line = source.trim();
    if (!line) continue;
    if (line === '#EXT-X-DISCONTINUITY') {
      group++;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      if (!/^\d+$/.test(line.split(':')[1])) return text;
      sequence = BigInt(line.split(':')[1]);
      header.push(line);
    } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      if (!/^\d+$/.test(line.split(':')[1])) return text;
      discontinuitySequence = BigInt(line.split(':')[1]);
      header.push(line);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      if (!/METHOD=(?:NONE|AES-128)(?:,|$)/.test(line)) return text;
      if (/KEYFORMAT=/.test(line) && !/KEYFORMAT="identity"/.test(line)) return text;
      key = line;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      // Implicit initialization ranges cannot be relocated reliably.
      if (/BYTERANGE="\d+"/.test(line)) return text;
      map = { line, key };
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(duration) || duration < 0) return text;
      tags.push(line);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = /^(\d+)(?:@(\d+))?$/.exec(line.slice(17));
      if (!range) return text;
    } else if (line === '#EXT-X-ENDLIST') footer.push(line);
    else if (
      /^#EXT(?:M3U|-X-(?:VERSION|TARGETDURATION|PLAYLIST-TYPE|INDEPENDENT-SEGMENTS|START))\b/.test(
        line,
      )
    )
      header.push(line);
    else if (line.startsWith('#')) tags.push(line);
    else {
      if (duration === null) return text;
      let byteRange;
      if (range) {
        if (!range[2] && previousRange?.uri !== line) return text;
        const start = range[2] ? BigInt(range[2]) : previousRange.end;
        byteRange = `${range[1]}@${start}`;
        previousRange = { uri: line, end: start + BigInt(range[1]) };
      } else previousRange = null;
      segments.push({ uri: line, tags, duration, group, sequence, key, map, byteRange });
      durations.set(group, (durations.get(group) || 0) + duration);
      sequence++;
      tags = [];
      duration = null;
      range = null;
    }
  }
  if (durations.size <= 1 || duration !== null) return text;
  const longest = [...durations.values()].reduce((max, seconds) => Math.max(max, seconds), 0);
  const groups = [...durations.keys()];
  const ads = new Set(
    groups.filter((id) => {
      const seconds = durations.get(id);
      return (
        seconds !== longest &&
        (seconds < longest * 0.3 ||
          seconds < 10 ||
          ((id === groups[0] || id === groups.at(-1)) && seconds < 30))
      );
    }),
  );
  const kept = segments.filter((segment) => !ads.has(segment.group));
  if (kept.length === segments.length || !kept.length) return text;
  const first = kept[0];
  const output = header.filter(
    (line) => !/^#EXT-X-(?:MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|TARGETDURATION):/.test(line),
  );
  output.push(
    `#EXT-X-TARGETDURATION:${Math.ceil(kept.reduce((max, segment) => Math.max(max, segment.duration), 0))}`,
  );
  output.push(`#EXT-X-MEDIA-SEQUENCE:${first.sequence}`);
  if (discontinuitySequence || first.group)
    output.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence + BigInt(first.group)}`);
  let emittedKey = null,
    emittedMap = null,
    lastGroup = first.group;
  const emitKey = (value) => {
    const next = value || (emittedKey ? '#EXT-X-KEY:METHOD=NONE' : null);
    if (next !== emittedKey && next) output.push(next);
    emittedKey = next;
  };
  for (const segment of kept) {
    if (segment.group !== lastGroup) output.push('#EXT-X-DISCONTINUITY');
    lastGroup = segment.group;
    if (segment.map && segment.map !== emittedMap) {
      emitKey(segment.map.key);
      output.push(segment.map.line);
      emittedMap = segment.map;
    }
    let segmentKey = segment.key;
    if (segmentKey && /METHOD=AES-128(?:,|$)/.test(segmentKey) && !/(?:[:,])IV=/.test(segmentKey))
      segmentKey += `,IV=0x${segment.sequence.toString(16).padStart(32, '0')}`;
    emitKey(segmentKey);
    output.push(...segment.tags);
    if (segment.byteRange) output.push(`#EXT-X-BYTERANGE:${segment.byteRange}`);
    output.push(segment.uri);
  }
  return [...output, ...footer, ...tags].join('\n') + '\n';
}
