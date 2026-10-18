import { createHash } from 'node:crypto';

export const fingerprint = (value) => createHash('sha256').update(value).digest('hex');

// Wait for every writer to stop before the caller persists or removes files.
export async function parallel(job, items, threads, work) {
  let next = 0;
  let failure;
  const workers = Array.from({ length: Math.min(threads, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        job.controller.signal.throwIfAborted();
        await work(item);
      } catch (error) {
        failure ||= error;
        job.transferController.abort();
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}
