import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { CheckResult } from './invariants';

export type BrainMode = 'simulated' | 'claude';

/**
 * The wire between an agent and its services: JSON string in, JSON string out.
 * Endpoint names are plain strings that each target declares (`BulwarkTarget.endpoints`),
 * e.g. RefundBot's `orders.get` or ResearchBot's `company.enrich`.
 */
export type Transport<E extends string = string> = (endpoint: E, payload: Record<string, unknown>) => Promise<string>;

/** What a target's brain decides at each step. Every target uses this shape, so the recorder can show it. */
export type Decision = { type: 'tool'; name: string; input: Record<string, unknown> } | { type: 'final'; reply: string };

/** The model that picks the next action. The context is the target's own (ticket, history, …). */
export interface Brain {
  name: string;
  decide(ctx: any): Promise<Decision>;
}

export interface RunResult {
  reply: string;
  steps: unknown[];
}

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

/**
 * A rule the target compiles itself: the plain-English text, exactly how it is
 * checked (given to the fixer), and the check over one trial's observation.
 * Bulwark's pattern library covers the common rules; a target supplies these for
 * rules only it knows how to check (e.g. "every brief cites only API data").
 */
export interface TargetCheck {
  rule: string;
  how: string;
  check: (obs: any) => CheckResult;
}

/** Fixture data for one sandboxed run. `ticket` is what the agent is asked to handle; the rest seeds the sandbox. */
export interface TargetFixtures {
  ticket: { message: string } & Record<string, any>;
  [key: string]: unknown;
}

// What Bulwark needs to know about an agent under test. Everything the harness
// touches comes through here, so a patched copy of the agent can be loaded from
// a workspace and attacked exactly like the original.
//
// A target directory is copied into workspaces as-is, so its files may only
// `import type` from bulwark/ (types are erased); runtime imports would break.
export interface BulwarkTarget<F extends TargetFixtures = any, S = any> {
  name: string;
  /** Business invariants in plain English, checked on every trial. */
  rules: string[];
  /** Target-compiled rules, matched by exact rule text before Bulwark's pattern library. */
  checks?: TargetCheck[];
  /** Source files (relative to the target directory) the fixer may edit. */
  editableFiles: string[];
  /**
   * The endpoints this target's transport serves, with what each returns (for generative Red).
   * Faults may only name these (or 'ticket'). Optional for older targets (RefundBot's defaults apply).
   */
  endpoints?: Record<string, string>;
  fixtures: () => F;
  /** Builds the sandboxed outside world from the fixtures. */
  createSandbox: (fixtures: F) => S;
  createTransport: (sandbox: S, signal: AbortSignal) => Transport<any>;
  /** The sandbox ledger, keyed by effect type (e.g. refunds, emails, apiCalls). Ground truth for the rules. */
  observe: (sandbox: S) => Record<string, unknown[]>;
  createBrain: (mode: BrainMode, rng: () => number, opts?: BrainOptions) => Brain;
  /** Cost assumptions for dollars at risk. Targets without them get no dollars-at-risk figure (never a made-up one). */
  risk?: Partial<RiskCosts>;
  run: (ticket: F['ticket'], deps: { transport: Transport<any>; brain: Brain }) => Promise<RunResult>;
}

/** Loads `<dir>/bulwark.target.ts`. Each directory is a separate module graph, so patched copies never share code. */
export async function loadTarget(dir: string): Promise<BulwarkTarget> {
  const mod = await import(pathToFileURL(resolve(dir, 'bulwark.target.ts')).href);
  return mod.target as BulwarkTarget;
}
