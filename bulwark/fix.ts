// npm run fix -- [--target targets/refundbot|targets/researchbot] [--fault <id>|all] [--fixer auto|playbook|claude] [--red-trials 20]
//                [--judge-trials 40] [--seed 42] [--max-attempts 4] [--no-memory] [--apply] [--pr] [--generated]
//                [--slo 0.99[,<fault>=0.999]] [--slo-confidence 0.95] [--max-slo-trials 1000]
//                [--max-latency-overhead 50%] [--max-step-overhead 2] [--max-cost-overhead 20%] [--overhead-policy reject|flag]
//                [--tournament claude-sonnet-5,deepseek-v4-flash | playbook,playbook-strong]
//                [--neatlogs-wait 20]  seconds Blue waits for a failing trial's neatlogs trace (0 = don't read back)
//
// The full loop: attack, fix, verify, prove. Writes artifacts to .bulwark/runs/<id>/.

import './env';
import { parseArgs } from 'node:util';
import { usd } from './cost/meter';
import { registerFaults } from './chaos/faults';
import { loadGeneratedFaults } from './red/generate';
import { fixedWithOverhead } from './judge/judge';
import { describeOverhead, parsePercent, type OverheadBudgets } from './judge/overhead';
import { DEFAULT_MAX_SLO_TRIALS, DEFAULT_SLO_CONFIDENCE, describePlan, fmtRate, parseSlo } from './judge/slo';
import { parseTournament } from './judge/tournament';
import { applyAsBranch, DEFAULT_LOOP, openPullRequest, runLoop, type LoopEvent } from './loop/orchestrator';
import { describeObserve } from './observe/evidence';
import { summarizeProvenance } from './provenance/entire';
import { describeBlast } from './red/graph';
import { money } from './risk';
import { loadTarget, resolveTargetDir } from './target';
import { initTracing, shutdownTracing } from './tracing';
import { relative } from 'node:path';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

let allPassAfter = true;

function print(e: LoopEvent) {
  switch (e.type) {
    case 'run-start':
      return console.log(c.bold(`Bulwark loop → ${e.target}`) + c.dim(` | fixer ${e.fixer} | red ${e.redTrials} trials, judge ${e.judgeTrials} trials | run ${e.runId}\n`));
    case 'analyze':
      console.log(c.red('RED') + ` found ${e.findings.length} weak links:`);
      for (const f of e.findings) {
        console.log(`  ${f.severity === 'high' ? c.red('high') : c.yellow('med ')}  ${f.file}:${f.line}  ${f.why}`);
        if (f.blast) console.log(c.dim(`        blast radius (Entire Graph): ${describeBlast(f.blast)}`));
      }
      for (const line of summarizeProvenance(e.provenance ?? [])) console.log(c.dim(`  provenance: ${line}`));
      return console.log();
    case 'scorecard': {
      if (e.phase === 'after') allPassAfter = e.results.every((r) => r.passed === r.trials);
      const label = e.phase === 'before' ? c.red('RED') + ' scorecard (before)' : c.bold('Scorecard after fixes');
      console.log(`${label}: overall ${pct(e.overall)} of trials kept every rule`);
      for (const r of e.results) {
        const risk = r.dollarsAtRisk ? c.dim(`  ${money(r.dollarsAtRisk.per1kTickets)} at risk / 1k tickets`) : '';
        console.log(`  ${r.fault.padEnd(22)} ${(r.passed === r.trials ? c.green : c.red)(`${r.passed}/${r.trials}`.padEnd(6))}${risk}`);
      }
      return console.log();
    }
    case 'fault-start':
      return console.log(c.bold(`▶ ${e.fault}`) + c.dim(`  ${e.hypothesis}`));
    case 'observe': {
      const tag = e.status === 'read' ? c.green('read') : e.status === 'pending' ? c.yellow('pending') : c.dim('unavailable');
      return console.log(`  ${c.dim('OBSERVE')} neatlogs ${tag}: ${c.dim(describeObserve(e))}`);
    }
    case 'fault-skip':
      return console.log(c.dim(`  skipped: ${e.reason}`));
    case 'checkpoint':
      return console.log(c.dim(`  ${e.action === 'save' ? '⎘ checkpoint' : '↺ rolled back to'} ${e.id}`));
    case 'slo-plan':
      console.log(c.bold(`SLO plan`) + c.dim(` (${fmtRate(e.confidence)} confidence, ${e.method})`));
      for (const p of e.plans) console.log(`  ${describePlan(p)}`);
      return console.log();
    case 'attempt':
      return console.log(`  ${c.blue('BLUE')} ${e.round ? `round ${e.round} candidate` : 'attempt'} ${e.n}: ${e.title} ${c.dim(`(${e.strategy}, ${e.author}, +${e.added}/-${e.removed})`)}`);
    case 'verdict': {
      const tag =
        e.status === 'fixed' ? (fixedWithOverhead(e) ? c.yellow('FIXED WITH OVERHEAD') : c.green('FIXED')) : e.status === 'inconclusive' ? c.yellow('INCONCLUSIVE') : c.red('REJECTED');
      console.log(`  ${c.yellow('JUDGE')} ${tag} ${e.reasons.join('; ')}`);
      if (e.overhead) console.log(c.dim(`        overhead: ${describeOverhead(e.overhead)}`));
      return;
    }
    case 'tournament': {
      console.log(`  ${c.bold('TOURNAMENT')} round ${e.round}: ${e.winner ? c.green(`${e.winner} wins`) : c.red('no winner')}`);
      for (const r of e.ranking) console.log(`    ${r.rank}. ${r.entrant.padEnd(18)} ${(r.strategy ?? '—').padEnd(26)} ${r.outcome === 'winner' ? c.green(r.outcome) : c.dim(r.outcome)}: ${r.reason}`);
      return;
    }
    case 'mutation':
      return console.log(`  ${c.dim('GUARD')} regression test without fix ${e.unfixedPassed}/${e.trials}, with fix ${e.fixedPassed}/${e.trials} ${e.ok ? c.green('✓ proven') : c.red('✗ not proven')}`);
    case 'fault-done':
      return console.log();
    case 'residual':
      if (e.findings.length === 0) return console.log(c.green('No weak links remain in the final code.\n'));
      console.log(c.yellow(`Remaining risk (${e.findings.length}):`) + (allPassAfter ? ' every attack passes, but the analyzer still sees:' : ' the analyzer still sees:'));
      for (const f of e.findings) console.log(`  ${f.file}:${f.line}  ${f.why}`);
      return console.log();
    case 'log':
      return console.log(c.dim(`  ${e.message}`));
    case 'run-done': {
      const s = e.summary;
      console.log(c.bold(`Resilience ${pct(s.overallBefore)} → ${pct(s.overallAfter)}`) + `  fixed ${s.fixed.length}, unfixed ${s.unfixed.length}, skipped ${s.skipped.length} · ${s.attempts} attempts, ${s.rollbacks} rollbacks`);
      if (s.cost) {
        const k = s.cost;
        console.log(`Run cost ${c.bold(usd(k.totalUsd))}` + c.dim(` = LLM ${usd(k.llmUsd)} (${k.calls} calls, ${k.inputTokens + k.outputTokens} tokens) + compute ${usd(k.computeUsd)} (${Math.round(k.wallMs / 1000)}s) · ${k.trials} trials`));
      }
      return console.log(c.dim(`Artifacts: ${s.dir}/ (fix.patch, PR.md, postmortem-*.md, badge.svg, summary.json)`));
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
      generated: { type: 'boolean', default: false },
      slo: { type: 'string' },
      'slo-confidence': { type: 'string', default: String(DEFAULT_SLO_CONFIDENCE) },
      'max-slo-trials': { type: 'string', default: String(DEFAULT_MAX_SLO_TRIALS) },
      'max-latency-overhead': { type: 'string' },
      'max-step-overhead': { type: 'string' },
      'max-cost-overhead': { type: 'string' },
      'overhead-policy': { type: 'string', default: 'reject' },
      tournament: { type: 'string' },
      'neatlogs-wait': { type: 'string' },
    },
  });
  // Generative Red's accepted faults join the catalog, so Red, Blue, Judge and Guard all see them.
  const targetDir = relative(process.cwd(), resolveTargetDir(values.target));
  if (values.generated) {
    const target = await loadTarget(targetDir);
    registerFaults(loadGeneratedFaults(undefined, target), target);
  }
  const slo = values.slo ? parseSlo(values.slo, Number(values['slo-confidence']), Number(values['max-slo-trials'])) : undefined;
  const policy = values['overhead-policy'] as 'reject' | 'flag';
  if (!['reject', 'flag'].includes(policy)) throw new Error('--overhead-policy must be reject or flag');
  const budgets: OverheadBudgets = {
    policy,
    ...(values['max-latency-overhead'] ? { maxLatencyOverhead: parsePercent(values['max-latency-overhead']) } : {}),
    ...(values['max-step-overhead'] ? { maxStepOverhead: Number(values['max-step-overhead']) } : {}),
    ...(values['max-cost-overhead'] ? { maxCostOverhead: parsePercent(values['max-cost-overhead']) } : {}),
  };
  if (budgets.maxStepOverhead !== undefined && !(budgets.maxStepOverhead >= 0)) throw new Error('--max-step-overhead must be a number of steps, e.g. 2');
  const tournament = values.tournament ? parseTournament(values.tournament) : undefined;
  const fixer = values.fixer as 'auto' | 'playbook' | 'claude';
  if (!['auto', 'playbook', 'claude'].includes(fixer)) throw new Error('--fixer must be auto, playbook or claude');

  await initTracing('bulwark-loop');
  const summary = await runLoop(
    {
      targetDir,
      faults: values.fault === 'all' ? 'all' : values.fault!.split(','),
      fixer,
      redTrials: Number(values['red-trials']),
      judgeTrials: Number(values['judge-trials']),
      seed: Number(values.seed),
      maxAttempts: Number(values['max-attempts']),
      memory: !values['no-memory'],
      slo,
      budgets,
      tournament,
      ...(values['neatlogs-wait'] !== undefined ? { readbackWaitMs: Number(values['neatlogs-wait']) * 1000 } : {}),
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
