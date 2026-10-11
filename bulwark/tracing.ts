import { AsyncLocalStorage } from 'node:async_hooks';
import { init, shutdown } from 'neatlogs';

// Traces go to neatlogs when NEATLOGS_API_KEY is set; otherwise spans are still
// created locally but not exported, so everything runs offline.
//
// A full Bulwark loop runs thousands of trials. Exporting every tool call of
// every trial would overflow the SDK's export queue (it silently drops spans
// past ~2k) and bury the phase traces that matter. So each experiment traces a
// sample of trials in full; the rest run inside `untraced()` and their spans are
// dropped by the mask below. Experiment-level results are always traced.
const quiet = new AsyncLocalStorage<boolean>();

export function untraced<T>(fn: () => Promise<T>): Promise<T> {
  return quiet.run(true, fn);
}

let exportingNow = false;

/** True once initTracing() has set up export to neatlogs, so trace ids name traces neatlogs will have. */
export const isExporting = () => exportingNow;

export async function initTracing(workflowName: string): Promise<boolean> {
  const exporting = Boolean(process.env.NEATLOGS_API_KEY);
  exportingNow = exporting;
  await init({
    apiKey: process.env.NEATLOGS_API_KEY,
    workflowName,
    tags: ['bulwark', 'neatHack'],
    disableExport: !exporting,
    ...(process.env.NEATLOGS_ENDPOINT ? { endpoint: process.env.NEATLOGS_ENDPOINT } : {}),
    batchSize: 512,
    mask: (span) => (quiet.getStore() ? null : span),
  });
  return exporting;
}

export const shutdownTracing = shutdown;
