// Model resilience leaderboard ranking. Pure, so the order is testable:
//   1. models that actually ran beat models that errored
//   2. resilience: the Wilson 95% lower bound of the pass rate (an honest pass
//      rate: 5/5 doesn't beat 19/20 just because it is "100%")
//   3. fewer dollars at risk per 1,000 tickets
//   4. lower LLM cost per 1,000 tickets

export interface ModelEntry {
  model: string;
  status: 'ok' | 'error' | 'no-tool-use';
  error?: string;
  trials: number;
  passed: number;
  passRate: number;
  ci95: [number, number];
  dollarsAtRisk1k: number;
  llmUsd: number;
  llmCostPerTrial: number;
  llmCostPer1k: number;
  p95Ms: number;
  calls: number;
  apiErrors: number;
  perFault: { fault: string; passed: number; trials: number; dollarsAtRisk1k: number; brokenRules: string[] }[];
  rank?: number;
}

const EPS = 1e-9;

export function compareEntries(a: ModelEntry, b: ModelEntry): number {
  const okA = a.status === 'ok' ? 0 : 1;
  const okB = b.status === 'ok' ? 0 : 1;
  if (okA !== okB) return okA - okB;
  if (Math.abs(a.ci95[0] - b.ci95[0]) > EPS) return b.ci95[0] - a.ci95[0];
  if (Math.abs(a.passRate - b.passRate) > EPS) return b.passRate - a.passRate;
  if (Math.abs(a.dollarsAtRisk1k - b.dollarsAtRisk1k) > EPS) return a.dollarsAtRisk1k - b.dollarsAtRisk1k;
  return a.llmCostPer1k - b.llmCostPer1k;
}

/** Sorts best-first and numbers the models that ran; errored models get no rank. */
export function rankModels(entries: ModelEntry[]): ModelEntry[] {
  const sorted = [...entries].sort(compareEntries);
  let rank = 0;
  return sorted.map((e) => (e.status === 'ok' ? { ...e, rank: ++rank } : { ...e, rank: undefined }));
}
