// Self-chaos: Bulwark attacks itself. A small, injectable fault layer for
// Bulwark's OWN dependencies (Blue's LLM, checkpoints, workspaces, neatlogs,
// trial workers). Nothing global is patched: the loop takes a SelfFaults object
// (LoopOptions.selfFaults, or BULWARK_SELF_FAULTS in the environment) and asks it
// at each seam whether to break something there. Recovery is reported by the
// code that recovers, as `self-fault` loop events.
//
// A plan names faults per seam; each fires once, at the next opportunity, or at
// the Nth opportunity with `fault@N`:
//   blue-llm=429,5xx@2,timeout   blue-proposal=malformed,empty   checkpoint=corrupt,missing
//   workspace=syntax-error       neatlogs=down                    trial=throw@5,throw-twice@40

import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlaybookFixer, type FixContext, type Fixer, type Proposal } from '../blue/fixer';
import type { Fetcher } from '../observe/neatlogs';

export type SelfSeam = 'blue-llm' | 'blue-proposal' | 'checkpoint' | 'workspace' | 'neatlogs' | 'trial';

export const SEAM_FAULTS: Record<SelfSeam, string[]> = {
  'blue-llm': ['429', '5xx', 'timeout'],
  'blue-proposal': ['malformed', 'empty'],
  checkpoint: ['corrupt', 'missing'],
  workspace: ['syntax-error'],
  neatlogs: ['down'],
  trial: ['throw', 'throw-twice'],
};

export type SelfFaultPlan = Partial<Record<SelfSeam, string[]>>;

export interface Injection {
  seam: SelfSeam;
  fault: string;
  /** Which opportunity at this seam it fired on (1-based). */
  at: number;
}

/** An HTTP-shaped error like the Anthropic SDK's, so the fixer reports it the way it would a real one. */
export class InjectedHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  fault: string;
  /** Fire at this opportunity number (0 = the next one). */
  at: number;
}

/** `blue-llm=429,5xx;checkpoint=corrupt` (seams separated by ';'). Validated when a SelfFaults is built from it. */
export function parsePlan(spec: string): SelfFaultPlan {
  const plan: SelfFaultPlan = {};
  for (const part of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [seam, list] = part.split('=');
    plan[seam.trim() as SelfSeam] = (list ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return plan;
}

/**
 * Offline stand-in for Blue's LLM: proposes what the playbook would, under its own name, so a
 * self-chaos run needs no key and costs nothing, and a fallback to the real playbook is visible.
 */
export function standInLlm(): Fixer {
  const playbook = new PlaybookFixer();
  return {
    name: 'llm-standin',
    async propose(ctx) {
      // Its own failed attempts are recorded under its name; the playbook skips those strategies too.
      const p = await playbook.propose(ctx);
      return p && { ...p, author: 'llm-standin' };
    },
  };
}

export class SelfFaults {
  readonly injected: Injection[] = [];
  /** How long Blue waits for one LLM proposal before falling back (short, so the hang fault is cut quickly). */
  llmDeadlineMs = 2000;
  /** The LLM behind the blue-llm seam (default: the offline stand-in). */
  llmInner: Fixer = standInLlm();
  private queue = new Map<SelfSeam, Pending[]>();
  private seen = new Map<SelfSeam, number>();
  /** A trial that must throw again on its re-run (throw-twice), keyed by fault and index. */
  private sticky = new Set<string>();

  constructor(plan: SelfFaultPlan) {
    for (const [seam, faults] of Object.entries(plan) as [SelfSeam, string[]][]) {
      if (!(seam in SEAM_FAULTS)) throw new Error(`unknown self-fault seam "${seam}" (known: ${Object.keys(SEAM_FAULTS).join(', ')})`);
      const parsed = faults.map((f): Pending => {
        const [fault, at] = f.split('@');
        if (!SEAM_FAULTS[seam].includes(fault)) throw new Error(`unknown ${seam} self-fault "${fault}" (known: ${SEAM_FAULTS[seam].join(', ')})`);
        if (at !== undefined && !/^\d+$/.test(at)) throw new Error(`bad opportunity "@${at}" for ${seam}=${fault}`);
        return { fault, at: at ? Number(at) : 0 };
      });
      this.queue.set(seam, parsed);
    }
  }

  /** `blue-llm=429,5xx;checkpoint=corrupt` (seams separated by ';'), as in BULWARK_SELF_FAULTS. */
  static parse(spec: string): SelfFaults {
    return new SelfFaults(parsePlan(spec));
  }

  static fromEnv(env = process.env.BULWARK_SELF_FAULTS): SelfFaults | undefined {
    return env ? SelfFaults.parse(env) : undefined;
  }

  /** One opportunity at a seam: returns the fault to inject now, if one is due. */
  take(seam: SelfSeam): string | undefined {
    const n = (this.seen.get(seam) ?? 0) + 1;
    this.seen.set(seam, n);
    const q = this.queue.get(seam);
    if (!q?.length) return undefined;
    const i = q.findIndex((p) => p.at === 0 || p.at === n);
    if (i === -1) return undefined;
    const [p] = q.splice(i, 1);
    this.injected.push({ seam, fault: p.fault, at: n });
    return p.fault;
  }

  /** Faults planned but never injected (their seam never got that many opportunities). */
  pending(): { seam: SelfSeam; fault: string }[] {
    return [...this.queue].flatMap(([seam, q]) => q.map((p) => ({ seam, fault: p.at ? `${p.fault}@${p.at}` : p.fault })));
  }

  // --- seams ---------------------------------------------------------------

  /** Blue's LLM, wrapped: its call may fail (429/5xx/hang) or its proposal come back malformed or empty. */
  llm(inner: Fixer = this.llmInner): Fixer {
    const self = this;
    return {
      name: inner.name,
      async propose(ctx: FixContext): Promise<Proposal | null> {
        const f = self.take('blue-llm');
        if (f === '429') throw new InjectedHttpError(429, 'rate_limit_error: too many requests (self-chaos)');
        if (f === '5xx') throw new InjectedHttpError(503, 'overloaded_error: service unavailable (self-chaos)');
        if (f === 'timeout') return new Promise<never>(() => {}); // never answers; the fixer's deadline must cut it
        const p = await inner.propose(ctx);
        const m = self.take('blue-proposal');
        if (m === 'malformed') return { ...(p ?? { title: '', rationale: '' }), strategy: undefined, files: { [Object.keys(ctx.files)[0]]: 42 } } as unknown as Proposal;
        if (m === 'empty') return { strategy: 'empty', title: '', rationale: '', files: { ...ctx.files }, author: inner.name };
        return p;
      },
    };
  }

  /** Damages a checkpoint file just before it is restored. Returns the fault, if one was injected. */
  checkpoint(path: string): string | undefined {
    const f = this.take('checkpoint');
    if (f === 'corrupt' && existsSync(path)) writeFileSync(path, '{"id": "ckpt", "files": {"agent.ts": "trunc');
    if (f === 'missing') rmSync(path, { force: true });
    return f;
  }

  /** Breaks a materialized patch (a syntax error in its first edited file) before the Judge loads it. */
  workspace(dir: string, editedFiles: string[]): string | undefined {
    const f = this.take('workspace');
    if (f === 'syntax-error') appendFileSync(join(dir, editedFiles[0] ?? 'agent.ts'), '\nexport const = ((( // self-chaos: broken patch\n');
    return f;
  }

  /**
   * neatlogs is down: export (flush) never completes, and read-back gets connection errors and 503s.
   * Returns the hooks the loop uses for this fault's observe step, if one was injected.
   */
  neatlogs(): { fault: string; apiKey: string; fetcher: Fetcher; flush: () => Promise<boolean>; traceId: string } | undefined {
    const f = this.take('neatlogs');
    if (!f) return undefined;
    let calls = 0;
    return {
      fault: 'neatlogs down (export hangs, read-back 503 / connection refused)',
      apiKey: 'self-chaos-key',
      // The traced re-run's trace id: export "succeeded" locally, but neatlogs never has it.
      traceId: 'deadbeefdeadbeefdeadbeefdeadbeef',
      flush: () => new Promise<boolean>(() => {}),
      fetcher: async () => {
        if (calls++ % 2 === 0) throw Object.assign(new Error('connect ECONNREFUSED api.neatlogs.com:443'), { code: 'ECONNREFUSED' });
        return { status: 503, json: async () => ({ error: 'service unavailable' }) };
      },
    };
  }

  /** The scorecard's per-trial hook: throws inside Bulwark's harness when a trial fault is due. */
  readonly beforeTrial = (t: { fault: string; index: number }): void => {
    const key = `${t.fault}#${t.index}`;
    if (this.sticky.delete(key)) throw new Error(`worker for ${key} crashed again (self-chaos)`);
    const f = this.take('trial');
    if (f === 'throw-twice') this.sticky.add(key);
    if (f) throw new Error(`worker for ${key} crashed: EPIPE (self-chaos)`);
  };
}

/** Flushes traces without letting a hung or failing exporter stall the loop. Resolves false on failure or timeout. */
export async function flushWithin(flush: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      flush().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
