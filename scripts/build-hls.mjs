import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = JSON.parse(await readFile(join(root, 'native/hls/upstream.json')));
const build = join(tmpdir(), `kazumi-hls-${upstream.ffmpegRevision}`);
const source = join(build, 'source');
const output = join(root, 'bin');
await mkdir(source, { recursive: true });
await mkdir(output, { recursive: true });

async function download(name, url, sha256) {
  const path = join(build, name);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {}
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error(`Checksum mismatch: ${name}`);
    await writeFile(path, bytes);
  }
  return path;
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: source, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

const archive = await download('ffmpeg.tar.gz', upstream.sourceUrl, upstream.sourceSha256);
const patch = await download('kazumi.patch', upstream.patchUrl, upstream.patchSha256);
try {
  await access(join(source, '.kazumi-patched'));
} catch {
  run('tar', ['-xzf', archive, '--strip-components=1']);
  // Apply the upstream patch verbatim. No local copy or ad-detection code.
  run('patch', ['-p1', '-i', patch]);
  await writeFile(join(source, '.kazumi-patched'), upstream.patchSha256);
}
run('./configure', [
  '--disable-autodetect',
  '--disable-doc',
  '--disable-debug',
  '--disable-x86asm',
  '--disable-everything',
  '--disable-ffplay',
  '--enable-ffmpeg',
  '--enable-ffprobe',
  '--enable-protocol=file,http,tcp,crypto,pipe',
  '--enable-demuxer=hls,mpegts,mov,matroska,aac,mp3,ogg',
  '--enable-muxer=mp4,mpegts,null',
  '--enable-parser=aac,h264,hevc,mpegaudio,opus,av1,vp9',
  '--enable-decoder=h264,hevc,aac,mp3,opus,av1,vp9',
  '--enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata',
  '--enable-filter=null,anull,aresample',
]);
run('make', [`-j${Math.min(availableParallelism(), 8)}`, 'ffmpeg', 'ffprobe']);
for (const name of ['ffmpeg', 'ffprobe'])
  await copyFile(join(source, name), join(output, `kazumi-${name}`));
for (const name of ['COPYING.LGPLv2.1', 'COPYING.LGPLv3', 'LICENSE.md'])
  await copyFile(join(source, name), join(output, `FFMPEG-${name}`));
await copyFile(join(root, 'native/hls/upstream.json'), join(output, 'hls-upstream.json'));
console.log('Built Kazumi native HLS tools (upstream PTS filter, stream copy only).');
