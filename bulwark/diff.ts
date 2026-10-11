// Trace diff: one seed replayed against the original code and against the
// patched code, aligned event by event, with the first point where the two
// stories part ways. Timings are ignored; events are matched by what happened
// (type, endpoint or tool, effect kind), then compared on their content.

import { getFault } from './chaos/faults';
import type { TrialEvent } from './recorder';
import { replayTrial, resolveReplayDir, type ReplayResult } from './replay';
import { loadTarget, resolveTargetDir } from './target';

export type DiffKind = 'same' | 'changed' | 'only-before' | 'only-after';

/** One field that differs between two matched events (paths like "input.idempotencyKey"). */
export interface FieldChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface DiffRow {
  kind: DiffKind;
  /** Index into the before timeline. */
  b?: number;
  /** Index into the after timeline. */
  a?: number;
  changes?: FieldChange[];
}

export interface TimelineDiff {
  rows: DiffRow[];
  /** Row index of the first row that is not `same`; -1 when the timelines match. */
  divergence: number;
  /** Row index of the first event that only one side has (or, failing that, the first changed side effect or outcome); -1 if none. */
  pivot: number;
  counts: Record<DiffKind, number>;
  /** One line for people: where it diverges and what changed. */
  explanation: string;
}

/** What an event is, for alignment: two events with the same key are "the same step". */
export function alignKey(e: TrialEvent): string {
  switch (e.type) {
    case 'brain':
      return e.decision.type === 'tool' ? `brain|tool|${e.decision.name}` : 'brain|reply';
    case 'call':
      return `call|${e.endpoint}|${e.retryOf ? 'retry' : 'first'}`;
    case 'result':
    case 'error':
      // A result on one side and an error on the other are the same step answered differently.
      return `reply|${e.endpoint}`;
    case 'timeout':
      return `timeout|${e.endpoint}`;
    case 'fault':
      return `fault|${e.fault}|${e.endpoint}`;
    case 'effect':
      return `effect|${e.effect}`;
    case 'outcome':
      return 'outcome';
  }
}

/** The event without timings or call numbers (they shift when a call is added or removed). */
export function normalizeEvent(e: TrialEvent): Record<string, unknown> {
  const { i: _i, t: _t, ...rest } = e as unknown as Record<string, unknown>;
  delete rest.ms;
  delete rest.afterMs;
  delete rest.durationMs;
  delete rest.call;
  if (e.type === 'timeout') delete rest.detail; // embeds a wall-clock duration
  if (e.type === 'call' && e.retryOf) rest.retryOf = true;
  return rest;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

function flatten(v: unknown, prefix: string, out: Map<string, unknown>) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, v);
}

/** Field-level differences between two matched events. */
export function fieldChanges(before: TrialEvent, after: TrialEvent): FieldChange[] {
  const fb = new Map<string, unknown>();
  const fa = new Map<string, unknown>();
  flatten(normalizeEvent(before), '', fb);
  flatten(normalizeEvent(after), '', fa);
  const changes: FieldChange[] = [];
  for (const [path, v] of fb) {
    if (!fa.has(path)) changes.push({ path, before: v });
    else if (stable(v) !== stable(fa.get(path))) changes.push({ path, before: v, after: fa.get(path) });
  }
  for (const [path, v] of fa) if (!fb.has(path)) changes.push({ path, after: v });
  return changes;
}

/**
 * Aligns two timelines. A weighted LCS over alignKey: an exact content match scores 3, a same-key
 * match with different content scores 2, so the alignment prefers pairing identical events and then
 * pairs the same step with changed content rather than calling it a deletion plus an insertion.
 */
export function diffTimelines(before: TrialEvent[], after: TrialEvent[]): TimelineDiff {
  const n = before.length;
  const m = after.length;
  const kb = before.map(alignKey);
  const ka = after.map(alignKey);
  const cb = before.map((e) => stable(normalizeEvent(e)));
  const ca = after.map((e) => stable(normalizeEvent(e)));
  const w = (i: number, j: number) => (kb[i] !== ka[j] ? 0 : cb[i] === ca[j] ? 3 : 2);

  // dp[i][j]: best score aligning before[i..] with after[j..].
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      const s = w(i, j);
      if (s) best = Math.max(best, s + dp[(i + 1) * W + j + 1]);
      dp[i * W + j] = best;
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = w(i, j);
      if (s && dp[i * W + j] === s + dp[(i + 1) * W + j + 1]) {
        if (s === 3) rows.push({ kind: 'same', b: i, a: j });
        else rows.push({ kind: 'changed', b: i, a: j, changes: fieldChanges(before[i], after[j]) });
        i++;
        j++;
        continue;
      }
      // Before-only first when both moves are equally good, so a removed event reads before its replacement.
      if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) rows.push({ kind: 'only-before', b: i++ });
      else rows.push({ kind: 'only-after', a: j++ });
    } else if (i < n) rows.push({ kind: 'only-before', b: i++ });
    else rows.push({ kind: 'only-after', a: j++ });
  }

  const counts: Record<DiffKind, number> = { same: 0, changed: 0, 'only-before': 0, 'only-after': 0 };
  for (const r of rows) counts[r.kind]++;
  const divergence = rows.findIndex((r) => r.kind !== 'same');
  let pivot = rows.findIndex((r) => r.kind === 'only-before' || r.kind === 'only-after');
  if (pivot === -1) pivot = rows.findIndex((r) => r.kind === 'changed' && ['effect', 'outcome'].includes(before[r.b!].type));
  const diff: TimelineDiff = { rows, divergence, pivot, counts, explanation: '' };
  diff.explanation = explainDiff(diff, before, after);
  return diff;
}

/* ---------- Words ---------- */

const clip = (v: unknown, n = 60) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];
const ordinal = (k: number) => ORDINAL[k] ?? `${k + 1}th`;

function effectPhrase(e: Extract<TrialEvent, { type: 'effect' }>): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (e.effect === 'refund') return `refund${d.amount !== undefined ? ` of $${d.amount}` : ''}${d.orderId ? ` on ${d.orderId}` : ''}${d.id ? ` (${d.id})` : ''}`;
  if (e.effect === 'email') return `email${d.to ? ` to ${d.to}` : ''}`;
  if (e.effect === 'apiCall') return `API call${d.endpoint ? ` ${d.endpoint}` : ''}${d.creditsUsed !== undefined ? ` (${d.creditsUsed} credits)` : ''}`;
  return `${e.effect} ${clip(e.data)}`;
}

/** "a second refund of $49 on ord_1001 (rf_2) went through", for an event that only one side has. */
function eventPhrase(e: TrialEvent, timeline: TrialEvent[]): string {
  const nth = (pred: (x: TrialEvent) => boolean) => timeline.slice(0, e.i).filter(pred).length;
  switch (e.type) {
    case 'brain':
      return e.decision.type === 'tool' ? `the agent decided to call ${e.decision.name} ${clip(e.decision.input)}` : `the agent replied ${clip(e.decision.reply)}`;
    case 'call': {
      const k = nth((x) => x.type === 'call' && x.endpoint === e.endpoint);
      return `a ${k ? ordinal(k) + ' ' : ''}${e.endpoint} call went out${e.retryOf ? ' (a retry)' : ''}`;
    }
    case 'result':
      return `${e.endpoint} returned ${clip(e.output)}`;
    case 'error':
      return `${e.endpoint} failed with ${clip(e.error)}`;
    case 'timeout':
      return `the agent gave up waiting on ${e.endpoint}`;
    case 'fault':
      return `${e.fault} fired on ${e.endpoint}`;
    case 'effect': {
      const k = nth((x) => x.type === 'effect' && x.effect === e.effect);
      return `a ${k ? ordinal(k) + ' ' : ''}${effectPhrase(e)} went through`;
    }
    case 'outcome':
      return `the run ended ${e.outcome}`;
  }
}

const fieldName = (path: string) => path.split('.').pop()!;

function changePhrase(row: DiffRow, before: TrialEvent[], after: TrialEvent[]): string {
  const b = before[row.b!];
  const a = after[row.a!];
  const ch = row.changes ?? [];
  const added = ch.filter((c) => !('before' in c));
  const removed = ch.filter((c) => !('after' in c));
  const altered = ch.filter((c) => 'before' in c && 'after' in c);
  const parts: string[] = [];
  if (added.length) parts.push(`now carries ${added.map((c) => `${fieldName(c.path)}=${clip(c.after, 40)}`).join(', ')}`);
  if (removed.length) parts.push(`no longer has ${removed.map((c) => fieldName(c.path)).join(', ')}`);
  if (altered.length) parts.push(altered.map((c) => `${fieldName(c.path)} ${clip(c.before, 40)} → ${clip(c.after, 40)}`).join(', '));
  const what = parts.join('; ');
  switch (b.type) {
    case 'call':
      return `${b.retryOf ? 'the retry of ' : ''}${b.endpoint} ${what}`;
    case 'result':
    case 'error':
      if (b.type !== a.type) return `before, ${eventPhrase(b, before)}; after, ${eventPhrase(a, after)}`;
      return `${b.endpoint} now returns ${what}`;
    case 'brain':
      return `the agent's ${b.decision.type === 'tool' ? `${b.decision.name} call` : 'reply'} ${what}`;
    case 'effect':
      return `the ${effectPhrase(b)} ${what}`;
    case 'outcome':
      return a.type === 'outcome' && a.outcome !== b.outcome ? `before, the run ended ${b.outcome}; after, it ended ${a.outcome}` : `the outcome ${what}`;
    default:
      return `${eventPhrase(b, before)} ${what}`;
  }
}

function rowPhrase(row: DiffRow, before: TrialEvent[], after: TrialEvent[]): string {
  if (row.kind === 'changed') return changePhrase(row, before, after);
  if (row.kind === 'only-before') return `before, ${eventPhrase(before[row.b!], before)}; after, it no longer happens`;
  if (row.kind === 'only-after') return `after, ${eventPhrase(after[row.a!], after)}; before, it did not`;
  return 'identical';
}

export function explainDiff(diff: Pick<TimelineDiff, 'rows' | 'divergence' | 'pivot'>, before: TrialEvent[], after: TrialEvent[]): string {
  const { rows, divergence, pivot } = diff;
  if (divergence === -1) return `No divergence: all ${rows.length} events are the same before and after the fix.`;
  let text = `Diverges at step ${divergence + 1}: ${rowPhrase(rows[divergence], before, after)}.`;
  if (pivot !== -1 && pivot !== divergence) {
    text += ` At step ${pivot + 1}, ${rowPhrase(rows[pivot], before, after)}`;
    // The reply that replaced a removed event, e.g. the retry now returning the original refund.
    const next = rows.slice(pivot + 1, pivot + 4).find((r) => r.kind === 'changed' && after[r.a!].type === 'result');
    const res = next ? after[next.a!] : undefined;
    if (rows[pivot].kind === 'only-before' && res?.type === 'result') {
      const retry = after.some((x) => x.type === 'call' && x.call === res.call && x.retryOf);
      text += `, and ${retry ? `the ${res.endpoint} retry` : res.endpoint} returns ${clip(res.output, 90)}`;
    }
    text += '.';
  }
  return text;
}

/* ---------- API / CLI ---------- */

export interface DiffResult {
  target: string;
  fault: string;
  seed: number;
  run: string;
  ws: string;
  before: ReplayResult;
  after: ReplayResult;
  diff: TimelineDiff;
}

const SAFE = /^[\w-]{1,128}$/;

/**
 * GET /api/diff?target=&fault=&seed=&run=&ws= and `npm run diff`. Replays the seed against the
 * original target and against a loop workspace (default: `<fault>-accepted` of that run), then diffs.
 */
export async function diffFromParams(params: URLSearchParams, stateDir = '.bulwark'): Promise<DiffResult> {
  const fault = params.get('fault') ?? '';
  const seedStr = params.get('seed') ?? '';
  const run = params.get('run') ?? '';
  const ws = params.get('ws') || `${fault}-accepted`;
  if (!SAFE.test(fault) || fault === 'baseline') throw new Error('fault must be a fault id (not baseline)');
  if (!/^\d{1,10}$/.test(seedStr) || Number(seedStr) > 0xffffffff) throw new Error('seed must be a 32-bit unsigned integer');
  if (!SAFE.test(run)) throw new Error('run is required and must be a plain name');
  if (!SAFE.test(ws)) throw new Error('ws must be a plain name');

  const beforeDir = resolveTargetDir(params.get('target'));
  const afterDir = resolveReplayDir({ run, ws }, stateDir);
  const [original, patched] = await Promise.all([loadTarget(beforeDir), loadTarget(afterDir)]);
  if (original.name !== patched.name) throw new Error(`workspace ${run}/${ws} is for ${patched.name}, not ${original.name}`);
  getFault(fault, original); // throws "unknown fault" before any trial runs
  const seed = Number(seedStr);
  const [before, after] = await Promise.all([
    replayTrial({ target: original, fault, seed, source: `targets/${beforeDir.split(/[\\/]/).pop()}` }),
    replayTrial({ target: patched, fault, seed, source: `.bulwark/runs/${run}/ws/${ws}` }),
  ]);
  return { target: original.name, fault, seed, run, ws, before, after, diff: diffTimelines(before.timeline, after.timeline) };
}

/** Compact, timing-free one-liner for a diff column. */
export function brief(e: TrialEvent): string {
  switch (e.type) {
    case 'brain':
      return e.decision.type === 'tool' ? `brain   ${e.decision.name} ${clip(e.decision.input, 200)}` : `brain   reply ${clip(e.decision.reply, 200)}`;
    case 'call':
      return `→ ${e.endpoint} ${clip(e.input, 200)}${e.retryOf ? ' RETRY' : ''}`;
    case 'result':
      return `← ${e.endpoint} ${clip(e.output, 200)}${e.late ? ' (late)' : ''}`;
    case 'error':
      return `✗ ${e.endpoint} ${e.error}${e.late ? ' (late)' : ''}`;
    case 'timeout':
      return `timeout ${e.endpoint}`;
    case 'fault':
      return `FAULT ${e.fault} on ${e.endpoint}`;
    case 'effect':
      return `effect  ${effectPhrase(e)}`;
    case 'outcome':
      return `outcome ${e.outcome.toUpperCase()} after ${e.steps} steps`;
  }
}

const MARK: Record<DiffKind, string> = { same: ' ', changed: '~', 'only-before': '-', 'only-after': '+' };

/** Two columns for the terminal: step, marker, before | after. */
export function renderDiffText(r: Pick<DiffResult, 'before' | 'after' | 'diff'>, width = 160): string {
  const col = Math.max(30, Math.floor((width - 12) / 2));
  const fit = (s: string) => (s.length > col ? s.slice(0, col - 1) + '…' : s.padEnd(col));
  const lines = [`      ${fit('BEFORE  ' + r.before.source)} │ ${'AFTER  ' + r.after.source}`, `      ${'─'.repeat(col)}─┼─${'─'.repeat(col)}`];
  r.diff.rows.forEach((row, k) => {
    const left = row.b !== undefined ? brief(r.before.timeline[row.b]) : '';
    const right = row.a !== undefined ? brief(r.after.timeline[row.a]) : '';
    const here = k === r.diff.divergence ? '▶' : k === r.diff.pivot ? '•' : ' ';
    lines.push(`${here}${String(k + 1).padStart(3)} ${MARK[row.kind]} ${fit(left)} │ ${right.length > col ? right.slice(0, col - 1) + '…' : right}`);
    if (row.kind === 'changed' && row.changes?.length) {
      for (const c of row.changes) lines.push(`         ${''.padEnd(col)}   ↳ ${c.path}: ${'before' in c ? clip(c.before, 40) : '(absent)'} → ${'after' in c ? clip(c.after, 60) : '(absent)'}`);
    }
  });
  return lines.join('\n');
}
