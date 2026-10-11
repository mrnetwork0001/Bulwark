// Runs one sandboxed trial of the target agent under one fault, and records what
// actually happened: outcome, timing, steps, and the real side effects (refunds,
// emails) taken from the sandbox ledger rather than from the agent's own claims.

import { trace } from 'neatlogs';
import type { Brain } from '../targets/refundbot/agent';
import type { Email, Order, Refund } from '../targets/refundbot/payments';
import { injectFault, injectTicket, type Fault } from './chaos/faults';
import { TrialRecorder, type TrialEvent } from './recorder';
import { mulberry32 } from './stats';
import type { BrainMode, BulwarkTarget } from './target';
import { untraced } from './tracing';

export type Outcome = 'completed' | 'crashed' | 'hung' | 'runaway';
export type { BrainMode };

export interface TrialObservation {
  seed: number;
  outcome: Outcome;
  error?: string;
  durationMs: number;
  steps: number;
  faultsFired: number;
  reply?: string;
  customerEmail: string;
  orders: Order[];
  refunds: Refund[];
  emails: Email[];
  /** Ordered event timeline, only when the trial ran with `record: true`. */
  timeline?: TrialEvent[];
}

export interface TrialOptions {
  target: BulwarkTarget;
  fault?: Fault;
  seed: number;
  brain: BrainMode;
  /** Wall-clock budget before the trial is declared hung. */
  deadlineMs: number;
  /** Safety net so a looping agent can't run forever; exceeding it is a "runaway". */
  maxSteps: number;
  /** Export this trial's spans to neatlogs. Experiments trace a sample; the rest run quietly. */
  traced?: boolean;
  /** Capture a step-by-step timeline for the replay viewer. Doesn't change results or randomness. */
  record?: boolean;
}

class StepCapExceeded extends Error {}

export async function runTrial(opts: TrialOptions): Promise<TrialObservation> {
  const fixtures = opts.target.fixtures();
  const { orders } = fixtures;
  const sandbox = opts.target.createSandbox(orders);
  const abort = new AbortController();
  const rec = opts.record ? new TrialRecorder() : undefined;
  const faultCtx = { rng: mulberry32(opts.seed), signal: abort.signal, fired: 0, onEvent: rec?.fault };
  // Social-engineering faults attack through the conversation: they rewrite the ticket, not the wire.
  const ticket = injectTicket(fixtures.ticket, opts.fault, faultCtx);
  const service = opts.target.createTransport(sandbox, abort.signal);
  const injected = injectFault(rec ? rec.serviceSide(service, sandbox) : service, opts.fault, faultCtx);
  const transport = rec ? rec.agentSide(injected) : injected;

  const inner: Brain = opts.target.createBrain(opts.brain, mulberry32(opts.seed ^ 0x9e3779b9));
  let steps = 0;
  const brain: Brain = {
    name: inner.name,
    decide: async (ctx) => {
      if (abort.signal.aborted) throw new Error('aborted');
      if (++steps > opts.maxSteps) throw new StepCapExceeded(`exceeded ${opts.maxSteps} steps`);
      if (!rec) return inner.decide(ctx);
      const decision = await inner.decide(ctx);
      rec.brain(steps, decision);
      return decision;
    },
  };

  const body = async (): Promise<TrialObservation> => {
    const start = performance.now();
    let outcome: Outcome = 'completed';
    let error: string | undefined;
    let reply: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'hung'>((resolve) => {
      timer = setTimeout(() => resolve('hung'), opts.deadlineMs);
    });

    const run = opts.target.run(ticket, { transport, brain });
    try {
      const res = await Promise.race([run, deadline]);
      if (res === 'hung') outcome = 'hung';
      else reply = res.reply;
    } catch (err) {
      outcome = err instanceof StepCapExceeded ? 'runaway' : 'crashed';
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }

    const obs: TrialObservation = {
      seed: opts.seed,
      outcome,
      error,
      durationMs: performance.now() - start,
      steps: Math.min(steps, opts.maxSteps + 1),
      faultsFired: faultCtx.fired,
      reply,
      customerEmail: ticket.customerEmail,
      orders,
      refunds: [...sandbox.refunds],
      emails: [...sandbox.emails],
    };
    if (rec) {
      rec.outcome(obs);
      obs.timeline = rec.events;
    }

    // A hung run keeps going in the background until it notices the abort.
    // Let it wind down inside this trial, so none of its spans end after the
    // trial (and its trace) has closed.
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([run.catch(() => {}), new Promise((r) => (grace = setTimeout(r, 1000)))]);
    clearTimeout(grace);
    rec?.stop();
    return obs;
  };

  if (opts.traced === false) return untraced(body);
  return trace(
    { name: 'bulwark.trial', kind: 'CHAIN', attributes: { target: opts.target.name, fault: opts.fault?.id ?? 'none', seed: opts.seed } },
    body,
  );
}
