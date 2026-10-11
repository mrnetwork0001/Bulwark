// npm run self-chaos -- [--target targets/refundbot] [--plan "blue-llm=429,5xx;checkpoint=corrupt"] [--red-trials 10]
//                       [--judge-trials 20] [--fault <id>|all] [--no-control] [--out docs/evidence/07-self-chaos]
//
// Bulwark attacks itself: runs the fix loop (playbook + an offline stand-in for
// Blue's LLM, so it costs nothing) while its own dependencies fail: Blue's LLM
// (429/5xx/hang), malformed or empty proposals, corrupt or missing checkpoints,
// a patch that doesn't load, neatlogs down, worker trials that throw. Prints
// and writes a scorecard: self-faults injected N, recovered N, and the run's
// before → after next to a clean control run.

import '../env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveTargetDir } from '../target';
import { DEFAULT_PLAN, renderSelfChaos, runSelfChaos } from './run';
import { parsePlan, SelfFaults } from './faults';

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: 'targets/refundbot' },
      plan: { type: 'string' },
      fault: { type: 'string', default: 'all' },
      'red-trials': { type: 'string', default: '10' },
      'judge-trials': { type: 'string', default: '20' },
      seed: { type: 'string', default: '42' },
      'no-control': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const targetDir = relative(process.cwd(), resolveTargetDir(values.target));
  const plan = values.plan ? parsePlan(values.plan) : DEFAULT_PLAN;
  new SelfFaults(plan); // validates the plan up front; the run builds its own
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };
  log(`Bulwark self-chaos → ${targetDir} | plan ${JSON.stringify(plan)}`);

  const result = await runSelfChaos(
    {
      targetDir,
      plan,
      faults: values.fault === 'all' ? 'all' : values.fault!.split(','),
      redTrials: Number(values['red-trials']),
      judgeTrials: Number(values['judge-trials']),
      seed: Number(values.seed),
      memory: false,
      readbackWaitMs: 0,
      stateDir: join('.bulwark', 'self-chaos'),
      control: !values['no-control'],
    },
    (e) => {
      if (e.type === 'self-fault') log(`  SELF-FAULT ${e.seam}: ${e.fault} → ${e.recovered ? 'recovered' : 'NOT recovered'}: ${e.how}`);
      else if (e.type === 'fault-start') log(`▶ ${e.fault}`);
      else if (e.type === 'attempt') log(`  BLUE attempt ${e.n}: ${e.strategy} (${e.author})`);
      else if (e.type === 'verdict') log(`  JUDGE ${e.status.toUpperCase()} ${e.reasons[0] ?? ''}`);
      else if (e.type === 'checkpoint' && e.action === 'restore') log(`  ↺ rolled back to ${e.id}`);
      else if (e.type === 'scorecard') log(`${e.phase === 'before' ? 'BEFORE' : 'AFTER'}: ${Math.round(e.overall * 100)}% of trials kept every rule`);
    },
  );

  const md = renderSelfChaos(result, { 'red trials': values['red-trials'], 'judge trials': values['judge-trials'], seed: values.seed });
  console.log('\n' + md);
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'scorecard.md'), md);
    writeFileSync(join(values.out, 'console.txt'), lines.join('\n') + '\n');
    const { finalFiles: _f, ...summary } = result.summary;
    const { finalFiles: _c, ...control } = result.control ?? ({} as typeof result.summary);
    writeFileSync(
      join(values.out, 'result.json'),
      JSON.stringify({ plan, totals: result.totals, seams: result.seams, injected: result.injected, notInjected: result.notInjected, events: result.events, organic: result.organic, summary, ...(result.control ? { control } : {}) }, null, 2) + '\n',
    );
    console.log(`Evidence written to ${values.out}/`);
  }
  if (result.totals.recovered < result.totals.injected) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
