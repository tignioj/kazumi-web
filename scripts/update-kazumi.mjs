import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  applyUpdate,
  discoverUpdate,
  discoverMainUpdate,
  readPinnedKazumi,
  upgradeBody,
  upgradeTitle,
  verifyPins,
} from './lib/kazumi-upstream.mjs';
import {
  applyRulesUpdate,
  discoverRulesUpdate,
  readCatalog,
  rulesUpgradeBody,
} from './lib/kazumi-rules.mjs';

const { values } = parseArgs({
  options: {
    write: { type: 'boolean' },
    verify: { type: 'boolean' },
    'expected-commit': { type: 'string' },
    source: { type: 'string', default: 'release' },
  },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const pins = await readPinnedKazumi(root);
verifyPins(pins);
assert.ok(['release', 'main', 'rules'].includes(values.source), 'Unknown update source');
if (values.verify) {
  const commit = values.source === 'rules' ? (await readCatalog(root)).commit : pins.ref;
  if (values['expected-commit'] && commit !== values['expected-commit'])
    throw new Error('Existing upgrade branch pins a different Kazumi commit');
  console.log(
    values.source === 'rules'
      ? `Verified official rules at ${commit}`
      : `Verified Kazumi ${pins.version} at ${pins.ref}, Flutter ${pins.sdk.version}`,
  );
} else {
  const update =
    values.source === 'rules'
      ? await discoverRulesUpdate(await readCatalog(root))
      : await (values.source === 'main' ? discoverMainUpdate : discoverUpdate)(pins);
  if (values.write && update.available) {
    if (values.source === 'rules') await applyRulesUpdate(root, update);
    else await applyUpdate(root, pins, update);
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `available=${update.available}\n`);
    if (update.available) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `branch=${update.branch}\nversion=${update.version || 'catalog'}\ncommit=${update.commit}\n` +
          `title=${values.source === 'rules' ? 'chore(rules): refresh official compatibility catalog' : upgradeTitle(update)}\n`,
      );
      await writeFile(
        `${process.env.RUNNER_TEMP}/kazumi-upgrade-body.md`,
        values.source === 'rules' ? rulesUpgradeBody(update) : upgradeBody(update),
      );
    }
  }
  const { snapshot, ...summary } = update;
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### ${values.source} upstream check\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  console.log(JSON.stringify(summary, null, 2));
}
