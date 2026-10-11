// SLO-driven trial counts. The user states a reliability target ("99% of tickets
// keep every rule"), and the Judge runs exactly as many after-fix trials as it
// takes to demonstrate that target at the chosen confidence with zero failures.
// See SLO_METHOD in ../stats for the math.

import { clopperPearsonLower, SLO_METHOD, zeroFailureTrials } from '../stats';

export interface SloSpec {
  /** Target for every fault without an override (undefined = no SLO). */
  default?: number;
  /** Per-fault overrides, e.g. { 'timeout-after-commit': 0.999 }. */
  perFault: Record<string, number>;
  /** One-sided confidence level (default 0.95). */
  confidence: number;
  /** Refuse SLOs that would need more trials than this. */
  maxTrials: number;
}

export interface SloPlan {
  fault: string;
  target: number;
  confidence: number;
  trials: number;
  method: string;
}

export interface SloResult extends SloPlan {
  passed: number;
  /** True only when every one of the planned trials passed. */
  demonstrated: boolean;
  /** Exact lower bound on the pass rate actually achieved by this run. */
  lowerBound: number;
}

export const DEFAULT_SLO_CONFIDENCE = 0.95;
export const DEFAULT_MAX_SLO_TRIALS = 1000;

const parseRate = (s: string): number => {
  const t = s.trim();
  const v = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
  if (!(v > 0 && v < 1)) throw new Error(`invalid SLO "${s}": use a pass rate between 0 and 1, e.g. 0.99 or 99%`);
  return v;
};

/** Parses `--slo 0.99` or `--slo 0.99,timeout-after-commit=0.999`. */
export function parseSlo(arg: string, confidence = DEFAULT_SLO_CONFIDENCE, maxTrials = DEFAULT_MAX_SLO_TRIALS): SloSpec {
  const spec: SloSpec = { perFault: {}, confidence, maxTrials };
  for (const part of arg.split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq === -1) spec.default = parseRate(part);
    else spec.perFault[part.slice(0, eq).trim()] = parseRate(part.slice(eq + 1));
  }
  return spec;
}

export function sloTarget(spec: SloSpec | undefined, fault: string): number | undefined {
  return spec ? (spec.perFault[fault] ?? spec.default) : undefined;
}

const fmtInt = (n: number) => n.toLocaleString('en-US');
export const fmtRate = (x: number) => `${+(x * 100).toFixed(2)}%`;

/** One plan per fault that has a target. Throws with a clear message if any target needs absurdly many trials. */
export function planSlo(spec: SloSpec | undefined, faults: string[]): SloPlan[] {
  if (!spec) return [];
  const plans: SloPlan[] = [];
  for (const fault of faults) {
    const target = sloTarget(spec, fault);
    if (target === undefined) continue;
    const trials = zeroFailureTrials(target, spec.confidence);
    if (trials > spec.maxTrials) {
      throw new Error(
        `SLO ${fmtRate(target)} for ${fault} needs ${fmtInt(trials)} zero-failure trials at ${fmtRate(spec.confidence)} confidence, ` +
          `above the cap of ${fmtInt(spec.maxTrials)}. Lower the target or raise --max-slo-trials.`,
      );
    }
    plans.push({ fault, target, confidence: spec.confidence, trials, method: SLO_METHOD });
  }
  return plans;
}

export function evaluateSlo(plan: SloPlan, passed: number, trials: number): SloResult {
  const demonstrated = trials >= plan.trials && passed === trials;
  return { ...plan, trials, passed, demonstrated, lowerBound: clopperPearsonLower(passed, trials, plan.confidence) };
}

export function describeSlo(s: SloResult): string {
  return s.demonstrated
    ? `SLO ${fmtRate(s.target)} demonstrated: ${s.passed}/${s.trials} passed, so the pass rate is ≥ ${fmtRate(s.lowerBound)} at ${fmtRate(s.confidence)} confidence`
    : `SLO ${fmtRate(s.target)} not demonstrated: ${s.passed}/${s.trials} passed; achieved lower bound ${fmtRate(s.lowerBound)} at ${fmtRate(s.confidence)} confidence`;
}

export function describePlan(p: SloPlan): string {
  return `${p.fault}: ${fmtRate(p.target)} → ${fmtInt(p.trials)} zero-failure trials`;
}
