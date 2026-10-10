// Judge agent: decides whether a patch actually works. It never sees the fixer's
// reasoning. It loads the patched code from its own workspace, re-runs the
// attack and every other attack on the Judge's own seeds, and compares against
// the unpatched code on those exact seeds.

import { trace } from 'neatlogs';
import { FAULTS, type Fault } from '../chaos/faults';
import { runExperiment, type ExperimentOptions, type ExperimentResult } from '../scorecard';
import { fisherGreater } from '../stats';
import type { BulwarkTarget } from '../target';

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
  results: Record<string, ExperimentResult>;
}

const SIGNIFICANCE = 0.05;

/** Runs the baseline plus every fault in the catalog against one version of the code. */
export async function runAll(target: BulwarkTarget, opts: ExperimentOptions): Promise<Record<string, ExperimentResult>> {
  const faults: (Fault | undefined)[] = [undefined, ...FAULTS];
  const results = await Promise.all(faults.map((f) => runExperiment(target, f, opts)));
  return Object.fromEntries(results.map((r) => [r.fault, r]));
}

export async function judge(args: {
  fault: Fault;
  candidate: () => Promise<BulwarkTarget>;
  baseResults: Record<string, ExperimentResult>;
  opts: ExperimentOptions;
}): Promise<Verdict> {
  const { fault, baseResults, opts } = args;
  const before = baseResults[fault.id];

  return trace({ name: 'judge.verify', kind: 'AGENT', attributes: { fault: fault.id } }, async () => {
    let target: BulwarkTarget;
    try {
      target = await args.candidate();
    } catch (err) {
      const reason = `patched code failed to load: ${err instanceof Error ? err.message.split('\n')[0] : err}`;
      return { status: 'rejected', reasons: [reason], before, after: before, pValue: 1, regressions: [], results: {} };
    }

    const results = await runAll(target, opts);
    const after = results[fault.id];
    const pValue = fisherGreater(after.passed, after.trials, before.passed, before.trials);
    const reasons: string[] = [];

    const regressions: Regression[] = [];
    for (const [id, r] of Object.entries(results)) {
      if (id === fault.id) continue;
      const b = baseResults[id];
      const p = fisherGreater(b.passed, b.trials, r.passed, r.trials);
      if (r.passed < b.passed && (p < SIGNIFICANCE * 2 || id === 'baseline')) {
        regressions.push({ fault: id, before: b.passed, after: r.passed, trials: r.trials, pValue: p });
      }
    }

    const broken = Object.entries(after.violations)
      .filter(([, n]) => n > 0)
      .map(([rule, n]) => `${n}× ${rule}`);

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
    return { status, reasons, before, after, pValue, regressions, results };
  });
}
