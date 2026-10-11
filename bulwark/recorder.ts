// Opt-in, per-trial event recorder for the replay viewer. It watches a trial at
// three points: the brain's decisions, the wire as the agent sees it (after any
// fault), and the wire as the services see it (before any fault, where side
// effects land in the sandbox ledger). It never touches randomness or results,
// so a recorded trial behaves exactly like an unrecorded one with the same seed.

import type { Decision } from '../targets/refundbot/agent';
import type { Endpoint, PaymentsSandbox, Transport } from '../targets/refundbot/payments';
import type { FaultEvent } from './chaos/faults';

interface Base {
  /** Position in the timeline. */
  i: number;
  /** Milliseconds since the trial started. Wall-clock, so it is not part of the deterministic replay. */
  t: number;
}

export type TrialEvent = Base &
  (
    | { type: 'brain'; step: number; decision: Decision }
    | { type: 'call'; call: number; endpoint: Endpoint; input: Record<string, unknown>; attempt: number; retryOf?: number }
    | { type: 'result'; call: number; endpoint: Endpoint; output: unknown; ms: number; late?: boolean }
    | { type: 'error'; call: number; endpoint: Endpoint; error: string; ms: number; late?: boolean }
    | { type: 'timeout'; call: number; endpoint: Endpoint; afterMs: number; detail: string }
    | { type: 'fault'; call: number; fault: string; kind: string; endpoint: Endpoint; detail: string }
    | { type: 'effect'; effect: 'refund' | 'email'; data: unknown }
    | { type: 'outcome'; outcome: string; error?: string; reply?: string; steps: number; durationMs: number }
  );

type Draft = TrialEvent extends infer E ? (E extends TrialEvent ? Omit<E, 'i' | 't'> : never) : never;

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // e.g. truncated JSON: show exactly what the agent received
  }
};

export class TrialRecorder {
  readonly events: TrialEvent[] = [];
  private start = performance.now();
  private stopped = false;
  private calls = 0;
  /** The call the agent is currently making, so a fault fired inside it can point back to it. */
  private current = 0;
  private pending = new Map<number, { endpoint: Endpoint; at: number; superseded: boolean }>();
  private attempts = new Map<Endpoint, number>();

  private now = () => performance.now() - this.start;

  private push(e: Draft) {
    if (this.stopped) return;
    this.events.push({ i: this.events.length, t: Math.round(this.now()), ...e } as TrialEvent);
  }

  /** Freezes the timeline; anything a wound-down run does afterwards is ignored. */
  stop() {
    this.stopped = true;
  }

  brain(step: number, decision: Decision) {
    this.push({ type: 'brain', step, decision });
  }

  /** For FaultContext.onEvent. */
  fault = (e: FaultEvent) => {
    this.push({ type: 'fault', call: this.current, fault: e.fault, kind: e.kind, endpoint: e.endpoint, detail: e.title });
  };

  outcome(o: { outcome: string; error?: string; reply?: string; steps: number; durationMs: number }) {
    // Calls nobody is waiting on any more: a timed-out request, or the one a hung run was stuck on.
    for (const [call, p] of this.pending) {
      if (p.superseded) continue;
      p.superseded = true;
      const afterMs = Math.round(this.now() - p.at);
      this.push({ type: 'timeout', call, endpoint: p.endpoint, afterMs, detail: `call #${call} still in flight after ~${afterMs}ms when the run ended (${o.outcome})` });
    }
    const { outcome, error, reply, steps } = o;
    this.push({ type: 'outcome', outcome, ...(error ? { error } : {}), ...(reply !== undefined ? { reply } : {}), steps, durationMs: Math.round(o.durationMs) });
  }

  /** Wraps the transport the agent calls (outermost, after fault injection). */
  agentSide(transport: Transport): Transport {
    return async (endpoint, payload) => {
      const call = ++this.calls;
      const at = this.now();
      // The agent never tells the wire it gave up, but a second call to the same
      // endpoint while the first is still in flight means it timed out and retried.
      const inFlight = [...this.pending].filter(([, p]) => p.endpoint === endpoint && !p.superseded);
      let retryOf: number | undefined;
      for (const [id, p] of inFlight) {
        p.superseded = true;
        retryOf = id;
        const afterMs = Math.round(at - p.at);
        this.push({
          type: 'timeout',
          call: id,
          endpoint,
          afterMs,
          detail: `agent stopped waiting for call #${id} after ~${afterMs}ms; the request is still in flight`,
        });
      }
      const attempt = (this.attempts.get(endpoint) ?? 0) + 1;
      this.attempts.set(endpoint, attempt);
      this.pending.set(call, { endpoint, at, superseded: false });
      this.push({ type: 'call', call, endpoint, input: payload, attempt, ...(retryOf ? { retryOf } : {}) });

      this.current = call;
      const res = transport(endpoint, payload);
      this.current = 0;
      try {
        const raw = await res;
        const p = this.pending.get(call)!;
        this.push({ type: 'result', call, endpoint, output: parse(raw), ms: Math.round(this.now() - at), ...(p.superseded ? { late: true } : {}) });
        return raw;
      } catch (err) {
        const p = this.pending.get(call)!;
        const error = err instanceof Error ? err.message : String(err);
        this.push({ type: 'error', call, endpoint, error, ms: Math.round(this.now() - at), ...(p.superseded ? { late: true } : {}) });
        throw err;
      } finally {
        this.pending.delete(call);
      }
    };
  }

  /** Wraps the services' transport (innermost, before fault injection) to catch real side effects. */
  serviceSide(transport: Transport, sandbox: PaymentsSandbox): Transport {
    return async (endpoint, payload) => {
      const refunds = sandbox.refunds.length;
      const emails = sandbox.emails.length;
      try {
        return await transport(endpoint, payload);
      } finally {
        for (const r of sandbox.refunds.slice(refunds)) this.push({ type: 'effect', effect: 'refund', data: { ...r } });
        for (const e of sandbox.emails.slice(emails)) this.push({ type: 'effect', effect: 'email', data: { ...e } });
      }
    };
  }
}

/** The timeline without wall-clock fields: what must be identical across replays of one seed. */
export function stableTimeline(events: TrialEvent[]): unknown[] {
  return events.map(({ t: _t, ...e }) => {
    const { ms: _ms, afterMs: _a, durationMs: _d, detail, ...rest } = e as Record<string, unknown>;
    // Timeout details embed a wall-clock duration; the rest of the detail text is stable.
    return e.type === 'timeout' ? rest : { ...rest, ...(detail !== undefined ? { detail } : {}) };
  });
}
