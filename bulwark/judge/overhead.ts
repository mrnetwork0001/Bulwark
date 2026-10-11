// Overhead-aware Judge: a fix that survives the fault but makes every normal run
// slower, longer or pricier is not free. The Judge measures what the fix costs on
// the happy path (the no-fault baseline, where both versions pass every trial,
// so the comparison is like for like) and checks it against optional budgets.
// Numbers under the fault itself are reported too, but never budgeted: there the
// unpatched code hangs or crashes, so "faster" would mostly mean "failed sooner".

import type { TrialObservation } from '../harness';
import { percentile } from '../stats';

export interface Perf {
  runs: number;
  p50Ms: number;
  p95Ms: number;
  avgSteps: number;
  /** Average LLM cost per run in USD, when a cost source is available. */
  costPerRunUsd?: number;
}

/** Prices one trial in USD, or undefined when the trial carries no usage data. */
export type CostFn = (obs: TrialObservation) => number | undefined;

// Default cost source: a numeric `costUsd` on the observation, if the harness
// records one. Token-cost tracking can plug in a better source with setTrialCostFn.
let trialCost: CostFn = (obs) => {
  const v = (obs as unknown as { costUsd?: unknown }).costUsd;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

export function setTrialCostFn(fn: CostFn): void {
  trialCost = fn;
}

export function perfOf(obs: TrialObservation[], cost: CostFn = trialCost): Perf {
  const costs = obs.map(cost);
  const priced = costs.every((c) => c !== undefined) && obs.length > 0;
  return {
    runs: obs.length,
    p50Ms: percentile(obs.map((o) => o.durationMs), 50),
    p95Ms: percentile(obs.map((o) => o.durationMs), 95),
    avgSteps: obs.length ? obs.reduce((s, o) => s + o.steps, 0) / obs.length : 0,
    ...(priced ? { costPerRunUsd: (costs as number[]).reduce((s, c) => s + c, 0) / obs.length } : {}),
  };
}

export interface OverheadBudgets {
  /** Max relative increase in p50 and p95 latency, as a fraction (0.5 = +50%). */
  maxLatencyOverhead?: number;
  /** Max increase in average steps per run (absolute). */
  maxStepOverhead?: number;
  /** Max relative increase in cost per run, as a fraction. Only checked when both sides are priced. */
  maxCostOverhead?: number;
  /** Latency changes smaller than this are noise, not overhead (default 50ms). */
  minLatencyDeltaMs?: number;
  /** What to do when a budget is exceeded: reject the fix, or accept it flagged "fixed with overhead". */
  policy?: 'reject' | 'flag';
}

export const DEFAULT_MIN_LATENCY_DELTA_MS = 50;

export interface Overhead {
  /** The experiment the budgets were checked on. */
  scope: string;
  before: Perf;
  after: Perf;
  latencyP50Pct: number;
  latencyP95Pct: number;
  stepsDelta: number;
  costPct?: number;
  /** Same numbers under the fault being fixed, for information only. */
  underFault?: { before: Perf; after: Perf };
  /** Budgets this fix exceeded, as human-readable reasons. Empty = within budget. */
  exceeded: string[];
  withinBudget: boolean;
}

const rel = (before: number, after: number) => (before > 0 ? (after - before) / before : after > 0 ? Infinity : 0);
export const fmtPct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%` : '+∞%');

export function compareOverhead(before: Perf, after: Perf, budgets: OverheadBudgets = {}, scope = 'baseline'): Overhead {
  const floor = budgets.minLatencyDeltaMs ?? DEFAULT_MIN_LATENCY_DELTA_MS;
  const latencyP50Pct = rel(before.p50Ms, after.p50Ms);
  const latencyP95Pct = rel(before.p95Ms, after.p95Ms);
  const stepsDelta = after.avgSteps - before.avgSteps;
  const priced = before.costPerRunUsd !== undefined && after.costPerRunUsd !== undefined;
  const costPct = priced ? rel(before.costPerRunUsd!, after.costPerRunUsd!) : undefined;

  const exceeded: string[] = [];
  if (budgets.maxLatencyOverhead !== undefined) {
    const max = budgets.maxLatencyOverhead;
    for (const [label, b, a, pct] of [
      ['p50', before.p50Ms, after.p50Ms, latencyP50Pct],
      ['p95', before.p95Ms, after.p95Ms, latencyP95Pct],
    ] as const) {
      if (a - b > floor && pct > max) {
        exceeded.push(`${label} latency ${Math.round(b)}→${Math.round(a)}ms (${fmtPct(pct)}) exceeds the ${fmtPct(max)} budget`);
      }
    }
  }
  if (budgets.maxStepOverhead !== undefined && stepsDelta > budgets.maxStepOverhead + 1e-9) {
    exceeded.push(`avg steps ${before.avgSteps.toFixed(1)}→${after.avgSteps.toFixed(1)} (+${stepsDelta.toFixed(1)}) exceeds the +${budgets.maxStepOverhead} budget`);
  }
  if (budgets.maxCostOverhead !== undefined && costPct !== undefined && costPct > budgets.maxCostOverhead) {
    exceeded.push(`cost/run $${before.costPerRunUsd!.toFixed(4)}→$${after.costPerRunUsd!.toFixed(4)} (${fmtPct(costPct)}) exceeds the ${fmtPct(budgets.maxCostOverhead)} budget`);
  }
  return { scope, before, after, latencyP50Pct, latencyP95Pct, stepsDelta, ...(costPct !== undefined ? { costPct } : {}), exceeded, withinBudget: exceeded.length === 0 };
}

export function hasBudgets(b?: OverheadBudgets): boolean {
  return !!b && (b.maxLatencyOverhead !== undefined || b.maxStepOverhead !== undefined || b.maxCostOverhead !== undefined);
}

/** One line: "happy path p50 3→3ms (+0%), p95 5→6ms (+20%), steps 4.0→4.0 (+0.0), cost n/a". */
export function describeOverhead(o: Overhead): string {
  const { before: b, after: a } = o;
  const cost = o.costPct !== undefined ? `cost/run $${b.costPerRunUsd!.toFixed(4)}→$${a.costPerRunUsd!.toFixed(4)} (${fmtPct(o.costPct)})` : 'cost n/a';
  const sd = o.stepsDelta;
  return `${o.scope === 'baseline' ? 'happy path' : o.scope} p50 ${Math.round(b.p50Ms)}→${Math.round(a.p50Ms)}ms (${fmtPct(o.latencyP50Pct)}), p95 ${Math.round(b.p95Ms)}→${Math.round(a.p95Ms)}ms (${fmtPct(o.latencyP95Pct)}), steps ${b.avgSteps.toFixed(1)}→${a.avgSteps.toFixed(1)} (${sd >= 0 ? '+' : ''}${sd.toFixed(1)}), ${cost}`;
}

/** Parses "50%", "0.5" or "50" into a fraction. Bare numbers above 1 are read as percent. */
export function parsePercent(s: string): number {
  const t = s.trim();
  const v = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t) > 1 ? Number(t) / 100 : Number(t);
  if (!Number.isFinite(v) || v < 0) throw new Error(`invalid overhead budget "${s}": use e.g. 50% or 0.5`);
  return v;
}
