import { init, shutdown } from 'neatlogs';

// Traces go to neatlogs when NEATLOGS_API_KEY is set; otherwise spans are still
// created locally but not exported, so everything runs offline.
export async function initTracing(workflowName: string): Promise<boolean> {
  const exporting = Boolean(process.env.NEATLOGS_API_KEY);
  await init({
    apiKey: process.env.NEATLOGS_API_KEY,
    workflowName,
    tags: ['bulwark', 'neatHack'],
    disableExport: !exporting,
  });
  return exporting;
}

export const shutdownTracing = shutdown;
