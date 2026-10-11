// Replay real failures: every failing trial Bulwark has ever recorded is a
// reproducible incident (target, fault, seed). This module collects them from
// past runs (.bulwark/runs/*/summary.json) and, best effort, from neatlogs
// traces (the `bulwark.trial` spans carry fault and seed), re-runs each one
// against the current code, and reports which still fail and which are fixed.
// Still-failing incidents can be written as chaos regression specs.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChaosSpec } from './guard';
import { hashFiles } from './loop/orchestrator';
import type { Fetcher, NeatlogsSpan, NeatlogsTrace, ReadResult } from './observe/neatlogs';
import { readTrace } from './observe/neatlogs';
import { replayTrial, resolveReplayDir } from './replay';
import type { ExperimentResult } from './scorecard';
import { loadTarget, resolveTargetDir, type BulwarkTarget } from './target';
import { readFiles } from './workspace';

/** The parts of a loop run's summary.json this module reads. Older runs have examples but no perTrial. */
export interface RunSummary {
  runId: string;
  target: string;
  targetHash?: string;
  before?: Record<string, Partial<Pick<ExperimentResult, 'examples' | 'perTrial'>>>;
  records?: { fault: string; observe?: { traceId?: string; seed?: number } }[];
}

export interface Incident {
  target: string;
  /** Fault id, or "baseline" for a failure with no fault injected. */
  fault: string;
  seed: number;
  /** Rules it broke when it was recorded (known for scorecard examples). */
  rules: string[];
  /** Where it was seen, e.g. "run 2026-10-11T04-41-17-678Z" or "neatlogs trace ab12…". */
  seenIn: string[];
  /** Content hashes of the code it was recorded on, when the run stored one. */
  targetHashes: string[];
}

const SAFE = /^[\w-]{1,128}$/;
export const incidentKey = (i: { target: string; fault: string; seed: number }) => `${i.target}|${i.fault}|${i.seed}`;

/** Past runs' summaries, oldest first. `run` picks one run; `last` keeps the most recent N. */
export function loadRunSummaries(stateDir: string, opts: { run?: string; last?: number } = {}): RunSummary[] {
  const root = join(stateDir, 'runs');
  if (opts.run !== undefined && !SAFE.test(opts.run)) throw new Error('--run must be a plain run id');
  if (!existsSync(root)) return [];
  let ids = readdirSync(root)
    .filter((d) => SAFE.test(d) && existsSync(join(root, d, 'summary.json')))
    .sort();
  if (opts.run) {
    if (!ids.includes(opts.run)) throw new Error(`no run ${opts.run} with a summary.json in ${root}`);
    ids = [opts.run];
  } else if (opts.last) ids = ids.slice(-opts.last);
  return ids.map((id) => {
    const s = JSON.parse(readFileSync(join(root, id, 'summary.json'), 'utf8')) as RunSummary;
    return { runId: s.runId ?? id, target: s.target, targetHash: s.targetHash, before: s.before, records: s.records };
  });
}

function add(map: Map<string, Incident>, inc: Omit<Incident, 'rules' | 'seenIn' | 'targetHashes'> & { rule?: string; seenIn: string; targetHash?: string }) {
  const key = incidentKey(inc);
  const cur = map.get(key) ?? { target: inc.target, fault: inc.fault, seed: inc.seed, rules: [], seenIn: [], targetHashes: [] };
  if (inc.rule && !cur.rules.includes(inc.rule)) cur.rules.push(inc.rule);
  if (!cur.seenIn.includes(inc.seenIn)) cur.seenIn.push(inc.seenIn);
  if (inc.targetHash && !cur.targetHashes.includes(inc.targetHash)) cur.targetHashes.push(inc.targetHash);
  map.set(key, cur);
}

/**
 * The distinct failing (target, fault, seed) triples in these runs' BEFORE scorecards: every failing
 * trial from perTrial, plus the scorecard examples (which name the broken rule, and are all older runs have).
 */
export function collectIncidents(summaries: RunSummary[], into = new Map<string, Incident>()): Incident[] {
  for (const s of summaries) {
    for (const [fault, r] of Object.entries(s.before ?? {})) {
      const base = { target: s.target, fault, seenIn: `run ${s.runId}`, targetHash: s.targetHash };
      for (const t of r.perTrial ?? []) if (!t.passed && Number.isInteger(t.seed)) add(into, { ...base, seed: t.seed });
      for (const e of r.examples ?? []) if (Number.isInteger(e.seed)) add(into, { ...base, seed: e.seed, rule: e.rule });
    }
  }
  return sortIncidents([...into.values()]);
}

const sortIncidents = (xs: Incident[]) => xs.sort((a, b) => a.target.localeCompare(b.target) || a.fault.localeCompare(b.fault) || a.seed - b.seed);

/* ---------- Source 2: neatlogs traces ---------- */

export interface TraceRef {
  traceId: string;
  target: string;
  runs: string[];
  /** fault:seed pairs the run recorded as failing, to recognise a failing trial span in the trace. */
  failing: string[];
}

/** Trace ids the runs recorded for failing trials (scorecard examples and observe steps). */
export function traceRefs(summaries: RunSummary[]): TraceRef[] {
  const refs = new Map<string, TraceRef>();
  const note = (traceId: string | undefined, s: RunSummary, fault: string, seed?: number) => {
    if (!traceId || !/^[0-9a-f]{16,64}$/i.test(traceId)) return;
    const ref = refs.get(traceId) ?? { traceId, target: s.target, runs: [], failing: [] };
    if (!ref.runs.includes(s.runId)) ref.runs.push(s.runId);
    if (seed !== undefined && !ref.failing.includes(`${fault}:${seed}`)) ref.failing.push(`${fault}:${seed}`);
    refs.set(traceId, ref);
  };
  for (const s of summaries) {
    for (const [fault, r] of Object.entries(s.before ?? {})) for (const e of r.examples ?? []) note(e.traceId, s, fault, e.seed);
    for (const rec of s.records ?? []) note(rec.observe?.traceId, s, rec.fault, rec.observe?.seed);
  }
  return [...refs.values()];
}

const spanMeta = (s: NeatlogsSpan): Record<string, unknown> => {
  const m = { ...(s.span_metadata ?? {}), ...(s.data ?? {}) } as Record<string, unknown>;
  // Attributes may come back nested, depending on the neatlogs API version.
  for (const k of ['attributes', 'span_attributes']) if (m[k] && typeof m[k] === 'object') Object.assign(m, m[k] as object);
  return m;
};
const isError = (s: NeatlogsSpan) => /error|fail/i.test(String(s.status ?? '')) || !!spanMeta(s).error_message;

/**
 * Trial incidents in one neatlogs trace. Each `bulwark.trial` span carries the trial's fault and seed.
 * A traced trial is only an incident when it failed: the span or one of its descendants errored or has
 * neatlogs detections, or the run that recorded the trace listed that fault and seed as failing.
 */
export function incidentsFromTrace(trace: NeatlogsTrace, ref: Pick<TraceRef, 'target' | 'failing'>): { fault: string; seed: number; why: string }[] {
  const spans = trace.spans ?? [];
  const children = new Map<string, NeatlogsSpan[]>();
  for (const s of spans) if (s.parent_span_id) children.set(s.parent_span_id, [...(children.get(s.parent_span_id) ?? []), s]);
  const descendants = (root: NeatlogsSpan): NeatlogsSpan[] => {
    const out: NeatlogsSpan[] = [];
    const stack = [...(children.get(root.span_id ?? '') ?? [])];
    while (stack.length) {
      const s = stack.pop()!;
      out.push(s);
      stack.push(...(children.get(s.span_id ?? '') ?? []));
    }
    return out;
  };
  const found = new Map<string, { fault: string; seed: number; why: string }>();
  for (const s of spans) {
    if (s.node_name !== 'bulwark.trial') continue;
    const m = spanMeta(s);
    const seed = Number(m.seed);
    const rawFault = typeof m.fault === 'string' ? m.fault : '';
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !rawFault) continue;
    const fault = rawFault === 'none' ? 'baseline' : rawFault;
    if (!SAFE.test(fault)) continue;
    const tree = [s, ...descendants(s)];
    const why = ref.failing.includes(`${fault}:${seed}`)
      ? 'recorded as failing by its run'
      : tree.some(isError)
        ? 'a span in the trial errored'
        : tree.some((x) => x.detections?.length)
          ? 'neatlogs flagged a detection'
          : '';
    if (why) found.set(`${fault}:${seed}`, { fault, seed, why });
  }
  return [...found.values()];
}

export interface TraceReadReport {
  traceId: string;
  runs: string[];
  status: ReadResult['status'];
  http?: number;
  stage?: string;
  reason?: string;
  trialSpans: number;
  incidents: number;
}

/** Reads each trace once (no waiting by default: old traces either finalized long ago or never will). */
export async function traceIncidents(
  refs: TraceRef[],
  opts: { waitMs?: number; fetcher?: Fetcher; into?: Map<string, Incident> } = {},
): Promise<{ reads: TraceReadReport[]; incidents: Incident[] }> {
  const into = opts.into ?? new Map<string, Incident>();
  const reads: TraceReadReport[] = [];
  for (const ref of refs) {
    const res = await readTrace(ref.traceId, { waitMs: opts.waitMs ?? 0, fetcher: opts.fetcher });
    const found = res.trace ? incidentsFromTrace(res.trace, ref) : [];
    for (const f of found) add(into, { target: ref.target, fault: f.fault, seed: f.seed, seenIn: `neatlogs trace ${ref.traceId}` });
    reads.push({
      traceId: ref.traceId,
      runs: ref.runs,
      status: res.status,
      ...(res.http !== undefined ? { http: res.http } : {}),
      ...(res.stage ? { stage: res.stage } : {}),
      ...(res.reason ? { reason: res.reason } : {}),
      trialSpans: (res.trace?.spans ?? []).filter((s) => s.node_name === 'bulwark.trial').length,
      incidents: found.length,
    });
  }
  return { reads, incidents: sortIncidents([...into.values()]) };
}

/* ---------- The sweep ---------- */

export type SweepStatus = 'still-fails' | 'fixed' | 'skipped';

export interface SweepResult {
  incident: Incident;
  status: SweepStatus;
  outcome?: string;
  broken: { rule: string; detail?: string }[];
  /** Whether the current code is the code the incident was recorded on (by content hash). */
  sameCode?: boolean;
  reason?: string;
}

/** Re-runs every incident against the current code of its target (or a loop workspace), a few at a time. */
export async function sweepIncidents(
  incidents: Incident[],
  opts: { against?: { run: string; ws: string }; stateDir?: string; concurrency?: number; onResult?: (r: SweepResult) => void } = {},
): Promise<{ results: SweepResult[]; code: Record<string, { source: string; hash: string }> }> {
  const targets = new Map<string, Promise<{ target: BulwarkTarget; source: string; hash: string } | Error>>();
  const load = (name: string) => {
    if (!targets.has(name)) {
      targets.set(
        name,
        (async () => {
          try {
            const dir = opts.against ? resolveReplayDir(opts.against, opts.stateDir) : resolveTargetDir(name);
            const target = await loadTarget(dir);
            if (target.name !== name) throw new Error(`${opts.against ? `workspace ${opts.against.run}/${opts.against.ws}` : 'target'} is ${target.name}, not ${name}`);
            const source = opts.against ? `.bulwark/runs/${opts.against.run}/ws/${opts.against.ws}` : `targets/${name}`;
            return { target, source, hash: hashFiles(readFiles(dir, target.editableFiles)) };
          } catch (err) {
            return err instanceof Error ? err : new Error(String(err));
          }
        })(),
      );
    }
    return targets.get(name)!;
  };

  const results: SweepResult[] = new Array(incidents.length);
  let next = 0;
  const worker = async () => {
    while (next < incidents.length) {
      const k = next++;
      const inc = incidents[k];
      let r: SweepResult;
      const t = await load(inc.target);
      if (t instanceof Error) r = { incident: inc, status: 'skipped', broken: [], reason: t.message };
      else {
        try {
          const rep = await replayTrial({ target: t.target, fault: inc.fault, seed: inc.seed, source: t.source });
          r = {
            incident: inc,
            status: rep.broken.length ? 'still-fails' : 'fixed',
            outcome: rep.observation.outcome,
            broken: rep.broken.map(({ rule, detail }) => ({ rule, ...(detail ? { detail } : {}) })),
            ...(inc.targetHashes.length ? { sameCode: inc.targetHashes.includes(t.hash) } : {}),
          };
        } catch (err) {
          r = { incident: inc, status: 'skipped', broken: [], reason: err instanceof Error ? err.message : String(err) };
        }
      }
      results[k] = r;
      opts.onResult?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 12) }, worker));

  const code: Record<string, { source: string; hash: string }> = {};
  for (const [name, p] of targets) {
    const t = await p;
    if (!(t instanceof Error)) code[name] = { source: t.source, hash: t.hash };
  }
  return { results, code };
}

/**
 * Still-failing incidents as chaos regression specs, one per target and fault, in the Guard's format
 * (bulwark/guard.ts) plus the exact trial `seeds`, so `runExperiment` replays exactly these incidents.
 */
export function incidentSpecs(results: SweepResult[]): { target: string; path: string; spec: ChaosSpec }[] {
  const groups = new Map<string, SweepResult[]>();
  for (const r of results) {
    if (r.status !== 'still-fails' || r.incident.fault === 'baseline') continue;
    const key = `${r.incident.target}|${r.incident.fault}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const [target, fault] = key.split('|');
    const seeds = rs.map((r) => r.incident.seed).sort((a, b) => a - b);
    const spec: ChaosSpec = { fault, trials: seeds.length, seed: seeds[0], seeds, strategy: 'incident-replay', createdBy: 'bulwark' };
    return { target, path: `chaos-tests/incident-${fault}.json`, spec };
  });
}

export function writeIncidentSpecs(specs: ReturnType<typeof incidentSpecs>, dir: string): string[] {
  return specs.map(({ target, path, spec }) => {
    const file = join(dir, target, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
    return file;
  });
}
