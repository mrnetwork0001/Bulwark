// npm run chaos -- [--fault <id>|all] [--trials 20] [--seed 42] [--brain simulated|claude]
//
// Attacks the target agent with each fault, N trials apiece, and writes a
// scorecard to runs/<timestamp>/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { target } from '../targets/refundbot/bulwark.target';
import { FAULTS, getFault, type Fault } from './chaos/faults';
import type { BrainMode } from './harness';
import { renderConsole, renderMarkdown, runExperiment, type ExperimentResult } from './scorecard';
import { initTracing, shutdownTracing } from './tracing';

async function main() {
  const { values } = parseArgs({
    options: {
      fault: { type: 'string', default: 'all' },
      trials: { type: 'string', default: '20' },
      seed: { type: 'string', default: '42' },
      brain: { type: 'string', default: 'simulated' },
      deadline: { type: 'string', default: '5000' },
      'max-steps': { type: 'string', default: '50' },
    },
  });
  const brain = values.brain as BrainMode;
  if (brain !== 'simulated' && brain !== 'claude') throw new Error('--brain must be "simulated" or "claude"');
  if (brain === 'claude' && !process.env.ANTHROPIC_API_KEY) throw new Error('--brain claude needs ANTHROPIC_API_KEY');

  const faults: (Fault | undefined)[] =
    values.fault === 'all' ? [undefined, ...FAULTS] : [undefined, getFault(values.fault!)];
  const opts = {
    trials: Number(values.trials),
    seed: Number(values.seed),
    brain,
    deadlineMs: Number(values.deadline),
    maxSteps: Number(values['max-steps']),
  };

  const exporting = await initTracing('bulwark-chaos');
  console.log(
    `Bulwark → ${target.name} | ${opts.trials} trials/fault | seed ${opts.seed} | brain ${brain} | neatlogs ${exporting ? 'exporting' : 'local only (no NEATLOGS_API_KEY)'}\n`,
  );

  const results: ExperimentResult[] = [];
  for (const fault of faults) {
    process.stdout.write(`  attacking: ${fault?.id ?? 'baseline'}… `);
    const r = await runExperiment(target, fault, opts);
    console.log(`${r.passed}/${r.trials} passed`);
    results.push(r);
  }
  console.log('\n' + renderConsole(results) + '\n');

  const dir = join('runs', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const meta = { trials: opts.trials, seed: opts.seed, brain, date: new Date().toISOString() };
  writeFileSync(join(dir, 'scorecard.json'), JSON.stringify({ target: target.name, ...meta, results }, null, 2));
  writeFileSync(join(dir, 'scorecard.md'), renderMarkdown(target, results, meta));
  console.log(`Scorecard written to ${dir}/`);

  await shutdownTracing();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
