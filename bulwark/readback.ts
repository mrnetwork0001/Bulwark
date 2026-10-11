// npm run readback                          the latest run's failing-trial traces, read back from neatlogs
// npm run readback -- --run <runId>         …of a given run (.bulwark/runs/<runId>)
// npm run readback -- <traceId> [--seed 7]  one trace (narrowed to the trial with that seed)
//                    [--wait 30] [--json]
//
// Shows what neatlogs recorded for Bulwark's traced trials: HTTP state while pending, then the
// span digest Blue gets. Needs NEATLOGS_API_KEY.

import './env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readTrace, summarizeTrace } from './observe/neatlogs';
import type { ExperimentResult } from './scorecard';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { run: { type: 'string' }, seed: { type: 'string' }, fault: { type: 'string' }, wait: { type: 'string', default: '30' }, json: { type: 'boolean', default: false } },
  });
  if (!process.env.NEATLOGS_API_KEY) throw new Error('NEATLOGS_API_KEY is not set (put it in .env)');
  const waitMs = Number(values.wait) * 1000;

  let targets: { traceId: string; seed?: number; fault?: string; label: string }[];
  if (positionals[0]) {
    targets = [{ traceId: positionals[0], seed: values.seed ? Number(values.seed) : undefined, fault: values.fault, label: 'trace' }];
  } else {
    const dir = values.run ? join('.bulwark', 'runs', values.run) : (JSON.parse(readFileSync(join('.bulwark', 'latest.json'), 'utf8')) as { dir: string }).dir;
    const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { runId: string; before: Record<string, ExperimentResult> };
    const seen = new Set<string>();
    targets = Object.entries(s.before).flatMap(([fault, r]) =>
      r.examples.flatMap((e) => (e.traceId && !seen.has(`${e.traceId}:${e.seed}`) && seen.add(`${e.traceId}:${e.seed}`) ? [{ traceId: e.traceId, seed: e.seed, fault, label: `${fault} seed ${e.seed}` }] : [])),
    );
    console.log(`Run ${s.runId}: ${targets.length} traced failing trials in the BEFORE scorecard\n`);
  }

  for (const t of targets) {
    const res = await readTrace(t.traceId, { waitMs });
    const head = `${t.label}  trace ${t.traceId}  → ${res.status}${res.http !== undefined ? ` (HTTP ${res.http}${res.stage ? `, ${res.stage}` : ''})` : ''} after ${Math.round(res.waitedMs / 1000)}s${res.reason && res.status !== 'read' ? `: ${res.reason}` : ''}`;
    console.log(head);
    if (res.trace) console.log(values.json ? JSON.stringify(res.trace, null, 2) : summarizeTrace(res.trace, { focus: t.seed !== undefined ? { seed: t.seed, fault: t.fault } : undefined }));
    console.log();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
