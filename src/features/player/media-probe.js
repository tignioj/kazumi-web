const VIDEO_CODEC = /^(avc[13]|hev1|hvc1|av01|vp0?9|vp0?8|dvhe|dvh1)(\.|$)/i;
const AUDIO_CODEC = /^(mp4a|ac-3|ec-3|opus|flac|mp3)(\.|$)/i;

export function codecTracks(codecs = '') {
  return codecs
    .split(',')
    .map((codec) => codec.trim())
    .filter((codec) => /^[\w.-]{1,100}$/.test(codec))
    .map((codec) => ({
      kind: VIDEO_CODEC.test(codec) ? 'video' : AUDIO_CODEC.test(codec) ? 'audio' : 'unknown',
      codec,
      mime: `${VIDEO_CODEC.test(codec) ? 'video' : 'audio'}/mp4`,
      exact:
        (VIDEO_CODEC.test(codec) && codec.includes('.')) ||
        (AUDIO_CODEC.test(codec) && (codec !== 'mp4a' || codec.includes('.'))),
    }));
}

export function playlistTracks(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('#EXT-X-STREAM-INF:'))
    .map((line) => codecTracks(/(?:[:,])CODECS="([^"]+)"/.exec(line)?.[1] || ''));
}

// Read sample descriptions only. Never decode or scan arbitrary payload bytes for codec names.
// If moov is beyond the bounded prefix, report unknown and let actual playback decide.
export function mp4Tracks(bytes) {
  const tracks = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  function boxes(start, end, visit) {
    for (let offset = start; offset + 8 <= end;) {
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (!Number.isSafeInteger(size) || size < header) break;
      visit(text(offset + 4, offset + 8), offset + header, Math.min(end, offset + size));
      offset += size;
    }
  }
  function walk(start, end, depth = 0) {
    if (depth > 8) return;
    boxes(start, end, (type, body, limit) => {
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(body, limit, depth + 1);
      if (type !== 'stsd' || body + 8 > limit) return;
      boxes(body + 8, limit, (sample, entry, entryEnd) => {
        if (['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09'].includes(sample)) {
          if (entry + 78 > entryEnd) return;
          let codec = sample;
          boxes(entry + 78, entryEnd, (config, data, configEnd) => {
            if (config === 'avcC' && data + 4 <= configEnd)
              codec += `.${Array.from(bytes.subarray(data + 1, data + 4), (n) => n.toString(16).padStart(2, '0')).join('')}`;
          });
          tracks.push({
            kind: 'video',
            codec,
            mime: 'video/mp4',
            exact: codec.includes('.'),
            width: view.getUint16(entry + 24),
            height: view.getUint16(entry + 26),
          });
        } else if (['mp4a', 'ac-3', 'ec-3', 'Opus', 'fLaC'].includes(sample)) {
          tracks.push({
            kind: 'audio',
            codec: sample,
            mime: 'audio/mp4',
            // mp4a alone does not identify its object type/profile; do not guess AAC-LC.
            exact: sample !== 'mp4a',
          });
        }
      });
    });
  }
  walk(0, bytes.length);
  return tracks;
}

async function prefix(response, maximum) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maximum) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maximum - size);
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function probeMedia(source, signal, fetcher = fetch) {
  // Inspect only our own media/cache endpoint, never a source website or an external URL.
  if (!/^\/api\/(?:media\?|downloads\/[^/]+\/files\/)/.test(source.url))
    return { tracks: [], variants: [], mime: '' };
  const response = await fetcher(source.url, {
    signal,
    ...(source.type !== 'hls' && { headers: { Range: 'bytes=0-262143' } }),
  });
  if (!response.ok) {
    const bytes = await prefix(response, 4096);
    let message = '';
    try {
      message = JSON.parse(new TextDecoder().decode(bytes)).error || '';
    } catch {
      /* Some reverse proxies return HTML error pages. */
    }
    throw Object.assign(new Error(message || `媒体请求返回 HTTP ${response.status}`), {
      status: response.status,
    });
  }
  const mime = (response.headers.get('content-type') || '').split(';')[0];
  const bytes = await prefix(response, 256 * 1024);
  if (source.type === 'hls') {
    const text = new TextDecoder().decode(bytes);
    if (!text.trimStart().startsWith('#EXTM3U'))
      throw Object.assign(new Error('媒体服务器没有返回有效的 HLS 播放列表'), { status: 422 });
    return { mime, variants: playlistTracks(text), tracks: [] };
  }
  const declared = /codecs="([^"]+)"/i.exec(response.headers.get('content-type') || '');
  return { mime, variants: [], tracks: declared ? codecTracks(declared[1]) : mp4Tracks(bytes) };
}

export function trackSupport(track, video, mode, scope = globalThis) {
  if (!track.exact) return null;
  const mime = `${track.mime}; codecs="${track.codec}"`;
  try {
    if (mode === 'mse') {
      const MediaSource = scope.MediaSource || scope.ManagedMediaSource || scope.WebKitMediaSource;
      return MediaSource?.isTypeSupported ? MediaSource.isTypeSupported(mime) : null;
    }
    return typeof video.canPlayType === 'function' ? Boolean(video.canPlayType(mime)) : null;
  } catch {
    return null;
  }
}

export function compatibility(info, video, mode, scope = globalThis) {
  // Different variants are alternatives: one unsupported level must not reject the entire source.
  const groups = info.tracks?.length ? [info.tracks] : info.variants || [];
  const results = groups.map((tracks) => {
    const support = tracks.map((track) => trackSupport(track, video, mode, scope));
    return support.includes(false)
      ? 'unsupported'
      : support.length && support.every((s) => s === true)
        ? 'supported'
        : 'unknown';
  });
  const status = results.includes('supported')
    ? 'supported'
    : results.length && results.every((s) => s === 'unsupported')
      ? 'unsupported'
      : 'unknown';
  const codecs = [...new Set(groups.flat().map((track) => track.codec))];
  return { status, codecs };
}
