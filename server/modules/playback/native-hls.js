import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../../lib/http.js';

const binary = (name) =>
  process.env[`KAZUMI_${name.toUpperCase()}_PATH`] ||
  fileURLToPath(new URL(`../../../bin/kazumi-${name}`, import.meta.url));
const protocols = [
  '-protocol_whitelist',
  'http,tcp,crypto',
  '-rw_timeout',
  '20000000',
  '-analyzeduration',
  '2000000',
  '-probesize',
  '1048576',
  '-allowed_extensions',
  'ALL',
  '-allowed_segment_extensions',
  'ALL',
  '-extension_picky',
  '0',
];

// Transport adapter only: every packet decision runs inside upstream hls.c.
export class NativeHlsService {
  constructor({
    media,
    downloads,
    maxProcesses = 4,
    ffmpeg = binary('ffmpeg'),
    ffprobe = binary('ffprobe'),
  }) {
    Object.assign(this, { media, downloads, maxProcesses, ffmpeg, ffprobe });
    this.children = new Set();
    this.metadata = new Map();
  }

  input(req) {
    const path = req.query.source;
    if (typeof path !== 'string' || path.length > 48000)
      throw new HttpError('原生播放来源无效', 400);
    let source;
    try {
      source = new URL(path, 'http://native.invalid');
    } catch {
      throw new HttpError('原生播放来源无效', 400);
    }
    if (source.origin !== 'http://native.invalid' || source.hash)
      throw new HttpError('原生播放来源无效', 400);
    if (source.pathname === '/api/media') {
      const data = this.media.verify(
        source.searchParams.get('payload'),
        source.searchParams.get('signature'),
      );
      if (data.kind !== 'hls' || data.adBlocker !== true)
        throw new HttpError('当前来源未启用原生 HLS 过滤', 400);
      if (data.sessionId) this.media.sessions.get(data.sessionId);
    } else {
      const match = /^\/api\/downloads\/([a-f0-9-]{36})\/files\/([^/]+)$/.exec(source.pathname);
      if (!match || source.search) throw new HttpError('原生播放来源无效', 400);
      const job = this.downloads.ready(match[1]);
      if (job.type !== 'hls' || !job.adBlocker || match[2] !== job.mainFile)
        throw new HttpError('当前缓存未启用原生 HLS 过滤', 400);
    }
    // Never use the client-controlled Host header or send FFmpeg to an upstream.
    const address = req.socket.localAddress;
    const host = address.includes(':') ? `[${address}]` : address;
    return `http://${host}:${req.socket.localPort}${source.pathname}${source.search}`;
  }

  start(command, args, signal) {
    signal?.throwIfAborted();
    if (this.children.size >= this.maxProcesses)
      throw new HttpError('正在播放的视频较多，请稍后重试', 503);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    let diagnostic = '';
    child.stderr.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-8000);
    });
    const stop = () => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    };
    signal?.addEventListener('abort', stop, { once: true });
    const done = new Promise((resolve, reject) => {
      child.once('error', () =>
        reject(new HttpError('原生播放工具不可用，请先运行 npm run build:hls', 503)),
      );
      child.once('close', (code) => {
        this.children.delete(child);
        signal?.removeEventListener('abort', stop);
        if (signal?.aborted) reject(signal.reason);
        else if (code !== 0)
          reject(
            new HttpError(
              /hls_ad_filter/.test(diagnostic) &&
                /not found|Unrecognized option|Option not found/i.test(diagnostic)
                ? '当前 FFmpeg 不包含 Kazumi 官方 HLS 补丁，请重新构建原生播放工具'
                : '原生视频处理失败，请重新解析或切换线路',
              502,
            ),
          );
        else resolve();
      });
    });
    // Register a rejection handler immediately, including while stdout is read.
    done.catch(() => {});
    return { child, done, stop };
  }

  async info(input, signal) {
    const cached = this.metadata.get(input);
    if (cached && cached.expires > Date.now()) return cached.value;
    const { child, done, stop } = this.start(
      this.ffprobe,
      [
        '-v',
        'error',
        ...protocols,
        '-allowed_extensions',
        'ALL',
        '-hls_ad_filter',
        '1',
        '-show_entries',
        'format=duration:stream=codec_type,codec_name',
        '-of',
        'json',
        input,
      ],
      signal,
    );
    let output = '';
    const deadline = setTimeout(stop, 20000);
    try {
      for await (const chunk of child.stdout) {
        output += chunk;
        if (output.length > 65536) throw new HttpError('视频信息过大', 502);
      }
      await done;
      const { format, streams } = JSON.parse(output);
      const duration = Number(format?.duration);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new HttpError('当前来源没有有效的点播时长', 422);
      const value = {
        duration,
        audioCodec: streams?.find((stream) => stream.codec_type === 'audio')?.codec_name,
      };
      if (this.metadata.size >= 128) this.metadata.delete(this.metadata.keys().next().value);
      this.metadata.set(input, { expires: Date.now() + 300000, value });
      return value;
    } finally {
      clearTimeout(deadline);
      stop();
    }
  }

  async stream(input, start, res, signal) {
    const info = await this.info(input, signal);
    if (start >= info.duration) throw new HttpError('播放位置超出视频时长', 400);
    const { child, done, stop } = this.start(
      this.ffmpeg,
      [
        '-v',
        'error',
        '-nostdin',
        ...protocols,
        '-allowed_extensions',
        'ALL',
        '-hls_ad_filter',
        '1',
        '-seg_max_retry',
        '5',
        ...(start > 0 ? ['-ss', String(start)] : []),
        '-i',
        input,
        '-copyts',
        '-start_at_zero',
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        ...(info.audioCodec === 'aac' ? ['-bsf:a', 'aac_adtstoasc'] : []),
        '-movflags',
        'frag_keyframe+delay_moov+default_base_moof+frag_discont',
        '-use_editlist',
        '0',
        '-avoid_negative_ts',
        'make_non_negative',
        '-frag_duration',
        '1000000',
        '-flush_packets',
        '1',
        '-f',
        'mp4',
        'pipe:1',
      ],
      signal,
    );
    try {
      // Wait for actual media so launch/probe failures retain a JSON HTTP error.
      const ready = await Promise.race([
        once(child.stdout, 'readable').then(() => child.stdout.readableLength > 0),
        done.then(() => false),
      ]);
      if (!ready) throw new HttpError('来源没有可播放的视频包', 422);
      res.type('video/mp4').set('Cache-Control', 'no-store');
      await pipeline(child.stdout, res, { signal });
      await done;
    } finally {
      stop();
    }
  }

  close() {
    for (const child of this.children) child.kill('SIGKILL');
    this.metadata.clear();
  }
}

export function registerNativeHlsRoutes(app, { nativeHls }) {
  for (const action of ['info', 'stream'])
    app.get(`/api/native-media/${action}`, async (req, res) => {
      const input = nativeHls.input(req);
      const start = Number(req.query.start || 0);
      if (!Number.isFinite(start) || start < 0 || start > 7 * 24 * 3600)
        throw new HttpError('播放位置无效', 400);
      const controller = new AbortController();
      const abort = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once('close', abort);
      try {
        if (action === 'info')
          res.set('Cache-Control', 'no-store').json(await nativeHls.info(input, controller.signal));
        else await nativeHls.stream(input, start, res, controller.signal);
      } finally {
        res.off('close', abort);
      }
    });
}
