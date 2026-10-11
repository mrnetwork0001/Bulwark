// npm run fix -- [--fault <id>|all] [--fixer auto|playbook|claude] [--red-trials 20]
//                [--judge-trials 40] [--seed 42] [--max-attempts 4] [--no-memory] [--apply] [--pr]
//
// The full loop: attack, fix, verify, prove. Writes artifacts to .bulwark/runs/<id>/.

import './env';
import { parseArgs } from 'node:util';
import { applyAsBranch, DEFAULT_LOOP, openPullRequest, runLoop, type LoopEvent } from './loop/orchestrator';
import { summarizeProvenance } from './provenance/entire';
import { initTracing, shutdownTracing } from './tracing';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

function print(e: LoopEvent) {
  switch (e.type) {
    case 'run-start':
      return console.log(c.bold(`Bulwark loop → ${e.target}`) + c.dim(` | fixer ${e.fixer} | red ${e.redTrials} trials, judge ${e.judgeTrials} trials | run ${e.runId}\n`));
    case 'analyze':
      console.log(c.red('RED') + ` found ${e.findings.length} weak links:`);
      for (const f of e.findings) console.log(`  ${f.severity === 'high' ? c.red('high') : c.yellow('med ')}  ${f.file}:${f.line}  ${f.why}`);
      for (const line of summarizeProvenance(e.provenance ?? [])) console.log(c.dim(`  provenance: ${line}`));
      return console.log();
    case 'scorecard': {
      const label = e.phase === 'before' ? c.red('RED') + ' scorecard (before)' : c.bold('Scorecard after fixes');
      console.log(`${label}: overall ${pct(e.overall)} of trials kept every rule`);
      for (const r of e.results) console.log(`  ${r.fault.padEnd(22)} ${(r.passed === r.trials ? c.green : c.red)(`${r.passed}/${r.trials}`)}`);
      return console.log();
    }
    case 'fault-start':
      return console.log(c.bold(`▶ ${e.fault}`) + c.dim(`  ${e.hypothesis}`));
    case 'fault-skip':
      return console.log(c.dim(`  skipped: ${e.reason}`));
    case 'checkpoint':
      return console.log(c.dim(`  ${e.action === 'save' ? '⎘ checkpoint' : '↺ rolled back to'} ${e.id}`));
    case 'attempt':
      return console.log(`  ${c.blue('BLUE')} attempt ${e.n}: ${e.title} ${c.dim(`(${e.strategy}, ${e.author}, +${e.added}/-${e.removed})`)}`);
    case 'verdict': {
      const tag = e.status === 'fixed' ? c.green('FIXED') : e.status === 'inconclusive' ? c.yellow('INCONCLUSIVE') : c.red('REJECTED');
      return console.log(`  ${c.yellow('JUDGE')} ${tag} ${e.reasons.join('; ')}`);
    }
    case 'mutation':
      return console.log(`  ${c.dim('GUARD')} regression test without fix ${e.unfixedPassed}/${e.trials}, with fix ${e.fixedPassed}/${e.trials} ${e.ok ? c.green('✓ proven') : c.red('✗ not proven')}`);
    case 'fault-done':
      return console.log();
    case 'residual':
      if (e.findings.length === 0) return console.log(c.green('No weak links remain in the final code.\n'));
      console.log(c.yellow(`Remaining risk (${e.findings.length}):`) + ' every attack passes, but the analyzer still sees:');
      for (const f of e.findings) console.log(`  ${f.file}:${f.line}  ${f.why}`);
      return console.log();
    case 'log':
      return console.log(c.dim(`  ${e.message}`));
    case 'run-done': {
      const s = e.summary;
      console.log(c.bold(`Resilience ${pct(s.overallBefore)} → ${pct(s.overallAfter)}`) + `  fixed ${s.fixed.length}, unfixed ${s.unfixed.length}, skipped ${s.skipped.length} · ${s.attempts} attempts, ${s.rollbacks} rollbacks`);
      return console.log(c.dim(`Artifacts: ${s.dir}/ (fix.patch, PR.md, postmortem-*.md, badge.svg)`));
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      fault: { type: 'string', default: 'all' },
      fixer: { type: 'string', default: DEFAULT_LOOP.fixer },
      'red-trials': { type: 'string', default: String(DEFAULT_LOOP.redTrials) },
      'judge-trials': { type: 'string', default: String(DEFAULT_LOOP.judgeTrials) },
      seed: { type: 'string', default: String(DEFAULT_LOOP.seed) },
      'max-attempts': { type: 'string', default: String(DEFAULT_LOOP.maxAttempts) },
      'no-memory': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      pr: { type: 'boolean', default: false },
      target: { type: 'string', default: 'targets/refundbot' },
    },
  });
  const fixer = values.fixer as 'auto' | 'playbook' | 'claude';
  if (!['auto', 'playbook', 'claude'].includes(fixer)) throw new Error('--fixer must be auto, playbook or claude');

  await initTracing('bulwark-loop');
  const summary = await runLoop(
    {
      targetDir: values.target!,
      faults: values.fault === 'all' ? 'all' : values.fault!.split(','),
      fixer,
      redTrials: Number(values['red-trials']),
      judgeTrials: Number(values['judge-trials']),
      seed: Number(values.seed),
      maxAttempts: Number(values['max-attempts']),
      memory: !values['no-memory'],
    },
    print,
  );

  if ((values.apply || values.pr) && summary.fixed.length) {
    const branch = applyAsBranch(summary);
    console.log(c.green(`Committed verified fixes to branch ${branch}`));
    if (values.pr) console.log(c.green(`Opened ${openPullRequest(branch, summary)}`));
  }
  await shutdownTracing();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
