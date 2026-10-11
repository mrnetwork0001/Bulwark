// npm run diff -- --fault timeout-after-commit --seed <n> --run <runId> [--ws <label>] [--target refundbot] [--state .bulwark] [--json]
//
// Replays one seed against the original code and against the run's accepted fix for that fault
// (workspace .bulwark/runs/<runId>/ws/<fault>-accepted unless --ws says otherwise), then prints the
// two timelines side by side with the point of divergence marked (▶).

import { parseArgs } from 'node:util';
import { diffFromParams, renderDiffText } from './diff';

async function main() {
  const { values } = parseArgs({
    options: {
      fault: { type: 'string', default: 'timeout-after-commit' },
      seed: { type: 'string' },
      run: { type: 'string' },
      ws: { type: 'string' },
      target: { type: 'string' },
      state: { type: 'string', default: '.bulwark' },
      width: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (!values.seed || !values.run) throw new Error('--seed and --run are required (a failing seed from the run\'s BEFORE scorecard, and the run id)');
  const params = new URLSearchParams();
  for (const k of ['fault', 'seed', 'run', 'ws', 'target'] as const) if (values[k]) params.set(k, values[k]!);

  const r = await diffFromParams(params, values.state);
  if (values.json) return console.log(JSON.stringify(r, null, 2));

  const verdict = (x: typeof r.before) => `${x.observation.outcome}, ${x.broken.length ? `${x.broken.length} rule${x.broken.length > 1 ? 's' : ''} broken` : 'every rule held'}`;
  console.log(`Trace diff ${r.fault} · seed ${r.seed} · run ${r.run}`);
  console.log(`  before: ${verdict(r.before)}    after: ${verdict(r.after)}`);
  console.log(`  ${r.diff.counts.same} same · ${r.diff.counts.changed} changed · ${r.diff.counts['only-before']} only before · ${r.diff.counts['only-after']} only after\n`);
  console.log(renderDiffText(r, Number(values.width) || process.stdout.columns || 170));
  console.log(`\n▶ ${r.diff.explanation}`);
  for (const b of r.before.broken) console.log(`  before ✗ ${b.rule} (${b.detail ?? ''})`);
  for (const b of r.after.broken) console.log(`  after  ✗ ${b.rule} (${b.detail ?? ''})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
