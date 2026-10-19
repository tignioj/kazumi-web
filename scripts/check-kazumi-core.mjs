import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readPinnedKazumi, verifyPins } from './lib/kazumi-upstream.mjs';

export async function checkCore({ root, url, fetcher = fetch, timeout = 60000, interval = 1000 }) {
  const pins = await readPinnedKazumi(root);
  verifyPins(pins);
  const deadline = Date.now() + timeout;
  let health;
  let lastError;
  do {
    try {
      const response = await fetcher(new URL('/health', url), {
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200, `Core health: HTTP ${response.status}`);
      health = await response.json();
      break;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline)
        throw new Error(`Core did not become ready: ${lastError.message}`);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  } while (Date.now() < deadline);
  assert.equal(health?.status, 'ok', 'Core is not healthy');
  assert.equal(health.upstream, pins.ref, 'Running core does not match pubspec.lock');
  assert.equal(health.apiLevel, pins.apiLevel, 'Running core and Web rule API levels differ');
  return health;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const health = await checkCore({
    root: fileURLToPath(new URL('../', import.meta.url)),
    url: process.env.KAZUMI_CORE_URL || 'http://127.0.0.1:7331',
  });
  console.log(`Ready: real Kazumi core ${health.upstream}, API ${health.apiLevel}`);
}
