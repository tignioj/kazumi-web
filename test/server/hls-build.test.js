import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { prepareSource, verifyFile } from '../../scripts/build-hls.mjs';

const run = promisify(execFile);
test('the vendored patch exactly matches its pinned hash and corruption is rejected', async (t) => {
  const upstream = JSON.parse(
    await readFile(new URL('../../native/hls/upstream.json', import.meta.url)),
  );
  const patch = resolve('native/hls', upstream.patchFile);
  assert.equal(await verifyFile(patch, upstream.patchSha256), patch);
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-hls-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const corrupt = join(directory, 'patch');
  await writeFile(corrupt, Buffer.concat([await readFile(patch), Buffer.from('\n')]));
  await assert.rejects(verifyFile(corrupt, upstream.patchSha256), /Checksum mismatch/);
});

test('source preparation rejects partial patches and recreates stale source when its pinned inputs change', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-hls-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageDir = join(directory, 'package');
  const source = join(directory, 'source');
  await mkdir(packageDir);
  await writeFile(join(packageDir, 'input.txt'), 'before\n');
  const archive = join(directory, 'source.tar.gz');
  await run('tar', ['-czf', archive, '-C', directory, 'package']);
  const patch = join(directory, 'patch');
  const writePatch = (text) =>
    writeFile(patch, `--- a/input.txt\n+++ b/input.txt\n@@ -1 +1 @@\n-before\n+${text}\n`);
  const identity = async () =>
    createHash('sha256')
      .update(await readFile(patch))
      .digest('hex');
  await writePatch('first');
  // Relative build-cache paths must still work after the child process changes cwd.
  await prepareSource(
    relative(process.cwd(), source),
    relative(process.cwd(), archive),
    relative(process.cwd(), patch),
    await identity(),
  );
  assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'first\n');
  await prepareSource(source, archive, patch, await identity());
  await writeFile(join(source, 'old-artifact'), 'must be removed');
  await writePatch('second');
  await prepareSource(source, archive, patch, await identity());
  assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'second\n');
  await assert.rejects(access(join(source, 'old-artifact')), { code: 'ENOENT' });
  await writeFile(patch, '--- a/input.txt\n+++ b/input.txt\n@@ -1 +1 @@\n-missing\n+invalid\n');
  await assert.rejects(prepareSource(source, archive, patch, await identity()), /patch failed/);
  await assert.rejects(access(join(source, '.kazumi-patched')), { code: 'ENOENT' });
  await writePatch('recovered');
  await prepareSource(source, archive, patch, await identity());
  assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'recovered\n');
});
