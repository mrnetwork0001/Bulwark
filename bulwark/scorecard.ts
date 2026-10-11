// Runs N trials per fault and turns them into an honest scorecard: pass rates
// with 95% confidence intervals, outcome breakdowns, and which rules broke.

import { trace } from 'neatlogs';
import type { SelfFaultReport } from './blue/fixer';
import type { Fault } from './chaos/faults';
import { runTrial, type BrainMode, type Outcome, type TrialObservation } from './harness';
import { compileRules } from './invariants';
import { dollarsAtRisk, money, riskCosts, type DollarsAtRisk } from './risk';
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
  /** Failures priced as money (over-refunds plus lost-ticket and escalation assumptions). Only for targets with a risk model. */
  dollarsAtRisk?: DollarsAtRisk;
  /** One failing trial per broken rule, so a human can replay it from its seed. */
  examples: { rule: string; seed: number; detail?: string; traceId?: string }[];
  /** Every trial in index order, so any one can be replayed from its seed (the dashboard's squares). */
  perTrial: { seed: number; outcome: Outcome; passed: boolean }[];
}

export interface ExperimentOptions {
  trials: number;
  seed: number;
  brain: BrainMode;
  /** Model override for LLM brains. */
  model?: string;
  deadlineMs: number;
  maxSteps: number;
  /** How many trials per experiment export full detail to neatlogs (default 2). */
  traceSample?: number;
  /** Groups this experiment's trace into a neatlogs session (one per CLI/dashboard run). */
  sessionId?: string;
  /** Exact trial seeds (e.g. recorded incidents); trial i uses seeds[i] instead of one derived from `seed`. */
  seeds?: number[];
  /** Called as each trial finishes, for live views. */
  onTrial?: (t: { index: number; obs: TrialObservation; broken: BrokenRule[] }) => void;
  /** Self-chaos seam: runs before each trial and may throw, as a worker trial failing inside Bulwark would. */
  beforeTrial?: (t: { fault: string; index: number }) => void;
  /** Called when a trial threw inside Bulwark's harness, with how the experiment carried on. */
  onSelfFault?: (f: SelfFaultReport) => void;
}

/**
 * Runs one trial, surviving a throw from Bulwark's own harness (not the agent: its crashes are
 * caught inside runTrial). The trial is re-run once from its seed; if it throws again it is
 * counted as a crashed trial, never silently dropped, and the experiment carries on.
 */
async function runTrialSafely(run: () => Promise<TrialObservation>, seed: number, opts: ExperimentOptions, where: string): Promise<TrialObservation> {
  let first: unknown;
  try {
    return await run();
  } catch (err) {
    first = err;
  }
  const fault = `${where} trial (seed ${seed}) threw: ${first instanceof Error ? first.message.split('\n')[0] : String(first)}`.slice(0, 240);
  try {
    const obs = await run();
    opts.onSelfFault?.({ seam: 'trial', fault, recovered: true, how: 're-ran the trial from its seed; it completed' });
    return obs;
  } catch (err) {
    const error = `bulwark harness error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    opts.onSelfFault?.({ seam: 'trial', fault, recovered: true, how: 'threw again on re-run; counted as a crashed trial (not dropped) and the experiment carried on' });
    return { seed, outcome: 'crashed', error, durationMs: 0, steps: 0, faultsFired: 0 };
  }
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
  const { compiled, uncompiled } = compileRules(target.rules, target.checks, { target: target.name });
  if (uncompiled.length) throw new Error(`could not compile rules: ${uncompiled.join(' | ')} (with an LLM key set, \`npm run rules -- --target targets/${target.name}\` compiles them)`);

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
          const seed = opts.seeds?.[i] ?? hashSeed(opts.seed, faultId, i);
          const obs = await runTrialSafely(
            async () => {
              opts.beforeTrial?.({ fault: faultId, index: i });
              return runTrial({
                target,
                fault,
                seed,
                brain: opts.brain,
                model: opts.model,
                deadlineMs: opts.deadlineMs,
                maxSteps: opts.maxSteps,
                traced: i < (opts.traceSample ?? Number(process.env.BULWARK_TRACE_SAMPLE ?? 2)),
              });
            },
            seed,
            opts,
            faultId,
          );
          outcomes[obs.outcome]++;
          const broken: BrokenRule[] = [];
          for (const { rule, check } of compiled) {
            const res = check(obs);
            if (res.ok) continue;
            broken.push({ rule, detail: res.detail });
            violations[rule]++;
            // One example per rule; a traced trial replaces an untraced one, so Blue can read it back from neatlogs.
            const i = examples.findIndex((e) => e.rule === rule);
            const ex = { rule, seed: obs.seed, detail: res.detail, ...(obs.traceId ? { traceId: obs.traceId } : {}) };
            if (i === -1) examples.push(ex);
            else if (obs.traceId && !examples[i].traceId) examples[i] = ex;
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
        ...(target.risk ? { dollarsAtRisk: dollarsAtRisk(observations, riskCosts(target.risk)) } : {}),
        examples,
        perTrial,
      };
    },
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Per-1k figure plus what it's made of, e.g. "$1,234 (over-refund $980, 3 lost, 2 escalated of 20)". Over-refund is also per 1k. */
export function riskCell(r: ExperimentResult): string {
  const d = r.dollarsAtRisk;
  if (!d) return '—';
  if (d.totalUsd === 0) return '$0';
  const parts = [
    d.overRefundUsd ? `over-refund ${money((d.overRefundUsd / d.trials) * 1000)}` : '',
    d.lostTickets ? `${d.lostTickets} lost` : '',
    d.escalations ? `${d.escalations} escalated` : '',
  ].filter(Boolean);
  return `${money(d.per1kTickets)} (${parts.join(', ')}${d.lostTickets || d.escalations ? ` of ${d.trials}` : ''})`;
}

export function renderMarkdown(target: BulwarkTarget, results: ExperimentResult[], meta: Record<string, unknown>): string {
  // Targets without a risk model get no dollars-at-risk column.
  const priced = results.some((r) => r.dollarsAtRisk);
  const lines = [
    `# Bulwark scorecard: ${target.name}`,
    '',
    Object.entries(meta)
      .map(([k, v]) => `**${k}**: ${v}`)
      .join(' · '),
    '',
    `| Fault | Pass | 95% CI | Crashed | Hung | Runaway | p95 |${priced ? ' $ at risk / 1k tickets |' : ''} Broken rules |`,
    `|---|---|---|---|---|---|---|${priced ? '---|' : ''}---|`,
  ];
  for (const r of results) {
    const broken = Object.entries(r.violations)
      .filter(([, n]) => n > 0)
      .map(([rule, n]) => `${rule} (${n})`)
      .join('<br>');
    lines.push(
      `| ${r.fault} | ${r.passed}/${r.trials} | ${pct(r.ci95[0])}–${pct(r.ci95[1])} | ${r.outcomes.crashed} | ${r.outcomes.hung} | ${r.outcomes.runaway} | ${Math.round(r.p95Ms)}ms |${priced ? ` ${riskCell(r)} |` : ''} ${broken || '—'} |`,
    );
  }
  const costs = results[0]?.dollarsAtRisk?.costs;
  if (costs) {
    lines.push(
      '',
      `_$ at risk = over-refunds read from the payments ledger (measured) + $${costs.lostTicketUsd} per ticket left without a reply + $${costs.escalationUsd} per crashed/hung run needing a human (assumptions, set on the target)._`,
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
      (r.dollarsAtRisk ? money(r.dollarsAtRisk.per1kTickets) : '—').padStart(9),
      broken || 'all rules held',
    ].join('  ');
  });
  return [`${'fault'.padEnd(22)}  ${'pass'.padStart(6)}  ${'95% CI'.padEnd(10)}  ${'outcomes'.padEnd(28)}  ${'$risk/1k'.padStart(9)}  broken rules`, ...rows].join('\n');
}
