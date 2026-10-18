import { HttpError } from '../../lib/http.js';

export function contentLength(response) {
  const value = response.headers.get('content-length');
  if (response.headers.get('content-encoding') || value == null) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new HttpError('视频长度无效', 502);
  return Number(value);
}

export function checkContent(contentType, prefix, kind) {
  // HLS CDNs can serve image-prefixed segments as image/png or image/jpeg.
  // Keep their bytes intact, just as the playback proxy does, for the demuxer,
  // encrypted segments and playlist byte ranges. SVG and error pages still fail.
  if (
    /text\/html|application\/(?:json|javascript|xhtml|xml)|image\/svg/i.test(contentType) ||
    (kind !== 'segment' && /image\//i.test(contentType))
  )
    throw new HttpError('媒体服务器返回了网页或其他非视频内容', 422);
  if (
    kind === 'video' &&
    /^(?:text\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))/i.test(contentType)
  )
    throw new HttpError('媒体服务器未返回视频文件', 422);
  const start = prefix
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (/^(?:<!doctype|<html|<head|<body|<script|<\?xml|<svg|\{\s*["}]|\[\s*\{)/i.test(start))
    throw new HttpError('媒体服务器返回了网页或其他非视频内容', 422);
  if (kind !== 'manifest' && start.startsWith('#EXTM3U'))
    throw new HttpError('视频文件意外返回了播放列表，请重新解析', 422);
}
