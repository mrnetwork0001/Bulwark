// Runs N trials per fault and turns them into an honest scorecard: pass rates
// with 95% confidence intervals, outcome breakdowns, and which rules broke.

import { trace } from 'neatlogs';
import type { Fault } from './chaos/faults';
import { runTrial, type BrainMode, type Outcome, type TrialObservation } from './harness';
import { compileRules } from './invariants';
import { hashSeed, percentile, wilson } from './stats';
import type { BulwarkTarget } from './target';

export interface ExperimentResult {
  fault: string;
  title: string;
  hypothesis: string;
  trials: number;
  passed: number;
  passRate: number;
  ci95: [number, number];
  outcomes: Record<Outcome, number>;
  violations: Record<string, number>;
  p95Ms: number;
  /** One failing trial per broken rule, so a human can replay it from its seed. */
  examples: { rule: string; seed: number; detail?: string }[];
  /** Every trial in index order, so any one can be replayed from its seed (the dashboard's squares). */
  perTrial: { seed: number; outcome: Outcome; passed: boolean }[];
}

export interface ExperimentOptions {
  trials: number;
  seed: number;
  brain: BrainMode;
  deadlineMs: number;
  maxSteps: number;
  /** How many trials per experiment export full detail to neatlogs (default 2). */
  traceSample?: number;
  /** Groups this experiment's trace into a neatlogs session (one per CLI/dashboard run). */
  sessionId?: string;
  /** Called as each trial finishes, for live views. */
  onTrial?: (t: { index: number; obs: TrialObservation; broken: BrokenRule[] }) => void;
}

export interface BrokenRule {
  rule: string;
  detail?: string;
}

export async function runExperiment(
  target: BulwarkTarget,
  fault: Fault | undefined,
  opts: ExperimentOptions,
): Promise<ExperimentResult> {
  const faultId = fault?.id ?? 'baseline';
  const { compiled, uncompiled } = compileRules(target.rules);
  if (uncompiled.length) throw new Error(`could not compile rules: ${uncompiled.join(' | ')}`);

  return trace(
    {
      name: `experiment: ${faultId}`,
      kind: 'WORKFLOW',
      ...(opts.sessionId ? { sessionId: opts.sessionId, sessionFeatureName: 'bulwark-chaos' } : {}),
      attributes: { target: target.name, fault: faultId, trials: opts.trials, seed: opts.seed },
    },
    async () => {
      const outcomes: Record<Outcome, number> = { completed: 0, crashed: 0, hung: 0, runaway: 0 };
      const violations: Record<string, number> = Object.fromEntries(compiled.map((c) => [c.rule, 0]));
      const examples: ExperimentResult['examples'] = [];
      const perTrial: ExperimentResult['perTrial'] = [];
      let passed = 0;

      const observations: TrialObservation[] = await Promise.all(
        Array.from({ length: opts.trials }, async (_, i) => {
          const obs = await runTrial({
            target,
            fault,
            seed: hashSeed(opts.seed, faultId, i),
            brain: opts.brain,
            deadlineMs: opts.deadlineMs,
            maxSteps: opts.maxSteps,
            traced: i < (opts.traceSample ?? Number(process.env.BULWARK_TRACE_SAMPLE ?? 2)),
          });
          outcomes[obs.outcome]++;
          const broken: BrokenRule[] = [];
          for (const { rule, check } of compiled) {
            const res = check(obs);
            if (res.ok) continue;
            broken.push({ rule, detail: res.detail });
            violations[rule]++;
            if (!examples.some((e) => e.rule === rule)) examples.push({ rule, seed: obs.seed, detail: res.detail });
          }
          if (broken.length === 0) passed++;
          perTrial[i] = { seed: obs.seed, outcome: obs.outcome, passed: broken.length === 0 };
          opts.onTrial?.({ index: i, obs, broken });
          return obs;
        }),
      );

      return {
        fault: faultId,
        title: fault?.title ?? 'No fault injected',
        hypothesis: fault?.hypothesis ?? 'The agent works when nothing breaks.',
        trials: opts.trials,
        passed,
        passRate: passed / opts.trials,
        ci95: wilson(passed, opts.trials),
        outcomes,
        violations,
        p95Ms: percentile(observations.map((o) => o.durationMs), 95),
        examples,
        perTrial,
      };
    },
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function renderMarkdown(target: BulwarkTarget, results: ExperimentResult[], meta: Record<string, unknown>): string {
  const lines = [
    `# Bulwark scorecard: ${target.name}`,
    '',
    Object.entries(meta)
      .map(([k, v]) => `**${k}**: ${v}`)
      .join(' · '),
    '',
    '| Fault | Pass | 95% CI | Crashed | Hung | Runaway | p95 | Broken rules |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const broken = Object.entries(r.violations)
      .filter(([, n]) => n > 0)
      .map(([rule, n]) => `${rule} (${n})`)
      .join('<br>');
    lines.push(
      `| ${r.fault} | ${r.passed}/${r.trials} | ${pct(r.ci95[0])}–${pct(r.ci95[1])} | ${r.outcomes.crashed} | ${r.outcomes.hung} | ${r.outcomes.runaway} | ${Math.round(r.p95Ms)}ms | ${broken || '—'} |`,
    );
  }
  lines.push('', '## Hypotheses and replayable failures', '');
  for (const r of results) {
    lines.push(`- **${r.fault}**: ${r.hypothesis}`);
    for (const e of r.examples) lines.push(`  - ✗ ${e.rule} → ${e.detail ?? ''} (seed ${e.seed})`);
  }
  return lines.join('\n') + '\n';
}

export function renderConsole(results: ExperimentResult[]): string {
  const rows = results.map((r) => {
    const broken = Object.entries(r.violations)
      .filter(([, n]) => n > 0)
      .map(([rule, n]) => `${n}× ${rule}`)
      .join('; ');
    return [
      r.fault.padEnd(22),
      `${r.passed}/${r.trials}`.padStart(6),
      `${pct(r.ci95[0])}–${pct(r.ci95[1])}`.padEnd(10),
      `crash ${r.outcomes.crashed} hung ${r.outcomes.hung} runaway ${r.outcomes.runaway}`.padEnd(28),
      broken || 'all rules held',
    ].join('  ');
  });
  return [`${'fault'.padEnd(22)}  ${'pass'.padStart(6)}  ${'95% CI'.padEnd(10)}  ${'outcomes'.padEnd(28)}  broken rules`, ...rows].join('\n');
}
