import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpstream, fixtureUrl } from './fixtures/upstream.mjs';

const directory = await mkdtemp(join(tmpdir(), 'kazumi-web-e2e-'));
const fixture = await createUpstream();
const child = spawn(process.execPath, ['server/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(process.env.E2E_PORT || 4173),
    DATA_DIR: directory,
    NODE_ENV: 'test',
    METADATA_MODE: 'remote',
    ALLOW_PRIVATE_NETWORK: 'true',
    BANGUMI_API_URL: fixtureUrl,
    BANGUMI_NEXT_URL: fixtureUrl,
  },
});

let cleaning = false;
async function cleanup(code = 0) {
  if (cleaning) return;
  cleaning = true;
  child.kill('SIGTERM');
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  await rm(directory, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => cleanup());
process.on('SIGTERM', () => cleanup());
child.on('exit', (code) => cleanup(code || 0));
child.on('error', (error) => {
  console.error(error);
  cleanup(1);
});
