import { resolve } from 'node:path';
import { createHttpClient } from '../server/lib/http.js';
import { LocalMetadataStore } from '../server/modules/metadata/local-store.js';
import { ArchiveManager } from '../server/modules/metadata/archive-manager.js';
import { NetworkStore } from '../server/modules/network/store.js';
import { proxySettingsFor } from '../shared/network-settings.js';

const args = process.argv.slice(2);
const options = {};
let statusOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--status') statusOnly = true;
  else if (['--file', '--version'].includes(args[i]) && args[i + 1])
    options[args[i].slice(2)] = args[++i];
  else throw new Error(`未知参数：${args[i]}。支持 --file ZIP、--version 名称、--status。`);
}
const network = await new NetworkStore(resolve(process.env.DATA_DIR || 'data')).init();
const http = createHttpClient({
  getProxySettings: () => proxySettingsFor(network.data, 'archive'),
});
const store = await new LocalMetadataStore(
  resolve(process.env.DATA_DIR || 'data', 'metadata'),
).init();
const manager = new ArchiveManager({ store, http });
let timer;
try {
  if (statusOnly) console.log(JSON.stringify(await manager.status(), null, 2));
  else {
    timer = setInterval(() => console.log(JSON.stringify(manager.state)), 5000);
    console.log(JSON.stringify(await manager.update(options), null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await manager.close();
  store.close();
  await http.close();
}
