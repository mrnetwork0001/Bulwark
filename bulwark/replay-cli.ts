// npm run replay -- --fault timeout-after-commit --seed <n> [--target refundbot] [--run <runId> --ws <label>] [--json]
//
// Re-runs one trial from its seed with the recorder on and prints its timeline.

import { parseArgs } from 'node:util';
import { describeEvent, replayFromParams } from './replay';

async function main() {
  const { values } = parseArgs({
    options: {
      fault: { type: 'string', default: 'timeout-after-commit' },
      seed: { type: 'string' },
      target: { type: 'string' },
      run: { type: 'string' },
      ws: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (!values.seed) throw new Error('--seed is required (find one in a scorecard\'s "replayable failures")');
  const params = new URLSearchParams();
  for (const k of ['fault', 'seed', 'target', 'run', 'ws'] as const) if (values[k]) params.set(k, values[k]!);

  const r = await replayFromParams(params);
  if (values.json) return console.log(JSON.stringify(r, null, 2));

  console.log(`Replay ${r.fault} · seed ${r.seed} · ${r.source}\n`);
  for (const e of r.timeline) console.log(`${String(e.t).padStart(6)}ms  ${describeEvent(e)}`);
  console.log('');
  if (r.broken.length === 0) console.log('✓ every rule held');
  for (const b of r.broken) console.log(`✗ ${b.rule}\n    ${b.detail ?? ''}\n    how it's checked: ${b.how}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
