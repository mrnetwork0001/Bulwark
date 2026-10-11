// Reads traces back from neatlogs, so Blue diagnoses a failure from what
// neatlogs actually recorded (spans, errors, and neatlogs' own detections), not
// only from Bulwark's local observation. Best-effort: traces take a while to
// finalize, and when one isn't ready in time Blue falls back to local evidence.

const ENDPOINT = () => (process.env.NEATLOGS_ENDPOINT || 'https://ingest.neatlogs.com').replace(/\/$/, '');

export interface NeatlogsTrace {
  _id: string;
  name?: string;
  status?: string;
  finalizationStatus?: string;
  hasError?: boolean;
  spans?: NeatlogsSpan[];
  detections?: unknown[];
  traceDetections?: unknown[];
  [key: string]: unknown;
}

interface NeatlogsSpan {
  node_type?: string;
  node_name?: string;
  status?: string;
  createdAt?: string;
  detections?: unknown[];
  data?: Record<string, unknown>;
}

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Polls until the trace is finalized with spans, or the wait budget runs out. */
export async function readTrace(traceId: string, opts: { waitMs?: number; pollMs?: number; fetcher?: Fetcher } = {}): Promise<NeatlogsTrace | null> {
  const key = process.env.NEATLOGS_API_KEY;
  if (!key || !traceId) return null;
  const fetcher = opts.fetcher ?? (fetch as unknown as Fetcher);
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  while (true) {
    try {
      const res = await fetcher(`${ENDPOINT()}/api/traces/v3/${encodeURIComponent(traceId)}`, { headers: { 'x-api-key': key } });
      if (res.status === 401 || res.status === 403 || res.status === 404) return null;
      if (res.status === 200) {
        const trace = (await res.json()) as NeatlogsTrace;
        if (trace.spans?.length) return trace;
      }
    } catch {
      // network hiccup: keep polling until the deadline
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 3000));
  }
}

const clip = (v: unknown, n: number) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

/** A compact, model-friendly digest of a trace: detections first, then the span timeline. */
export function summarizeTrace(trace: NeatlogsTrace, maxSpans = 40): string {
  const spans = [...(trace.spans ?? [])].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const detections = [...(trace.detections ?? []), ...(trace.traceDetections ?? []), ...spans.flatMap((s) => s.detections ?? [])];
  const lines = [`neatlogs trace ${trace._id} "${trace.name ?? ''}": ${spans.length} spans${trace.hasError ? ', has errors' : ''}`];
  for (const d of detections.slice(0, 8)) lines.push(`neatlogs detection: ${clip(d, 300)}`);
  for (const s of spans.slice(0, maxSpans)) {
    const d = s.data ?? {};
    const bits = [
      `${s.node_type ?? ''} ${s.node_name ?? ''}`.trim(),
      s.status ? `status=${s.status}` : '',
      d.duration_ms ? `${d.duration_ms}ms` : '',
      d.tool_name && d.input_value ? `input=${clip(d.input_value, 120)}` : '',
      d.output_value ? `output=${clip(d.output_value, 160)}` : '',
      d.error_message ? `error=${d.error_type ?? ''}: ${clip(d.error_message, 160)}` : '',
    ];
    lines.push(`- ${bits.filter(Boolean).join(' ')}`);
  }
  return lines.join('\n');
}
