// Counts what a Bulwark run spends: every LLM call (Blue's fixer and the target
// agent's brain), its tokens and latency, plus how many trials ran and the
// wall-clock time. A meter is scoped with AsyncLocalStorage, so concurrent work
// (trials run in parallel) all lands on the meter of the run that started it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { costOf, type Price, type TokenUsage } from './pricing';

export interface LlmCall extends TokenUsage {
  role: 'fixer' | 'agent';
  model: string;
  ms: number;
  /** The call threw (no tokens were billed as far as we know). */
  error?: boolean;
}

export interface ModelCost {
  role: LlmCall['role'];
  model: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  priceSource: Price['source'];
}

export interface CostSummary {
  llmUsd: number;
  computeUsd: number;
  totalUsd: number;
  wallMs: number;
  /** Sum of LLM call latencies (calls overlap, so this can exceed wallMs). */
  llmMs: number;
  calls: number;
  trials: number;
  inputTokens: number;
  outputTokens: number;
  byModel: ModelCost[];
  assumptions: { computeUsdPerHour: number; prices: string };
}

/** Assumed price of the box Bulwark runs on: a 2 vCPU / 4 GB on-demand cloud VM. */
export const DEFAULT_COMPUTE_USD_PER_HOUR = 0.1;

export function computeUsdPerHour(): number {
  const v = Number(process.env.BULWARK_COMPUTE_USD_PER_HOUR);
  return Number.isFinite(v) && v >= 0 && process.env.BULWARK_COMPUTE_USD_PER_HOUR ? v : DEFAULT_COMPUTE_USD_PER_HOUR;
}

/** Pure: prices a list of calls and adds compute time. */
export function summarizeCalls(
  calls: LlmCall[],
  priceFor: (model: string) => Price,
  args: { wallMs: number; trials: number; computeUsdPerHour: number; prices?: string },
): CostSummary {
  const byKey = new Map<string, ModelCost>();
  for (const c of calls) {
    const key = `${c.role}:${c.model}`;
    const price = priceFor(c.model);
    const m = byKey.get(key) ?? { role: c.role, model: c.model, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, usd: 0, priceSource: price.source };
    m.calls++;
    if (c.error) m.errors++;
    m.inputTokens += c.inputTokens + (c.cacheReadTokens ?? 0) + (c.cacheWriteTokens ?? 0);
    m.outputTokens += c.outputTokens;
    m.usd += costOf(c, price);
    byKey.set(key, m);
  }
  const byModel = [...byKey.values()].sort((a, b) => b.usd - a.usd);
  const llmUsd = byModel.reduce((s, m) => s + m.usd, 0);
  const computeUsd = (args.wallMs / 3_600_000) * args.computeUsdPerHour;
  return {
    llmUsd,
    computeUsd,
    totalUsd: llmUsd + computeUsd,
    wallMs: args.wallMs,
    llmMs: calls.reduce((s, c) => s + c.ms, 0),
    calls: calls.length,
    trials: args.trials,
    inputTokens: byModel.reduce((s, m) => s + m.inputTokens, 0),
    outputTokens: byModel.reduce((s, m) => s + m.outputTokens, 0),
    byModel,
    assumptions: { computeUsdPerHour: args.computeUsdPerHour, prices: args.prices ?? 'static' },
  };
}

const store = new AsyncLocalStorage<CostMeter>();

export class CostMeter {
  calls: LlmCall[] = [];
  trials = 0;
  private start = performance.now();

  /** Runs `fn` with this meter as the current one. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.start = performance.now();
    return store.run(this, fn);
  }

  elapsedMs(): number {
    return performance.now() - this.start;
  }

  summarize(priceFor: (model: string) => Price, prices?: string): CostSummary {
    return summarizeCalls(this.calls, priceFor, { wallMs: this.elapsedMs(), trials: this.trials, computeUsdPerHour: computeUsdPerHour(), prices });
  }
}

export function currentMeter(): CostMeter | undefined {
  return store.getStore();
}

export function recordLlmCall(call: LlmCall): void {
  currentMeter()?.calls.push(call);
}

export function countTrial(): void {
  const m = currentMeter();
  if (m) m.trials++;
}

/** Token counts from an Anthropic Messages API `usage` object. */
export function usageFromAnthropic(u: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | undefined): TokenUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  };
}

/** "$1.23", "$0.042", "$0.00051": always two significant digits below a cent. */
export const usd = (x: number) =>
  x >= 1 ? `$${x.toFixed(2)}` : x >= 0.01 ? `$${x.toFixed(3)}` : x <= 0 ? '$0' : `$${x.toFixed(Math.min(12, 1 - Math.floor(Math.log10(x))))}`;
