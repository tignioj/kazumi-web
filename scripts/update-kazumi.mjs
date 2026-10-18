import { appendFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  applyUpdate,
  discoverUpdate,
  readPinnedKazumi,
  upgradeBody,
  verifyPins,
} from './lib/kazumi-upstream.mjs';

const { values } = parseArgs({
  options: {
    write: { type: 'boolean' },
    verify: { type: 'boolean' },
    'expected-commit': { type: 'string' },
  },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const pins = await readPinnedKazumi(root);
verifyPins(pins);
if (values.verify) {
  if (values['expected-commit'] && pins.ref !== values['expected-commit'])
    throw new Error('Existing upgrade branch pins a different Kazumi commit');
  console.log(`Verified Kazumi ${pins.version} at ${pins.ref}, Flutter ${pins.sdk.version}`);
} else {
  const update = await discoverUpdate(pins);
  if (values.write && update.available) await applyUpdate(root, pins, update);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `available=${update.available}\n`);
    if (update.available) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `branch=${update.branch}\nversion=${update.version}\ncommit=${update.commit}\n`,
      );
      await writeFile(`${process.env.RUNNER_TEMP}/kazumi-upgrade-body.md`, upgradeBody(update));
    }
  }
  console.log(JSON.stringify(update, null, 2));
}
