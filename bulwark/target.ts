import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Brain, RunResult, Ticket } from '../targets/refundbot/agent';
import type { Order, PaymentsSandbox, Transport } from '../targets/refundbot/payments';

export type BrainMode = 'simulated' | 'claude';

/** Token usage of one LLM call made by the target's brain. */
export interface BrainUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  ms: number;
  error?: boolean;
}

export interface BrainOptions {
  /** Model override for LLM brains (e.g. a leaderboard run). */
  model?: string;
  /** Called after every LLM call, so Bulwark can price the run. */
  onUsage?: (u: BrainUsage) => void;
}

/** What one failure costs the business, used to price failures as "dollars at risk". */
export interface RiskCosts {
  /** A ticket that never got a reply (lost customer / goodwill). */
  lostTicketUsd: number;
  /** A crashed, hung or runaway run that a human must pick up. */
  escalationUsd: number;
}

// What Bulwark needs to know about an agent under test. Everything the harness
// touches comes through here, so a patched copy of the agent can be loaded from
// a workspace and attacked exactly like the original.
export interface BulwarkTarget {
  name: string;
  /** Business invariants in plain English, checked on every trial. */
  rules: string[];
  /** Source files (relative to the target directory) the fixer may edit. */
  editableFiles: string[];
  fixtures: () => { orders: Order[]; ticket: Ticket };
  createSandbox: (orders: Order[]) => PaymentsSandbox;
  createTransport: (sandbox: PaymentsSandbox, signal: AbortSignal) => Transport;
  createBrain: (mode: BrainMode, rng: () => number, opts?: BrainOptions) => Brain;
  /** Cost assumptions for dollars at risk. Defaults apply when omitted. */
  risk?: Partial<RiskCosts>;
  run: (ticket: Ticket, deps: { transport: Transport; brain: Brain }) => Promise<RunResult>;
}

/** Loads `<dir>/bulwark.target.ts`. Each directory is a separate module graph, so patched copies never share code. */
export async function loadTarget(dir: string): Promise<BulwarkTarget> {
  const mod = await import(pathToFileURL(resolve(dir, 'bulwark.target.ts')).href);
  return mod.target as BulwarkTarget;
}
