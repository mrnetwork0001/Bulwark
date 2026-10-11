// Observe step: before Blue proposes a fix, read a failing trial's trace back
// from neatlogs and hand Blue what neatlogs recorded. Bounded by a wait budget,
// never throws, and degrades to "unavailable" without a key.
//
// neatlogs finalizes traces asynchronously and not always within a run (see
// docs/NEATLOGS.md), so candidates are tried oldest first: a failing trial
// from the previous run on the same code (trials replay deterministically from
// their seed, so it is the same failure, and it has had minutes to finalize),
// then this run's BEFORE scorecard, then the Judge's baseline, then a traced
// re-run of one failing seed.

import { focusTrial, readTrace, summarizeTrace, type Fetcher, type ReadResult, type ReadStatus } from './neatlogs';

export interface ObserveCandidate {
  seed: number;
  traceId?: string;
  /** Where the failing trial came from. */
  source: 'previous' | 'before' | 'judge' | 'rerun';
}

export interface ObserveRecord {
  fault: string;
  traceId?: string;
  seed?: number;
  source?: ObserveCandidate['source'];
  status: ReadStatus;
  /** Spans of the failing trial (the trace is narrowed to it). */
  spans: number;
  detections: number;
  waitedMs: number;
  reason?: string;
  stage?: string;
  /** Set when the trace was still pending for Blue but had finalized by the end of the run. */
  late?: boolean;
}

export interface ObserveOptions {
  fault: string;
  /** Failing trials, best first. */
  candidates: ObserveCandidate[];
  /** Re-runs one failing seed traced and returns its trace id (trials replay deterministically from a seed). */
  rerun?: (seed: number) => Promise<string | undefined>;
  waitMs: number;
  pollMs?: number;
  fetcher?: Fetcher;
  /** neatlogs API key (default NEATLOGS_API_KEY); the self-chaos seam points read-back at an outage with it. */
  apiKey?: string;
  /** Reads already made in this run, by trace id; phase traces hold every fault's trials, so one read serves many faults. */
  cache?: Map<string, ReadResult>;
}

const SOURCE_LABEL: Record<ObserveCandidate['source'], string> = {
  previous: "previous run's BEFORE scorecard (same code, same seed)",
  before: 'BEFORE scorecard',
  judge: "Judge's baseline",
  rerun: 'traced re-run',
};

/** Turns a successful read into the record's span/detection counts and Blue's evidence. */
function digest(record: ObserveRecord, res: ReadResult, fault: string): string | undefined {
  if (res.status !== 'read' || !res.trace || record.seed === undefined) return undefined;
  const focus = { fault, seed: record.seed };
  const spans = focusTrial(res.trace, focus);
  record.spans = spans.length;
  record.detections = [...(res.trace.detections ?? []), ...(res.trace.traceDetections ?? []), ...spans.flatMap((s) => s.detections ?? [])].length;
  return summarizeTrace(res.trace, { focus });
}

export async function observeFailure(o: ObserveOptions): Promise<{ record: ObserveRecord; evidence?: string }> {
  const base = { fault: o.fault, spans: 0, detections: 0, waitedMs: 0 };
  if (o.waitMs <= 0) return { record: { ...base, status: 'unavailable', reason: 'neatlogs read-back disabled (wait 0)' } };
  if (!(o.apiKey ?? process.env.NEATLOGS_API_KEY)) return { record: { ...base, status: 'unavailable', reason: 'NEATLOGS_API_KEY not set' } };

  const seen = new Set<string>();
  const traced = o.candidates.filter((c) => c.traceId && !seen.has(c.traceId) && seen.add(c.traceId));
  if (!traced.some((c) => c.source !== 'previous') && o.rerun && o.candidates.length) {
    const seed = o.candidates.find((c) => c.source !== 'previous')?.seed ?? o.candidates[0].seed;
    try {
      const traceId = await o.rerun(seed);
      if (traceId) traced.push({ seed, traceId, source: 'rerun' });
    } catch {
      // no trace to read from the re-run
    }
  }
  if (!traced.length) return { record: { ...base, status: 'unavailable', reason: 'no traced failing trial' } };

  const started = Date.now();
  let best: ObserveRecord | undefined;
  let fullWaitUsed = false;
  for (const c of traced) {
    const cached = o.cache?.get(c.traceId!);
    // Older traces either finalized long ago or never will: one check. The first trace from this run
    // gets the wait budget; a trace that was already pending earlier in the run gets one re-check.
    const wait = cached || c.source === 'previous' || fullWaitUsed ? 0 : Math.max(0, o.waitMs - (Date.now() - started));
    if (wait > 0) fullWaitUsed = true;
    const res = cached?.status === 'read' ? cached : await readTrace(c.traceId, { waitMs: wait, pollMs: o.pollMs, fetcher: o.fetcher, apiKey: o.apiKey });
    o.cache?.set(c.traceId!, res);
    const record: ObserveRecord = {
      ...base,
      traceId: c.traceId,
      seed: c.seed,
      source: c.source,
      status: res.status,
      waitedMs: Date.now() - started,
      ...(res.reason ? { reason: res.reason } : {}),
      ...(res.stage ? { stage: res.stage } : {}),
    };
    const evidence = digest(record, res, o.fault);
    if (evidence) return { record, evidence };
    // Report the most useful miss: this run's pending trace over an old or unavailable one.
    const rank = (r: ObserveRecord) => (r.status === 'pending' ? 2 : 0) + (r.source === 'previous' ? 0 : 1);
    if (!best || rank(record) > rank(best)) best = record;
  }
  return { record: best! };
}

/**
 * End of run: one more look at traces that were still pending when Blue needed them. A trace that
 * has finalized since is recorded as a late read for the postmortem (Blue still used local evidence).
 */
export async function recheckPending(records: (ObserveRecord | undefined)[], opts: { fetcher?: Fetcher; cache?: Map<string, ReadResult> } = {}): Promise<number> {
  let late = 0;
  for (const r of records) {
    if (r?.status !== 'pending' || !r.traceId) continue;
    const res = opts.cache?.get(r.traceId)?.status === 'read' ? opts.cache.get(r.traceId)! : await readTrace(r.traceId, { waitMs: 0, fetcher: opts.fetcher });
    opts.cache?.set(r.traceId, res);
    if (res.status !== 'read') {
      if (res.status === 'unavailable' && res.reason) r.reason = `${r.reason ?? 'pending'}; at end of run: ${res.reason}`;
      continue;
    }
    r.status = 'read';
    r.late = true;
    digest(r, res, r.fault);
    late++;
  }
  return late;
}

/** The postmortem / CLI line for one observe step. */
export function describeObserve(r: ObserveRecord): string {
  const from = r.source ? `; failing trial seed ${r.seed} from the ${SOURCE_LABEL[r.source]}` : '';
  if (r.status === 'read' && r.late) return `neatlogs trace ${r.traceId} finalized only after Blue ran (${r.spans} spans, ${r.detections} detections${from}); Blue used local evidence.`;
  if (r.status === 'read') return `Diagnosed from neatlogs trace ${r.traceId} (${r.spans} spans, ${r.detections} detections${from}).`;
  if (r.status === 'pending') return `neatlogs trace ${r.traceId} not finalized in time (${r.reason ?? 'pending'}${r.stage ? `, last state: ${r.stage}` : ''}); used local evidence.`;
  return `neatlogs read-back unavailable (${r.reason ?? 'unknown'}${r.traceId ? `, trace ${r.traceId}` : ''}); used local evidence.`;
}
