// Reads traces back from neatlogs, so Blue diagnoses a failure from what
// neatlogs actually recorded (spans, errors, and neatlogs' own detections), not
// only from Bulwark's local observation. Best-effort: traces take a while to
// finalize, and when one isn't ready in time Blue falls back to local evidence.
// See docs/NEATLOGS.md for measured finalization times.

const ENDPOINT = () => (process.env.NEATLOGS_ENDPOINT || 'https://ingest.neatlogs.com').replace(/\/$/, '');

export interface NeatlogsTrace {
  _id: string;
  name?: string;
  status?: string;
  finalizationStatus?: string;
  hasError?: boolean | number;
  spans?: NeatlogsSpan[];
  detections?: unknown[];
  traceDetections?: unknown[];
  [key: string]: unknown;
}

export interface NeatlogsSpan {
  span_id?: string;
  parent_span_id?: string;
  node_type?: string;
  node_name?: string;
  status?: string;
  createdAt?: string;
  detections?: unknown[];
  span_metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * read: finalized with spans. pending: neatlogs hasn't finalized it (202, or 404 while the
 * trace isn't visible yet) within the wait budget. unavailable: no key, no trace id, auth
 * failure, a terminal ingestion failure (409), or reading disabled.
 */
export type ReadStatus = 'read' | 'pending' | 'unavailable';

export interface ReadResult {
  status: ReadStatus;
  trace?: NeatlogsTrace;
  /** Last HTTP status seen (0 = network error, undefined = never asked). */
  http?: number;
  /** neatlogs' finalizationStatus / ingestion stage on the last pending response. */
  stage?: string;
  reason?: string;
  waitedMs: number;
}

/**
 * Polls GET /api/traces/v3/<id> until the trace is finalized with spans, or the wait budget runs out.
 * Mirrors the neatlogs SDK's own doctor read-back: 202 and 404 mean "not ready yet, keep polling",
 * 401/403 mean the key was rejected, 409 is a terminal ingestion failure.
 */
export async function readTrace(traceId: string | undefined, opts: { waitMs?: number; pollMs?: number; fetcher?: Fetcher; apiKey?: string } = {}): Promise<ReadResult> {
  const started = Date.now();
  const key = opts.apiKey ?? process.env.NEATLOGS_API_KEY;
  if (!key) return { status: 'unavailable', reason: 'NEATLOGS_API_KEY not set', waitedMs: 0 };
  if (!traceId) return { status: 'unavailable', reason: 'no traced failing trial', waitedMs: 0 };
  const fetcher = opts.fetcher ?? (fetch as unknown as Fetcher);
  const deadline = started + Math.max(0, opts.waitMs ?? 20_000);
  let http: number | undefined;
  let stage: string | undefined;
  while (true) {
    try {
      const res = await fetcher(`${ENDPOINT()}/api/traces/v3/${encodeURIComponent(traceId)}`, { headers: { 'x-api-key': key } });
      http = res.status;
      if (res.status === 401 || res.status === 403) return { status: 'unavailable', http, reason: 'neatlogs rejected the API key', waitedMs: Date.now() - started };
      const body = (await res.json().catch(() => ({}))) as NeatlogsTrace & { ingestionDiagnostics?: { stage?: string } };
      if (res.status === 409) return { status: 'unavailable', http, reason: `neatlogs ingestion failed (${body.finalizationStatus ?? 'terminal'})`, waitedMs: Date.now() - started };
      if (res.status === 200 && body.spans?.length) return { status: 'read', trace: body, http, waitedMs: Date.now() - started };
      stage = body.finalizationStatus ?? body.ingestionDiagnostics?.stage ?? (res.status === 404 ? 'not visible yet' : stage);
    } catch {
      http = 0; // network hiccup: keep polling until the deadline
    }
    if (Date.now() >= deadline) return { status: 'pending', http, stage, reason: `not finalized within ${Math.round((deadline - started) / 1000)}s`, waitedMs: Date.now() - started };
    await new Promise((r) => setTimeout(r, Math.min(opts.pollMs ?? 2000, Math.max(0, deadline - Date.now()))));
  }
}

const clip = (v: unknown, n: number) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Every detection in the trace: trace-level plus per-span. */
export function traceDetections(trace: NeatlogsTrace): unknown[] {
  return [...(trace.detections ?? []), ...(trace.traceDetections ?? []), ...(trace.spans ?? []).flatMap((s) => s.detections ?? [])];
}

/**
 * The spans of one trial inside a bigger trace. Bulwark's traced trials are `bulwark.trial`
 * spans nested in a phase trace (e.g. "2 red: attack scorecard BEFORE", which holds every fault's
 * sample trials), so the read-back is narrowed to the trial with this fault and seed and its descendants.
 */
export function focusTrial(trace: NeatlogsTrace, focus: { fault?: string; seed?: number }): NeatlogsSpan[] {
  const spans = trace.spans ?? [];
  const meta = (s: NeatlogsSpan) => ({ ...(s.span_metadata ?? {}), ...(s.data ?? {}) }) as Record<string, unknown>;
  const root = spans.find((s) => {
    if (s.node_name !== 'bulwark.trial') return false;
    const m = meta(s);
    return (focus.seed === undefined || String(m.seed) === String(focus.seed)) && (focus.fault === undefined || m.fault === undefined || m.fault === focus.fault);
  });
  if (!root?.span_id) return spans;
  const keep = new Set([root.span_id]);
  // Children can be listed before parents; repeat until no new descendants turn up.
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of spans) {
      if (s.span_id && s.parent_span_id && keep.has(s.parent_span_id) && !keep.has(s.span_id)) {
        keep.add(s.span_id);
        grew = true;
      }
    }
  }
  return spans.filter((s) => s.span_id && keep.has(s.span_id));
}

/** A compact, model-friendly digest of a trace: detections first, then the span timeline. */
export function summarizeTrace(trace: NeatlogsTrace, opts: { maxSpans?: number; focus?: { fault?: string; seed?: number } } = {}): string {
  const all = trace.spans ?? [];
  const picked = opts.focus ? focusTrial(trace, opts.focus) : all;
  const spans = [...picked].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const detections = [...(trace.detections ?? []), ...(trace.traceDetections ?? []), ...spans.flatMap((s) => s.detections ?? [])];
  const scope = picked.length < all.length ? ` (${spans.length} of ${all.length} spans: the trial with seed ${opts.focus?.seed})` : `: ${spans.length} spans`;
  const lines = [`neatlogs trace ${trace._id} "${trace.name ?? ''}"${scope}${trace.hasError ? ', has errors' : ''}`];
  for (const d of detections.slice(0, 8)) lines.push(`neatlogs detection: ${clip(d, 300)}`);
  for (const s of spans.slice(0, opts.maxSpans ?? 40)) {
    const d = s.data ?? {};
    const tool = (d.tool_name as string) || (s.span_metadata?.tool_name as string) || (s.node_type === 'tool_call' ? s.node_name : '');
    const bits = [
      `${s.node_type ?? ''} ${s.node_name ?? ''}`.trim(),
      s.status ? `status=${s.status}` : '',
      typeof d.duration_ms === 'number' ? `${Math.round(d.duration_ms)}ms` : '',
      tool && d.input_value ? `input=${clip(d.input_value, 120)}` : '',
      d.output_value ? `output=${clip(d.output_value, 160)}` : '',
      d.error_message ? `error=${d.error_type ?? ''}: ${clip(d.error_message, 160)}` : '',
    ];
    lines.push(`- ${bits.filter(Boolean).join(' ')}`);
  }
  return lines.join('\n');
}
