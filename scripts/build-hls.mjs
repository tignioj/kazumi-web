import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyFile(path, sha256) {
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new Error(`Checksum mismatch: ${path}`);
  return path;
}

async function download(path, url, sha256) {
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
      throw new Error(`Checksum mismatch: ${path}`);
    await writeFile(path, bytes);
  }
  return path;
}
function run(source, command, args) {
  const result = spawnSync(command, args, { cwd: source, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

export async function prepareSource(source, archive, patch, identity) {
  source = resolve(source);
  archive = resolve(archive);
  patch = resolve(patch);
  const marker = join(source, '.kazumi-patched');
  let previous;
  try {
    previous = await readFile(marker, 'utf8');
  } catch {}
  if (previous === identity) return;
  // A different patch or interrupted extraction must always start from clean source.
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  run(source, 'tar', ['-xzf', archive, '--strip-components=1']);
  run(source, 'patch', ['--batch', '--fuzz=0', '-p1', '-i', patch]);
  await writeFile(marker, identity);
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const upstream = JSON.parse(await readFile(join(root, 'native/hls/upstream.json')));
  // Verify the checked-in patch before any download. Never fetch a replacement.
  const patch = await verifyFile(
    join(root, 'native/hls', upstream.patchFile),
    upstream.patchSha256,
  );
  if (process.argv.includes('--verify')) {
    console.log(`Verified vendored HLS patch: ${upstream.patchSha256}`);
    return;
  }
  const identity = `${upstream.sourceSha256}:${upstream.patchSha256}`;
  const build = join(
    process.env.HLS_CACHE_DIR || tmpdir(),
    `kazumi-hls-${createHash('sha256').update(identity).digest('hex')}`,
  );
  const source = join(build, 'source');
  const output = join(root, 'bin');
  await mkdir(build, { recursive: true });
  await mkdir(output, { recursive: true });
  const archive = process.env.HLS_SOURCE_ARCHIVE
    ? await verifyFile(resolve(process.env.HLS_SOURCE_ARCHIVE), upstream.sourceSha256)
    : await download(join(build, 'ffmpeg.tar.gz'), upstream.sourceUrl, upstream.sourceSha256);
  await prepareSource(source, archive, patch, identity);
  run(source, './configure', [
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
  run(source, 'make', [`-j${Math.min(availableParallelism(), 8)}`, 'ffmpeg', 'ffprobe']);
  for (const name of ['ffmpeg', 'ffprobe'])
    await copyFile(join(source, name), join(output, `kazumi-${name}`));
  for (const name of ['COPYING.LGPLv2.1', 'COPYING.LGPLv3', 'LICENSE.md'])
    await copyFile(join(source, name), join(output, `FFMPEG-${name}`));
  await copyFile(join(root, 'native/hls/upstream.json'), join(output, 'hls-upstream.json'));
  await copyFile(patch, join(output, upstream.patchFile));
  console.log('Built Kazumi native HLS tools (upstream PTS filter, stream copy only).');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
