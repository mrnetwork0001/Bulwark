// Trial replay: every trial is reproducible from its seed, so re-running one
// with the recorder on gives its full step-by-step story (brain decisions, tool
// calls, injected faults, retries, side effects, outcome, broken rules).

import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getFault } from './chaos/faults';
import { runTrial, type TrialObservation } from './harness';
import { compileRules } from './invariants';
import type { TrialEvent } from './recorder';
import { loadTarget, resolveTargetDir, type BulwarkTarget } from './target';

export interface ReplayResult {
  target: string;
  fault: string;
  seed: number;
  /** Where the code came from: the original target dir, or a loop workspace (patched code). */
  source: string;
  observation: Omit<TrialObservation, 'timeline'>;
  broken: { rule: string; how: string; detail?: string }[];
  timeline: TrialEvent[];
}

/** Same settings the dashboard and the loop use, so a replay matches the square that was clicked. */
export const REPLAY_DEFAULTS = { brain: 'simulated' as const, deadlineMs: 5000, maxSteps: 50 };

const SAFE = /^[\w-]{1,128}$/;

/**
 * Turns untrusted query parameters into a target directory, or throws.
 * - `run` + `ws`: a loop workspace, `.bulwark/runs/<run>/ws/<ws>` (e.g. ws = "timeout-after-commit-accepted").
 * - `target`: a directory under `targets/` ("refundbot" or "targets/refundbot").
 * Only plain names are accepted, so nothing can climb out of those roots.
 */
export function resolveReplayDir(params: { target?: string | null; run?: string | null; ws?: string | null }, stateDir = '.bulwark'): string {
  const { run, ws } = params;
  if (run || ws) {
    if (!run || !ws || !SAFE.test(run) || !SAFE.test(ws)) throw new Error('run and ws must both be plain names');
    const root = resolve(stateDir, 'runs');
    const dir = resolve(root, run, 'ws', ws);
    if (!dir.startsWith(root + sep)) throw new Error('workspace outside the runs directory');
    if (!existsSync(join(dir, 'bulwark.target.ts'))) throw new Error(`no workspace ${run}/${ws}`);
    return dir;
  }
  return resolveTargetDir(params.target);
}

export async function replayTrial(args: {
  target: BulwarkTarget;
  fault: string;
  seed: number;
  source?: string;
  deadlineMs?: number;
  maxSteps?: number;
}): Promise<ReplayResult> {
  const fault = args.fault === 'baseline' ? undefined : getFault(args.fault, args.target);
  if (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 0xffffffff) throw new Error('seed must be a 32-bit unsigned integer');
  const { compiled, uncompiled } = compileRules(args.target.rules, args.target.checks);
  if (uncompiled.length) throw new Error(`could not compile rules: ${uncompiled.join(' | ')}`);

  const obs = await runTrial({
    ...REPLAY_DEFAULTS,
    ...(args.deadlineMs ? { deadlineMs: args.deadlineMs } : {}),
    ...(args.maxSteps ? { maxSteps: args.maxSteps } : {}),
    target: args.target,
    fault,
    seed: args.seed,
    traced: false,
    record: true,
  });
  const { timeline = [], ...observation } = obs;
  const broken = compiled.flatMap(({ rule, how, check }) => {
    const res = check(obs);
    return res.ok ? [] : [{ rule, how, detail: res.detail }];
  });
  return { target: args.target.name, fault: fault?.id ?? 'baseline', seed: args.seed, source: args.source ?? args.target.name, observation, broken, timeline };
}

/** For the API: validates the parameters, loads the right code, replays. */
export async function replayFromParams(params: URLSearchParams): Promise<ReplayResult> {
  const fault = params.get('fault') ?? '';
  const seedStr = params.get('seed') ?? '';
  if (!/^\d{1,10}$/.test(seedStr)) throw new Error('seed must be a non-negative integer');
  const dir = resolveReplayDir({ target: params.get('target'), run: params.get('run'), ws: params.get('ws') });
  const run = params.get('run');
  const source = run ? `.bulwark/runs/${run}/ws/${params.get('ws')}` : `targets/${dir.split(sep).pop()}`;
  return replayTrial({ target: await loadTarget(dir), fault, seed: Number(seedStr), source });
}

const short = (v: unknown, n = 140) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/** One line per event, for the terminal. */
export function describeEvent(e: TrialEvent): string {
  switch (e.type) {
    case 'brain':
      return e.decision.type === 'tool'
        ? `brain    step ${e.step}: call ${e.decision.name} ${short(e.decision.input)}`
        : `brain    step ${e.step}: final reply ${short(e.decision.reply)}`;
    case 'call':
      return `tool  →  #${e.call} ${e.endpoint} ${short(e.input)}${e.retryOf ? `  (RETRY of #${e.retryOf}, attempt ${e.attempt})` : ''}`;
    case 'result':
      return `tool  ←  #${e.call} ${e.endpoint} ${short(e.output)} (${e.ms}ms)${e.late ? '  LATE: agent already gave up' : ''}`;
    case 'error':
      return `tool  ✗  #${e.call} ${e.endpoint} ERROR ${e.error} (${e.ms}ms)${e.late ? '  (late)' : ''}`;
    case 'timeout':
      return `timeout  #${e.call} ${e.endpoint}: ${e.detail}`;
    case 'fault':
      return `FAULT    ${e.fault} on #${e.call} ${e.endpoint}: ${e.detail}`;
    case 'effect':
      return `effect   ${e.effect}: ${short(e.data)}`;
    case 'outcome':
      return `outcome  ${e.outcome.toUpperCase()} after ${e.steps} steps, ${e.durationMs}ms${e.error ? ` · error: ${e.error}` : ''}${e.reply ? ` · reply: ${short(e.reply)}` : ''}${e.dropped ? ` · ${e.dropped} later events not kept` : ''}`;
  }
}
