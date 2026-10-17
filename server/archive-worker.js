import { parentPort, workerData } from 'node:worker_threads';
import { importArchive } from './archive-import.js';

try {
  const counts = await importArchive({
    ...workerData,
    progress: (value) => parentPort.postMessage({ progress: value }),
  });
  parentPort.postMessage({ result: counts });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
