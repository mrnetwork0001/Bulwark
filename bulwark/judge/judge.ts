// Judge agent: decides whether a patch actually works. It never sees the fixer's
// reasoning. It loads the patched code from its own workspace, re-runs the
// attack and every other attack on the Judge's own seeds, and compares against
// the unpatched code on those exact seeds.

import { trace } from 'neatlogs';
import { faultsFor, type Fault } from '../chaos/faults';
import type { TrialObservation } from '../harness';
import { runExperiment, type ExperimentOptions, type ExperimentResult } from '../scorecard';
import { fisherGreater } from '../stats';
import type { BulwarkTarget } from '../target';
import { compareOverhead, hasBudgets, perfOf, type CostFn, type Overhead, type OverheadBudgets, type Perf } from './overhead';
import { describeSlo, evaluateSlo, type SloPlan, type SloResult } from './slo';

export type VerdictStatus = 'fixed' | 'inconclusive' | 'rejected';

export interface Regression {
  fault: string;
  before: number;
  after: number;
  trials: number;
  pValue: number;
}

export interface Verdict {
  status: VerdictStatus;
  reasons: string[];
  before: ExperimentResult;
  after: ExperimentResult;
  /** P(this improvement is luck). */
  pValue: number;
  regressions: Regression[];
  /** Every fault's result on the patched code (baseline included). */
  results: Record<string, MeasuredResult>;
  /** Present when an SLO was set for this fault: whether the after-fix trials demonstrate it. */
  slo?: SloResult;
  /** What the fix costs vs the unpatched code (happy path), and whether it fits the budgets. */
  overhead?: Overhead;
}

/** An experiment result plus the latency/steps/cost profile of its trials. */
export type MeasuredResult = ExperimentResult & { perf?: Perf };

const SIGNIFICANCE = 0.05;

/** "Fixed with overhead": the fix works but exceeds an overhead budget under the "flag" policy. */
export const fixedWithOverhead = (v: Pick<Verdict, 'status' | 'overhead'>) => v.status === 'fixed' && v.overhead?.withinBudget === false;

/**
 * Runs the baseline plus every fault in the catalog against one version of the
 * code, recording each experiment's latency/steps/cost profile. `trialsFor` lets
 * one experiment (e.g. the fault under an SLO) run a different number of trials.
 */
export async function runAll(
  target: BulwarkTarget,
  opts: ExperimentOptions,
  trialsFor?: (fault: string) => number | undefined,
  cost?: CostFn,
): Promise<Record<string, MeasuredResult>> {
  const measure = async (f: Fault | undefined): Promise<MeasuredResult> => {
    const id = f?.id ?? 'baseline';
    const obs: TrialObservation[] = [];
    const r = await runExperiment(target, f, {
      ...opts,
      trials: trialsFor?.(id) ?? opts.trials,
      onTrial: (t) => {
        obs.push(t.obs);
        opts.onTrial?.(t);
      },
    });
    return { ...r, perf: perfOf(obs, cost) };
  };
  // The baseline runs on its own first: it is the happy path the overhead budgets
  // are checked on, so its latency must not depend on how busy the fault runs are.
  const baseline = await measure(undefined);
  const faults = await Promise.all(faultsFor(target).map(measure));
  return Object.fromEntries([baseline, ...faults].map((r) => [r.fault, r]));
}

export async function judge(args: {
  fault: Fault;
  candidate: () => Promise<BulwarkTarget>;
  baseResults: Record<string, MeasuredResult>;
  opts: ExperimentOptions;
  /** Reliability target for this fault: the after-fix run uses exactly `slo.trials` trials. */
  slo?: SloPlan;
  /** Optional overhead budgets; overhead is always measured and reported. */
  budgets?: OverheadBudgets;
  cost?: CostFn;
}): Promise<Verdict> {
  const { fault, baseResults, opts, slo, budgets } = args;
  const before = baseResults[fault.id];

  return trace({ name: 'judge.verify', kind: 'AGENT', attributes: { fault: fault.id } }, async () => {
    let target: BulwarkTarget;
    try {
      target = await args.candidate();
    } catch (err) {
      const reason = `patched code failed to load: ${err instanceof Error ? err.message.split('\n')[0] : err}`;
      return { status: 'rejected', reasons: [reason], before, after: before, pValue: 1, regressions: [], results: {} };
    }

    // The fault under test runs the SLO's trial count when one is set. Every other
    // experiment keeps the trial count of its baseline, so comparisons stay like for like.
    const results = await runAll(target, opts, (id) => (id === fault.id ? slo?.trials : baseResults[id]?.trials), args.cost);
    const after = results[fault.id];
    const pValue = fisherGreater(after.passed, after.trials, before.passed, before.trials);
    const reasons: string[] = [];

    const regressions: Regression[] = [];
    for (const [id, r] of Object.entries(results)) {
      if (id === fault.id) continue;
      const b = baseResults[id];
      const p = fisherGreater(b.passed, b.trials, r.passed, r.trials);
      if (r.passRate < b.passRate && (p < SIGNIFICANCE * 2 || id === 'baseline')) {
        regressions.push({ fault: id, before: b.passed, after: r.passed, trials: r.trials, pValue: p });
      }
    }

    const broken = Object.entries(after.violations)
      .filter(([, n]) => n > 0)
      .map(([rule, n]) => `${n}× ${rule}`);

    const sloResult = slo ? evaluateSlo(slo, after.passed, after.trials) : undefined;
    const base = baseResults.baseline;
    const overhead =
      base?.perf && results.baseline?.perf
        ? {
            ...compareOverhead(base.perf, results.baseline.perf, budgets),
            ...(before.perf && after.perf ? { underFault: { before: before.perf, after: after.perf } } : {}),
          }
        : undefined;

    let status: VerdictStatus;
    if (regressions.length) {
      status = 'rejected';
      for (const r of regressions) reasons.push(`regressed ${r.fault}: ${r.before}/${r.trials} → ${r.after}/${r.trials}`);
    } else if (after.passed < after.trials) {
      status = 'rejected';
      reasons.push(`still failing ${after.trials - after.passed}/${after.trials} trials (${broken.join('; ')})`);
    } else if (pValue >= SIGNIFICANCE) {
      status = 'inconclusive';
      reasons.push(`all trials passed, but the improvement over ${before.passed}/${before.trials} is not significant (p=${pValue.toFixed(3)})`);
    } else {
      status = 'fixed';
      reasons.push(`${before.passed}/${before.trials} → ${after.passed}/${after.trials} on fresh seeds (p=${pValue.toExponential(1)}), no regressions`);
    }

    if (sloResult) reasons.push(describeSlo(sloResult));
    if (overhead && hasBudgets(budgets) && !overhead.withinBudget) {
      // Only a fix that otherwise works can be "fixed with overhead"; a failing fix stays rejected for its failures.
      if (status === 'fixed' && (budgets?.policy ?? 'reject') === 'reject') {
        status = 'rejected';
        reasons.push(`overhead over budget: ${overhead.exceeded.join('; ')}`);
      } else if (status === 'fixed') {
        reasons.push(`fixed with overhead: ${overhead.exceeded.join('; ')}`);
      } else {
        reasons.push(`also over the overhead budget: ${overhead.exceeded.join('; ')}`);
      }
    }
    return {
      status,
      reasons,
      before,
      after,
      pValue,
      regressions,
      results,
      ...(sloResult ? { slo: sloResult } : {}),
      ...(overhead ? { overhead } : {}),
    };
  });
}
