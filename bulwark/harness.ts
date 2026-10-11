// Runs one sandboxed trial of the target agent under one fault, and records what
// actually happened: outcome, timing, steps, and the real side effects taken
// from the target's sandbox ledger rather than from the agent's own claims.

import { trace } from 'neatlogs';
import { injectFault, injectTicket, type Fault } from './chaos/faults';
import { TrialRecorder, type TrialEvent } from './recorder';
import { countTrial, recordLlmCall } from './cost/meter';
import { mulberry32 } from './stats';
import type { Brain, BrainMode, BulwarkTarget } from './target';
import { isExporting, untraced } from './tracing';

export type Outcome = 'completed' | 'crashed' | 'hung' | 'runaway';
export type { BrainMode };

// RefundBot's ledger entries, typed for the refund rules and the dollars-at-risk model.
export interface OrderRecord {
  id: string;
  email: string;
  total: number;
  [key: string]: unknown;
}
export interface RefundRecord {
  id: string;
  orderId: string;
  amount: number;
  idempotencyKey?: string;
}
export interface EmailRecord {
  to: string;
  subject: string;
  body: string;
}

export interface TrialObservation {
  seed: number;
  outcome: Outcome;
  error?: string;
  durationMs: number;
  steps: number;
  faultsFired: number;
  reply?: string;
  /** The ticket the agent actually handled (after any ticket-level fault). */
  ticket?: Record<string, unknown>;
  /** The fixtures the sandbox was built from (minus the ticket), for rules that compare against them. */
  fixtures?: Record<string, unknown>;
  /** The target's sandbox ledger, keyed by effect type (target.observe), e.g. { refunds, emails } or { apiCalls }. */
  effects?: Record<string, unknown[]>;
  // Named views of RefundBot's ledger, used by the refund rules and dollars at risk.
  // Filled from the ticket, fixtures and effects when the target has them.
  customerEmail?: string;
  orders?: OrderRecord[];
  refunds?: RefundRecord[];
  emails?: EmailRecord[];
  /** Ordered event timeline, only when the trial ran with `record: true`. */
  timeline?: TrialEvent[];
  /** neatlogs trace id, when this trial was traced. */
  traceId?: string;
}

export interface TrialOptions {
  target: BulwarkTarget;
  fault?: Fault;
  seed: number;
  brain: BrainMode;
  /** Model override for LLM brains (default: the target's own choice). */
  model?: string;
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
  const sandbox = opts.target.createSandbox(fixtures);
  const observe = () => opts.target.observe(sandbox);
  const abort = new AbortController();
  const rec = opts.record ? new TrialRecorder() : undefined;
  const faultCtx = { rng: mulberry32(opts.seed), signal: abort.signal, fired: 0, onEvent: rec?.fault };
  // Social-engineering faults attack through the conversation: they rewrite the ticket, not the wire.
  const ticket = injectTicket(fixtures.ticket, opts.fault, faultCtx);
  const service = opts.target.createTransport(sandbox, abort.signal);
  const injected = injectFault(rec ? rec.serviceSide(service, observe) : service, opts.fault, faultCtx);
  const transport = rec ? rec.agentSide(injected) : injected;

  // Every LLM call the target makes is priced on the current run's cost meter.
  const inner: Brain = opts.target.createBrain(opts.brain, mulberry32(opts.seed ^ 0x9e3779b9), {
    model: opts.model,
    onUsage: (u) => recordLlmCall({ role: 'agent', ...u }),
  });
  countTrial();
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

    const effects = Object.fromEntries(Object.entries(observe()).map(([k, v]) => [k, [...v]]));
    const { ticket: _t, ...rest } = fixtures as Record<string, unknown>;
    const obs: TrialObservation = {
      seed: opts.seed,
      outcome,
      error,
      durationMs: performance.now() - start,
      steps: Math.min(steps, opts.maxSteps + 1),
      faultsFired: faultCtx.fired,
      reply,
      ticket: ticket as Record<string, unknown>,
      fixtures: rest,
      effects,
      ...refundView(ticket, rest, effects),
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
    async (span) => {
      const obs = await body();
      // The trial span sits inside its phase's root trace, so this is the id to read back from
      // neatlogs (bulwark/observe/neatlogs.ts narrows the trace to this trial by its seed).
      // Only recorded when exporting: otherwise the id names a trace that exists nowhere.
      const traceId = span?.spanContext?.().traceId;
      if (isExporting() && traceId && !/^0+$/.test(traceId)) obs.traceId = traceId;
      return obs;
    },
  );
}

/** RefundBot's named fields (customer, orders, refunds, emails), only for keys the target actually has. */
function refundView(ticket: Record<string, unknown>, fixtures: Record<string, unknown>, effects: Record<string, unknown[]>): Partial<TrialObservation> {
  const view: Partial<TrialObservation> = {};
  if (typeof ticket.customerEmail === 'string') view.customerEmail = ticket.customerEmail;
  if (Array.isArray(fixtures.orders)) view.orders = fixtures.orders as OrderRecord[];
  if (effects.refunds) view.refunds = effects.refunds as RefundRecord[];
  if (effects.emails) view.emails = effects.emails as EmailRecord[];
  return view;
}
