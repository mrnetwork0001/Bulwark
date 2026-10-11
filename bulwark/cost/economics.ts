// Unit economics from real Bulwark runs: what one loop run, one fixed fault and
// one trial cost, and what that means for gross margin at a few price points.
// Measured numbers (from summary.json) and assumptions (prices, run cadence) are
// kept apart everywhere, because this feeds a business plan.

import type { CostSummary } from './meter';

export interface RunRecord {
  runId: string;
  fixer: string;
  fixed: number;
  trials: number;
  cost: CostSummary;
  /** Dollars at risk across the attack suite, per 1k tickets, before and after the run's fixes. */
  riskBefore1k?: number;
  riskAfter1k?: number;
}

export interface Measured {
  runs: number;
  llmRuns: number;
  totalUsd: number;
  llmUsd: number;
  computeUsd: number;
  perRunUsd: number;
  perRunLlmUsd: number;
  perRunComputeUsd: number;
  perFixedFaultUsd: number | null;
  perTrialUsd: number;
  trialsPerRun: number;
  llmShare: number;
  computeShare: number;
  avgWallSec: number;
  faultsFixed: number;
  /** Average reduction in dollars at risk per 1k tickets, across runs that recorded it. */
  riskRemoved1k: number | null;
}

export function measure(runs: RunRecord[]): Measured {
  const sum = (f: (r: RunRecord) => number) => runs.reduce((s, r) => s + f(r), 0);
  const n = runs.length || 1;
  const totalUsd = sum((r) => r.cost.totalUsd);
  const llmUsd = sum((r) => r.cost.llmUsd);
  const computeUsd = sum((r) => r.cost.computeUsd);
  const trials = sum((r) => r.cost.trials);
  const faultsFixed = sum((r) => r.fixed);
  const withRisk = runs.filter((r) => r.riskBefore1k !== undefined && r.riskAfter1k !== undefined);
  return {
    runs: runs.length,
    llmRuns: runs.filter((r) => r.cost.calls > 0).length,
    totalUsd,
    llmUsd,
    computeUsd,
    perRunUsd: totalUsd / n,
    perRunLlmUsd: llmUsd / n,
    perRunComputeUsd: computeUsd / n,
    perFixedFaultUsd: faultsFixed ? totalUsd / faultsFixed : null,
    perTrialUsd: trials ? totalUsd / trials : 0,
    trialsPerRun: trials / n,
    llmShare: totalUsd ? llmUsd / totalUsd : 0,
    computeShare: totalUsd ? computeUsd / totalUsd : 0,
    avgWallSec: sum((r) => r.cost.wallMs) / n / 1000,
    faultsFixed,
    riskRemoved1k: withRisk.length ? withRisk.reduce((s, r) => s + (r.riskBefore1k! - r.riskAfter1k!), 0) / withRisk.length : null,
  };
}

export interface Plan {
  name: string;
  /** Assumed list price per agent per month. */
  priceUsd: number;
  /** Assumed full loop runs per agent per month. */
  runsPerMonth: number;
  cadence: string;
}

/** Assumptions, not measurements. Edit here (or pass your own) to model other plans. */
export const DEFAULT_PLANS: Plan[] = [
  { name: 'Starter', priceUsd: 49, runsPerMonth: 4, cadence: 'weekly loop run' },
  { name: 'Team', priceUsd: 199, runsPerMonth: 30, cadence: 'daily loop run' },
  { name: 'Enterprise', priceUsd: 799, runsPerMonth: 120, cadence: '~4 runs/day (every PR)' },
];

export interface Scenario extends Plan {
  /** COGS per agent per month with the target's brain simulated (as measured). */
  cogsSimulated: number;
  marginSimulated: number;
  /** COGS if every trial also calls a real LLM for the target agent. */
  cogsRealLlm?: number;
  marginRealLlm?: number;
}

/**
 * Prices each plan at the measured cost per run. If a real-LLM per-trial cost is
 * given (from the leaderboard), also shows COGS when every trial hits a real model,
 * at `realTrialsPerRun` trials per run (a smaller suite is what you'd run there).
 */
export function scenarios(m: Measured, plans: Plan[], real?: { perTrialUsd: number; trialsPerRun: number }): Scenario[] {
  return plans.map((p) => {
    const cogsSimulated = p.runsPerMonth * m.perRunUsd;
    const s: Scenario = { ...p, cogsSimulated, marginSimulated: (p.priceUsd - cogsSimulated) / p.priceUsd };
    if (real) {
      const cogsRealLlm = cogsSimulated + p.runsPerMonth * real.perTrialUsd * real.trialsPerRun;
      s.cogsRealLlm = cogsRealLlm;
      s.marginRealLlm = (p.priceUsd - cogsRealLlm) / p.priceUsd;
    }
    return s;
  });
}
