// npm run chaos -- [--target targets/refundbot] [--fault <id>|all] [--trials 20] [--seed 42] [--brain simulated|claude]
//                  [--generated [--generated-file .bulwark/generated-faults.json]] [--game-day] [--stale] [--degrade]
//
// Attacks the target agent with each fault, N trials apiece, and writes a
// scorecard to runs/<timestamp>/.

import './env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { enablePacks, faultsFor, getFault, registerFaults, type Fault, type FaultPack } from './chaos/faults';
import { CostMeter, usd } from './cost/meter';
import { loadPriceBook } from './cost/pricing';
import { GENERATED_FAULTS_PATH, loadGeneratedFaults } from './red/generate';
import type { BrainMode } from './harness';
import { renderConsole, renderMarkdown, runExperiment, type ExperimentResult } from './scorecard';
import { llmProvider } from './llm';
import { describeRules, prepareRules } from './rules/compiler';
import { loadTarget, resolveTargetDir } from './target';
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
      generated: { type: 'boolean', default: false },
      'generated-file': { type: 'string', default: GENERATED_FAULTS_PATH },
      target: { type: 'string', default: 'targets/refundbot' },
      'game-day': { type: 'boolean', default: false },
      stale: { type: 'boolean', default: false },
      degrade: { type: 'boolean', default: false },
    },
  });
  const targetDir = resolveTargetDir(values.target!);
  const target = await loadTarget(targetDir);
  if (values.generated) {
    const added = registerFaults(loadGeneratedFaults(values['generated-file'], target), target);
    console.log(`+ ${added.filter((f) => f.spec).length} generated faults from ${values['generated-file']}`);
  }
  // Opt-in packs: game days (composite faults), stale data, model degradation.
  const packs = (['game-day', 'stale', 'degrade'] as FaultPack[]).filter((p) => values[p]);
  if (packs.length) {
    const added = enablePacks(packs, target);
    console.log(`+ ${added.length} faults from ${packs.join(', ')}: ${added.map((f) => f.id).join(', ')}`);
  }
  const brain = values.brain as BrainMode;
  if (brain !== 'simulated' && brain !== 'claude') throw new Error('--brain must be "simulated" or "claude"');
  if (brain === 'claude' && !llmProvider()) throw new Error('--brain claude needs ZG_ROUTER_API_KEY or ANTHROPIC_API_KEY');

  const faults: (Fault | undefined)[] =
    values.fault === 'all' ? [undefined, ...faultsFor(target)] : [undefined, getFault(values.fault!, target)];
  const opts = {
    trials: Number(values.trials),
    seed: Number(values.seed),
    brain,
    deadlineMs: Number(values.deadline),
    maxSteps: Number(values['max-steps']),
    sessionId: `chaos-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };

  const exporting = await initTracing('bulwark-chaos');
  console.log(
    `Bulwark → ${target.name} | ${opts.trials} trials/fault | seed ${opts.seed} | brain ${brain} | neatlogs ${exporting ? 'exporting' : 'local only (no NEATLOGS_API_KEY)'}\n`,
  );

  const results: ExperimentResult[] = [];
  const meter = new CostMeter();
  await meter.run(async () => {
    // Rules nothing else compiles go to the LLM rule compiler (cached; unchanged without a key).
    console.log('Business rules (how each one is checked):');
    for (const line of describeRules(await prepareRules(target))) console.log(`  ${line}`);
    console.log();
    for (const fault of faults) {
      process.stdout.write(`  attacking: ${fault?.id ?? 'baseline'}… `);
      const r = await runExperiment(target, fault, opts);
      console.log(`${r.passed}/${r.trials} passed`);
      results.push(r);
    }
  });
  const book = await loadPriceBook({ provider: llmProvider() });
  const cost = meter.summarize(book.priceFor, `0G router prices (${book.zgSource}); Anthropic-direct static table`);
  console.log('\n' + renderConsole(results) + '\n');
  console.log(`Cost ${usd(cost.totalUsd)} = LLM ${usd(cost.llmUsd)} (${cost.calls} calls) + compute ${usd(cost.computeUsd)} (${Math.round(cost.wallMs / 1000)}s) over ${cost.trials} trials\n`);

  const dir = join('runs', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const meta = { trials: opts.trials, seed: opts.seed, brain, date: new Date().toISOString() };
  writeFileSync(join(dir, 'scorecard.json'), JSON.stringify({ target: target.name, ...meta, results, cost }, null, 2));
  writeFileSync(join(dir, 'scorecard.md'), renderMarkdown(target, results, meta));
  console.log(`Scorecard written to ${dir}/`);

  await shutdownTracing();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
