// A small declarative language for business-rule checks, so an LLM can compile a
// plain-English rule without writing code. A check is data: it is validated
// strictly (schema, bounds, known fields of the trial observation) and only then
// evaluated by the fixed interpreter below. Never code, never eval.
//
// A check is a predicate over the trial's *scope*, a read-only view of one
// TrialObservation:
//   outcome, error, durationMs, steps, faultsFired, reply, replyJson (the JSON
//   object in the reply, or null), ticket, fixtures, effects, plus every ledger
//   list by name (e.g. refunds, emails for RefundBot; apiCalls for ResearchBot).
//
// Values (Expr):
//   "text" | 3 | true | null                         literals
//   ["completed", "hung"]                            a list of literals (e.g. for "in")
//   { "path": "ticket.orderId" }                      a field of the scope or of a bound item ("e.body")
//   { "agg": "count"|"sum"|"max"|"min", "list": Expr, "as"?: "r", "where"?: Pred, "field"?: "amount", "groupBy"?: "orderId" }
//   { "find": Expr, "as": "o", "where": Pred, "field"?: "total" }   first matching item (or its field), else null
//   { "len": Expr }                                   length of a string or list
//   { "lower": Expr }                                 lower-cased string
// Predicates (Pred):
//   { "cmp": "=="|"!="|"<"|"<="|">"|">="|"contains"|"notContains"|"in"|"startsWith", "left": Expr, "right": Expr }
//   { "every": Expr, "as": "e", "where": Pred }       vacuously true on an empty or missing list
//   { "some": Expr, "as": "e", "where": Pred }
//   { "and": [Pred, ...] } | { "or": [Pred, ...] } | { "not": Pred } | { "if": Pred, "then": Pred }
//   { "exists": Expr }                                not null / missing
//
// An aggregate with `groupBy` may only be the left side of a comparison; the
// comparison must then hold for every group (e.g. refunds per orderId <= 1).

import type { TrialObservation } from '../harness';
import type { CheckResult } from '../invariants';

export type Literal = string | number | boolean | null;
export type AggOp = 'count' | 'sum' | 'max' | 'min';
export type CmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'notContains' | 'in' | 'startsWith';

export type Expr =
  | Literal
  | Literal[]
  | { path: string }
  | { agg: AggOp; list: Expr; as?: string; where?: Pred; field?: string; groupBy?: string }
  | { find: Expr; as: string; where: Pred; field?: string }
  | { len: Expr }
  | { lower: Expr };

export type Pred =
  | { cmp: CmpOp; left: Expr; right: Expr }
  | { every: Expr; as: string; where: Pred }
  | { some: Expr; as: string; where: Pred }
  | { and: Pred[] }
  | { or: Pred[] }
  | { not: Pred }
  | { if: Pred; then: Pred }
  | { exists: Expr };

export const LIMITS = { maxDepth: 12, maxNodes: 150, maxString: 300, maxList: 20, maxPathDepth: 6 };

export const AGG_OPS: AggOp[] = ['count', 'sum', 'max', 'min'];
export const CMP_OPS: CmpOp[] = ['==', '!=', '<', '<=', '>', '>=', 'contains', 'notContains', 'in', 'startsWith'];
/** Scope roots every observation has; ledger list names are added per target. */
export const FIXED_ROOTS = ['outcome', 'error', 'durationMs', 'steps', 'faultsFired', 'reply', 'replyJson', 'ticket', 'fixtures', 'effects'];

const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d{1,3})$/;
const VAR = /^[a-z][A-Za-z0-9_]{0,15}$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

// ---------------------------------------------------------------------------
// Scope

export type Scope = Record<string, unknown>;

/** The JSON object in a reply (models sometimes wrap it in prose or fences), or null. */
export function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The read-only view a check sees. Ledger lists are also exposed by name (refunds, emails, apiCalls, ...). */
export function scopeOf(obs: TrialObservation): Scope {
  const effects = obs.effects ?? {};
  const scope: Scope = {
    outcome: obs.outcome,
    error: obs.error ?? null,
    durationMs: obs.durationMs,
    steps: obs.steps,
    faultsFired: obs.faultsFired,
    reply: obs.reply ?? null,
    replyJson: parseJsonObject(obs.reply),
    ticket: obs.ticket ?? {},
    fixtures: obs.fixtures ?? {},
    effects,
  };
  for (const [name, list] of Object.entries(effects)) if (!FIXED_ROOTS.includes(name)) scope[name] = list;
  return scope;
}

// ---------------------------------------------------------------------------
// Shape: what fields the observations actually hold, inferred from real trials.

export type Shape = { kind: 'any' } | { kind: 'prim' } | { kind: 'obj'; keys: Record<string, Shape> } | { kind: 'list'; of: Shape };

const ANY: Shape = { kind: 'any' };

function shapeOfValue(v: unknown, depth = 0): Shape {
  if (depth > 8) return ANY;
  if (Array.isArray(v)) return { kind: 'list', of: v.reduce<Shape>((s, x) => mergeShape(s, shapeOfValue(x, depth + 1)), { kind: 'any' }) };
  if (v && typeof v === 'object') return { kind: 'obj', keys: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOfValue(x, depth + 1)])) };
  return v === null || v === undefined ? ANY : { kind: 'prim' };
}

function mergeShape(a: Shape, b: Shape): Shape {
  if (a.kind === 'any') return b;
  if (b.kind === 'any') return a;
  if (a.kind === 'obj' && b.kind === 'obj') {
    const keys: Record<string, Shape> = { ...a.keys };
    for (const [k, s] of Object.entries(b.keys)) keys[k] = k in keys ? mergeShape(keys[k], s) : s;
    return { kind: 'obj', keys };
  }
  if (a.kind === 'list' && b.kind === 'list') return { kind: 'list', of: mergeShape(a.of, b.of) };
  if (a.kind === b.kind) return a;
  return ANY; // mixed types: don't guess
}

/** The union shape of several scopes (real trial observations of the target). */
export function inferShape(scopes: Scope[]): Shape {
  const base = scopes.reduce<Shape>((s, x) => mergeShape(s, shapeOfValue(x)), { kind: 'any' });
  // Fields that can be null on some trials (reply, replyJson, error) are still known roots.
  if (base.kind !== 'obj') return { kind: 'obj', keys: Object.fromEntries(FIXED_ROOTS.map((r) => [r, ANY])) };
  for (const r of FIXED_ROOTS) base.keys[r] ??= ANY;
  return base;
}

/** A compact, human/LLM-readable outline of a shape, e.g. "refunds: list of { id, orderId, amount }". */
export function describeShape(shape: Shape, indent = ''): string {
  if (shape.kind !== 'obj') return `${indent}(unknown)`;
  const line = (s: Shape): string =>
    s.kind === 'obj'
      ? `{ ${Object.entries(s.keys).map(([k, v]) => (v.kind === 'obj' || v.kind === 'list' ? `${k}: ${line(v)}` : k)).join(', ')} }`
      : s.kind === 'list'
        ? `list of ${s.of.kind === 'any' ? 'items (none seen)' : s.of.kind === 'prim' ? 'values' : line(s.of)}`
        : s.kind === 'prim'
          ? 'value'
          : 'value (may be null)';
  return Object.entries(shape.keys)
    .map(([k, v]) => `${indent}${k}: ${line(v)}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Validation

export interface ValidationContext {
  /** Shape of the scope, from real trial observations. Unknown fields are rejected. `{ kind: 'any' }` checks structure only. */
  shape: Shape;
}

type Vars = Map<string, Shape>;

const KEYS = {
  path: ['path'],
  agg: ['agg', 'list', 'as', 'where', 'field', 'groupBy'],
  find: ['find', 'as', 'where', 'field'],
  len: ['len'],
  lower: ['lower'],
  cmp: ['cmp', 'left', 'right'],
  every: ['every', 'as', 'where'],
  some: ['some', 'as', 'where'],
  and: ['and'],
  or: ['or'],
  not: ['not'],
  if: ['if', 'then'],
  exists: ['exists'],
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function walkPath(shape: Shape, segs: string[], where: string): Shape {
  let s = shape;
  for (const seg of segs) {
    if (s.kind === 'any' || s.kind === 'prim') return ANY; // can't see further (null in every sample): allow
    if (s.kind === 'list') {
      if (/^\d+$/.test(seg)) {
        s = s.of;
        continue;
      }
      throw new Error(`${where}: "${seg}" is a field of a list; use every/some/agg/find to look inside it`);
    }
    if (!(seg in s.keys)) throw new Error(`${where}: unknown field "${seg}" (known: ${Object.keys(s.keys).join(', ') || 'none'})`);
    s = s.keys[seg];
  }
  return s;
}

function checkSegments(path: unknown, where: string): string[] {
  if (typeof path !== 'string' || !path) throw new Error(`${where}: path must be a non-empty string`);
  const segs = path.split('.');
  if (segs.length > LIMITS.maxPathDepth) throw new Error(`${where}: path "${path}" is deeper than ${LIMITS.maxPathDepth}`);
  for (const s of segs) {
    if (!SEGMENT.test(s) || FORBIDDEN.has(s)) throw new Error(`${where}: bad path segment "${s}" in "${path}"`);
  }
  return segs;
}

/**
 * Validates a check strictly: only known node types and keys, sane bounds, bound
 * variables in scope, and every path naming a field the observations actually have.
 * Throws with a precise reason; returns the node count.
 */
export function validateCheck(check: unknown, ctx: ValidationContext): number {
  let nodes = 0;
  const bump = (depth: number, where: string) => {
    if (++nodes > LIMITS.maxNodes) throw new Error(`check has more than ${LIMITS.maxNodes} nodes`);
    if (depth > LIMITS.maxDepth) throw new Error(`${where}: nested deeper than ${LIMITS.maxDepth}`);
  };
  const exact = (o: Record<string, unknown>, kind: keyof typeof KEYS, where: string) => {
    const allowed: readonly string[] = KEYS[kind];
    for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${where}: unexpected key "${k}" in a ${kind} node`);
  };
  const bindVar = (name: unknown, vars: Vars, where: string): string => {
    if (typeof name !== 'string' || !VAR.test(name)) throw new Error(`${where}: "as" must be a short lowercase name like "r"`);
    if (ctx.shape.kind === 'obj' && name in ctx.shape.keys) throw new Error(`${where}: "as" name "${name}" shadows a scope field`);
    if (vars.has(name)) throw new Error(`${where}: "as" name "${name}" is already bound`);
    return name;
  };
  const relField = (field: unknown, item: Shape, where: string): Shape => walkPath(item, checkSegments(field, where), where);

  /** Returns the value's shape (lists as list shapes) for field checks further down. */
  const expr = (e: unknown, vars: Vars, depth: number, where: string, grouped = false): Shape => {
    bump(depth, where);
    if (e === null || typeof e === 'boolean') return { kind: 'prim' };
    if (typeof e === 'number') {
      if (!Number.isFinite(e)) throw new Error(`${where}: numbers must be finite`);
      return { kind: 'prim' };
    }
    if (typeof e === 'string') {
      if (e.length > LIMITS.maxString) throw new Error(`${where}: string literal longer than ${LIMITS.maxString}`);
      return { kind: 'prim' };
    }
    if (Array.isArray(e)) {
      if (e.length > LIMITS.maxList) throw new Error(`${where}: list literal longer than ${LIMITS.maxList}`);
      e.forEach((x, i) => {
        if (x !== null && !['string', 'number', 'boolean'].includes(typeof x)) throw new Error(`${where}[${i}]: list literals may only hold strings, numbers, booleans or null`);
        expr(x, vars, depth + 1, `${where}[${i}]`);
      });
      return { kind: 'list', of: { kind: 'prim' } };
    }
    if (!isObj(e)) throw new Error(`${where}: expected a literal or an expression object, got ${typeof e}`);
    if ('path' in e) {
      exact(e, 'path', where);
      const segs = checkSegments(e.path, where);
      const [root, ...rest] = segs;
      const base = vars.get(root) ?? (ctx.shape.kind === 'obj' ? ctx.shape.keys[root] : ctx.shape.kind === 'any' ? ANY : undefined);
      if (!base) {
        const known = [...vars.keys(), ...(ctx.shape.kind === 'obj' ? Object.keys(ctx.shape.keys) : [])];
        throw new Error(`${where}: unknown name "${root}" (known: ${known.join(', ')})`);
      }
      return walkPath(base, rest, `${where} (${e.path})`);
    }
    if ('agg' in e) {
      exact(e, 'agg', where);
      if (!AGG_OPS.includes(e.agg as AggOp)) throw new Error(`${where}: agg must be one of ${AGG_OPS.join(', ')}`);
      if ('groupBy' in e && !grouped) throw new Error(`${where}: an aggregate with groupBy may only be the left side of a cmp`);
      const list = expr(e.list, vars, depth + 1, `${where}.list`);
      if (list.kind === 'prim' || list.kind === 'obj') throw new Error(`${where}.list: not a list`);
      const item = list.kind === 'list' ? list.of : ANY;
      const inner = new Map(vars);
      if ('as' in e) inner.set(bindVar(e.as, vars, where), item);
      if ('where' in e) {
        if (!('as' in e)) throw new Error(`${where}: "where" needs "as" to name the item`);
        pred(e.where, inner, depth + 1, `${where}.where`);
      }
      if (e.agg !== 'count' && !('field' in e)) {
        // sum/max/min over the items themselves (a list of numbers) is fine
      }
      if ('field' in e) relField(e.field, item, `${where}.field`);
      if ('groupBy' in e) relField(e.groupBy, item, `${where}.groupBy`);
      return { kind: 'prim' };
    }
    if ('find' in e) {
      exact(e, 'find', where);
      const list = expr(e.find, vars, depth + 1, `${where}.find`);
      if (list.kind === 'prim' || list.kind === 'obj') throw new Error(`${where}.find: not a list`);
      const item = list.kind === 'list' ? list.of : ANY;
      const inner = new Map(vars);
      inner.set(bindVar(e.as, vars, where), item);
      if (!('where' in e)) throw new Error(`${where}: find needs "where"`);
      pred(e.where, inner, depth + 1, `${where}.where`);
      return 'field' in e ? relField(e.field, item, `${where}.field`) : item;
    }
    if ('len' in e) {
      exact(e, 'len', where);
      expr(e.len, vars, depth + 1, `${where}.len`);
      return { kind: 'prim' };
    }
    if ('lower' in e) {
      exact(e, 'lower', where);
      expr(e.lower, vars, depth + 1, `${where}.lower`);
      return { kind: 'prim' };
    }
    throw new Error(`${where}: unknown expression ${JSON.stringify(Object.keys(e))}`);
  };

  const pred = (p: unknown, vars: Vars, depth: number, where: string): void => {
    bump(depth, where);
    if (!isObj(p)) throw new Error(`${where}: a predicate must be an object`);
    if ('cmp' in p) {
      exact(p, 'cmp', where);
      if (!CMP_OPS.includes(p.cmp as CmpOp)) throw new Error(`${where}: cmp must be one of ${CMP_OPS.join(' ')}`);
      if (!('left' in p) || !('right' in p)) throw new Error(`${where}: cmp needs left and right`);
      expr(p.left, vars, depth + 1, `${where}.left`, true);
      expr(p.right, vars, depth + 1, `${where}.right`);
      return;
    }
    for (const q of ['every', 'some'] as const) {
      if (q in p) {
        exact(p, q, where);
        const list = expr(p[q], vars, depth + 1, `${where}.${q}`);
        if (list.kind === 'prim' || list.kind === 'obj') throw new Error(`${where}.${q}: not a list`);
        const inner = new Map(vars);
        inner.set(bindVar(p.as, vars, where), list.kind === 'list' ? list.of : ANY);
        if (!('where' in p)) throw new Error(`${where}: ${q} needs "where"`);
        pred(p.where, inner, depth + 1, `${where}.where`);
        return;
      }
    }
    for (const j of ['and', 'or'] as const) {
      if (j in p) {
        exact(p, j, where);
        const xs = p[j];
        if (!Array.isArray(xs) || xs.length === 0 || xs.length > LIMITS.maxList) throw new Error(`${where}: ${j} needs 1-${LIMITS.maxList} predicates`);
        xs.forEach((x, i) => pred(x, vars, depth + 1, `${where}.${j}[${i}]`));
        return;
      }
    }
    if ('not' in p) {
      exact(p, 'not', where);
      return pred(p.not, vars, depth + 1, `${where}.not`);
    }
    if ('if' in p) {
      exact(p, 'if', where);
      if (!('then' in p)) throw new Error(`${where}: if needs then`);
      pred(p.if, vars, depth + 1, `${where}.if`);
      return pred(p.then, vars, depth + 1, `${where}.then`);
    }
    if ('exists' in p) {
      exact(p, 'exists', where);
      expr(p.exists, vars, depth + 1, `${where}.exists`);
      return;
    }
    throw new Error(`${where}: unknown predicate ${JSON.stringify(Object.keys(p))}`);
  };

  pred(check, new Map(), 0, 'check');
  return nodes;
}

// ---------------------------------------------------------------------------
// Evaluation

/** A data problem the check can't decide on (e.g. comparing null with <). Reported, never thrown past evaluate(). */
export class CheckError extends Error {}

interface Grouped {
  grouped: true;
  groups: [unknown, unknown][];
  label: string;
}

const isGrouped = (v: unknown): v is Grouped => isObj(v) && (v as { grouped?: unknown }).grouped === true;

const clip = (v: unknown, n = 80) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function get(base: unknown, segs: string[]): unknown {
  let v = base;
  for (const s of segs) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v) && /^\d+$/.test(s)) v = v[Number(s)];
    else if (isObj(v) && Object.hasOwn(v, s)) v = v[s];
    else return null;
  }
  return v === undefined ? null : v;
}

const asList = (v: unknown, what: string): unknown[] => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new CheckError(`${what} is not a list (got ${clip(v)})`);
  return v;
};

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CheckError(`${what} is not a number (got ${clip(v)})`);
  return v;
};

function evalExpr(e: Expr, scope: Scope, vars: Map<string, unknown>): unknown {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return e;
  if ('path' in e) {
    const [root, ...rest] = e.path.split('.');
    return get(vars.has(root) ? vars.get(root) : scope[root], rest);
  }
  if ('agg' in e) {
    let items = asList(evalExpr(e.list, scope, vars), describeExpr(e.list));
    if (e.where) items = items.filter((x) => evalPred(e.where!, scope, new Map(vars).set(e.as!, x)).ok);
    const valueOf = (x: unknown) => (e.field ? get(x, e.field.split('.')) : x);
    const reduce = (xs: unknown[]): number | null => {
      if (e.agg === 'count') return xs.length;
      const ns = xs.map((x) => num(valueOf(x), `${e.field ?? 'item'} of ${describeExpr(e.list)}`));
      if (e.agg === 'sum') return Math.round(ns.reduce((s, n) => s + n, 0) * 1e6) / 1e6;
      if (ns.length === 0) return null;
      return e.agg === 'max' ? Math.max(...ns) : Math.min(...ns);
    };
    if (!e.groupBy) return reduce(items);
    const groups = new Map<string, { key: unknown; xs: unknown[] }>();
    for (const x of items) {
      const key = get(x, e.groupBy.split('.'));
      const k = JSON.stringify(key);
      if (!groups.has(k)) groups.set(k, { key, xs: [] });
      groups.get(k)!.xs.push(x);
    }
    return { grouped: true, groups: [...groups.values()].map((g) => [g.key, reduce(g.xs)]), label: e.groupBy } satisfies Grouped;
  }
  if ('find' in e) {
    const items = asList(evalExpr(e.find, scope, vars), describeExpr(e.find));
    const hit = items.find((x) => evalPred(e.where, scope, new Map(vars).set(e.as, x)).ok);
    if (hit === undefined) return null;
    return e.field ? get(hit, e.field.split('.')) : hit;
  }
  if ('len' in e) {
    const v = evalExpr(e.len, scope, vars);
    if (v === null) return 0;
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    throw new CheckError(`len of ${describeExpr(e.len)}: not a string or list (got ${clip(v)})`);
  }
  if ('lower' in e) {
    const v = evalExpr(e.lower, scope, vars);
    return typeof v === 'string' ? v.toLowerCase() : v;
  }
  throw new CheckError(`unknown expression ${clip(e)}`);
}

const same = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

function compare(op: CmpOp, a: unknown, b: unknown, what: string): boolean {
  switch (op) {
    case '==':
      return same(a, b);
    case '!=':
      return !same(a, b);
    case '<':
      return num(a, `${what} (left)`) < num(b, `${what} (right)`);
    case '<=':
      return num(a, `${what} (left)`) <= num(b, `${what} (right)`);
    case '>':
      return num(a, `${what} (left)`) > num(b, `${what} (right)`);
    case '>=':
      return num(a, `${what} (left)`) >= num(b, `${what} (right)`);
    case 'contains':
    case 'notContains': {
      let has: boolean;
      if (typeof a === 'string' && (typeof b === 'string' || typeof b === 'number')) has = a.includes(String(b));
      else if (Array.isArray(a)) has = a.some((x) => same(x, b));
      else if (a === null) has = false;
      else throw new CheckError(`${what}: contains needs a string or list on the left (got ${clip(a)})`);
      return op === 'contains' ? has : !has;
    }
    case 'in':
      if (Array.isArray(b)) return b.some((x) => same(x, a));
      if (typeof b === 'string' && (typeof a === 'string' || typeof a === 'number')) return b.includes(String(a));
      if (b === null) return false;
      throw new CheckError(`${what}: in needs a string or list on the right (got ${clip(b)})`);
    case 'startsWith':
      if (typeof a !== 'string' || typeof b !== 'string') throw new CheckError(`${what}: startsWith needs two strings`);
      return a.startsWith(b);
  }
}

function evalPred(p: Pred, scope: Scope, vars: Map<string, unknown>): CheckResult {
  if ('cmp' in p) {
    const left = evalExpr(p.left, scope, vars);
    const right = evalExpr(p.right, scope, vars);
    const what = `${describeExpr(p.left)} ${p.cmp} ${describeExpr(p.right)}`;
    if (isGrouped(left)) {
      for (const [key, value] of left.groups) {
        if (!compare(p.cmp, value, right, what)) return { ok: false, detail: `${left.label} ${clip(key)}: ${what} fails (${clip(value)} vs ${clip(right)})` };
      }
      return { ok: true };
    }
    return compare(p.cmp, left, right, what) ? { ok: true } : { ok: false, detail: `${what} fails (${clip(left)} vs ${clip(right)})` };
  }
  if ('every' in p) {
    const items = asList(evalExpr(p.every, scope, vars), describeExpr(p.every));
    for (let i = 0; i < items.length; i++) {
      const r = evalPred(p.where, scope, new Map(vars).set(p.as, items[i]));
      if (!r.ok) return { ok: false, detail: `${describeExpr(p.every)}[${i}] ${clip(items[i], 60)}: ${r.detail}` };
    }
    return { ok: true };
  }
  if ('some' in p) {
    const items = asList(evalExpr(p.some, scope, vars), describeExpr(p.some));
    if (items.some((x) => evalPred(p.where, scope, new Map(vars).set(p.as, x)).ok)) return { ok: true };
    return { ok: false, detail: `no item of ${describeExpr(p.some)} (${items.length} items) satisfies: ${explainPred(p.where)}` };
  }
  if ('and' in p) {
    for (const q of p.and) {
      const r = evalPred(q, scope, vars);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if ('or' in p) {
    const misses: string[] = [];
    for (const q of p.or) {
      const r = evalPred(q, scope, vars);
      if (r.ok) return r;
      misses.push(r.detail ?? '');
    }
    return { ok: false, detail: `none held: ${misses.join('; ')}` };
  }
  if ('not' in p) return evalPred(p.not, scope, vars).ok ? { ok: false, detail: `${explainPred(p.not)} (it must not)` } : { ok: true };
  if ('if' in p) return evalPred(p.if, scope, vars).ok ? evalPred(p.then, scope, vars) : { ok: true };
  if ('exists' in p) {
    const v = evalExpr(p.exists, scope, vars);
    return v === null || v === undefined ? { ok: false, detail: `${describeExpr(p.exists)} is missing` } : { ok: true };
  }
  throw new CheckError(`unknown predicate ${clip(p)}`);
}

/** Evaluates a (validated) check over one scope. Data problems become a failed check with a "check error" detail. */
export function evaluate(check: Pred, scope: Scope): CheckResult & { error?: string } {
  try {
    return evalPred(check, scope, new Map());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, detail: `check error: ${msg}` };
  }
}

/** A compiled check as the scorecard uses it. */
export function toCheck(check: Pred): (obs: TrialObservation) => CheckResult {
  return (obs) => {
    const { ok, detail } = evaluate(check, scopeOf(obs));
    return ok ? { ok } : { ok, detail };
  };
}

// ---------------------------------------------------------------------------
// Explaining a check back in plain English (the `how` given to the fixer and shown in the CLI).

const OP_WORDS: Record<CmpOp, string> = {
  '==': 'equals',
  '!=': 'differs from',
  '<': 'is less than',
  '<=': 'is at most',
  '>': 'is more than',
  '>=': 'is at least',
  contains: 'contains',
  notContains: 'does not contain',
  in: 'is in',
  startsWith: 'starts with',
};

export function describeExpr(e: Expr): string {
  if (e === null) return 'null';
  if (typeof e !== 'object' || Array.isArray(e)) return JSON.stringify(e);
  if ('path' in e) return e.path;
  if ('agg' in e) {
    const of = describeExpr(e.list);
    const filt = e.where ? ` where ${explainPred(e.where)}` : '';
    const per = e.groupBy ? ` per ${e.groupBy}` : '';
    if (e.agg === 'count') return `the number of ${of}${filt}${per}`;
    return `the ${e.agg === 'sum' ? 'total' : e.agg} ${e.field ?? 'value'} of ${of}${filt}${per}`;
  }
  if ('find' in e) return `${e.field ? `the ${e.field} of ` : ''}the ${e.as} in ${describeExpr(e.find)} where ${explainPred(e.where)}`;
  if ('len' in e) return `the length of ${describeExpr(e.len)}`;
  if ('lower' in e) return `${describeExpr(e.lower)} (lower-cased)`;
  return '?';
}

export function explainPred(p: Pred): string {
  if ('cmp' in p) return `${describeExpr(p.left)} ${OP_WORDS[p.cmp]} ${describeExpr(p.right)}`;
  if ('every' in p) return `for every ${p.as} in ${describeExpr(p.every)}, ${explainPred(p.where)}`;
  if ('some' in p) return `at least one ${p.as} in ${describeExpr(p.some)} has ${explainPred(p.where)}`;
  if ('and' in p) return p.and.length === 1 ? explainPred(p.and[0]) : `(${p.and.map(explainPred).join(') and (')})`;
  if ('or' in p) return `either (${p.or.map(explainPred).join(') or (')})`;
  if ('not' in p) return `it is not the case that ${explainPred(p.not)}`;
  if ('if' in p) return `if ${explainPred(p.if)}, then ${explainPred(p.then)}`;
  if ('exists' in p) return `${describeExpr(p.exists)} is present`;
  return '?';
}

/** The `how` for a compiled check: what it reads and exactly what must hold. */
export function explainCheck(check: Pred): string {
  return `Checked on the trial observation (sandbox ledger lists, ticket, fixtures, outcome, reply): ${explainPred(check)}. A violation is any trial where this does not hold.`;
}

// ---------------------------------------------------------------------------
// Counterexamples: the compiler's self-test overlays a partial observation on a real one.

/** Deep-merges `patch` over `base` (objects merge, lists and values replace). Returns a new scope. */
export function overlay(base: Scope, patch: unknown): Scope {
  const merge = (a: unknown, b: unknown, depth: number): unknown => {
    if (depth > 8 || !isObj(b)) return b;
    const out: Record<string, unknown> = isObj(a) ? { ...a } : {};
    for (const [k, v] of Object.entries(b)) {
      if (FORBIDDEN.has(k)) continue;
      out[k] = merge(out[k], v, depth + 1);
    }
    return out;
  };
  const merged = merge(base, patch, 0) as Scope;
  // A counterexample may rewrite the reply as text; keep replyJson in step unless it set replyJson itself.
  if (isObj(patch) && 'reply' in patch && !('replyJson' in patch)) merged.replyJson = parseJsonObject(merged.reply);
  return merged;
}
