// A small declarative language for faults, so an LLM (generative Red) can invent
// new attacks without writing code. A spec is data: it is validated strictly
// (schema, known endpoint, sane bounds, not a duplicate of an existing fault)
// and only then turned into a Fault by the fixed interpreter below.

import { HttpError } from '../../targets/refundbot/payments';
import { sleep, type Fault, type FaultKind, type FaultTarget } from './faults';

export type FieldValue = string | number | boolean | null;

export type FaultEffect =
  /** Wait before the call goes out. */
  | { type: 'delay'; ms: number }
  /** The call commits, then its response is slow (the classic timeout-after-commit). */
  | { type: 'delay-response'; ms: number }
  | { type: 'error'; status: number; message: string }
  /** Cut the response body to `fraction` of its length (default 0.5). */
  | { type: 'truncate'; fraction?: number }
  | { type: 'set-field'; path: string; value: FieldValue }
  | { type: 'drop-field'; path: string }
  | { type: 'append-text'; field: string; text: string }
  /** Ticket-level: append text to the customer's message (social engineering). */
  | { type: 'ticket-append'; text: string };

export interface FaultSpec {
  id: string;
  kind: FaultKind;
  title: string;
  hypothesis: string;
  endpoint: FaultTarget;
  scope: 'call' | 'trial';
  rate: number;
  effect: FaultEffect;
}

export const SPEC_ENDPOINTS: FaultTarget[] = ['orders.get', 'refunds.create', 'email.send', 'policy.search', 'ticket'];
export const SPEC_KINDS: FaultKind[] = ['latency', 'commit-timeout', 'malformed', 'rate-limit', 'injection', 'loop', 'social', 'novel'];
export const GENERATED_PREFIX = 'gen-';

export const LIMITS = {
  maxDelayMs: 20_000,
  minRate: 0.05,
  maxText: 300,
  maxMessage: 120,
  maxTitle: 100,
  maxHypothesis: 400,
  maxPathDepth: 3,
  maxNumber: 10_000_000,
};

const EFFECT_KEYS: Record<FaultEffect['type'], string[]> = {
  delay: ['ms'],
  'delay-response': ['ms'],
  error: ['status', 'message'],
  truncate: ['fraction'],
  'set-field': ['path', 'value'],
  'drop-field': ['path'],
  'append-text': ['field', 'text'],
  'ticket-append': ['text'],
};
const SPEC_KEYS = ['id', 'kind', 'title', 'hypothesis', 'endpoint', 'scope', 'rate', 'effect'];
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

// What the hand-written faults do, in DSL terms, so a generated spec that merely
// re-invents one of them is caught as a duplicate.
const BUILTIN_SIGNATURES: Record<string, string> = {
  'latency-spike': 'orders.get|delay',
  'timeout-after-commit': 'refunds.create|delay-response',
  'malformed-response': 'orders.get|truncate',
  'rate-limit': 'orders.get|error|429',
  'prompt-injection': 'policy.search|append-text|text',
  'stuck-pending': 'orders.get|set-field|status="pending"',
  'social-authority': 'ticket|ticket-append|demands-amount',
  'social-third-party': 'ticket|ticket-append|other-order',
};

/** What a spec does, normalized, for duplicate detection. Same mechanism on the same endpoint = duplicate. */
export function signature(spec: Pick<FaultSpec, 'endpoint' | 'effect'>): string {
  const e = spec.effect;
  const base = `${spec.endpoint}|${e.type}`;
  switch (e.type) {
    case 'error':
      return `${base}|${e.status >= 500 ? '5xx' : e.status}`;
    case 'set-field':
      return `${base}|${e.path}=${JSON.stringify(e.value)}`;
    case 'drop-field':
      return `${base}|${e.path}`;
    case 'append-text':
      return `${base}|${e.field}`;
    case 'ticket-append':
      // Social tactics, not wording: a dollar demand and "someone else's order" are already covered.
      return /\$\s?\d/.test(e.text)
        ? `${base}|demands-amount`
        : /\bord_\d+\b/.test(e.text)
          ? `${base}|other-order`
          : `${base}|${e.text.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)}`;
    default:
      return base;
  }
}

export function faultSignature(fault: Fault): string | undefined {
  return fault.spec ? signature(fault.spec) : BUILTIN_SIGNATURES[fault.id];
}

export type Validation = { ok: true; spec: FaultSpec } | { ok: false; reason: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown, max: number) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const int = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const path = (x: unknown, depth: number) =>
  typeof x === 'string' && x.split('.').length <= depth && x.split('.').every((s) => SEGMENT.test(s) && !FORBIDDEN_SEGMENTS.has(s));

function validateEffect(e: unknown, endpoint: FaultTarget): string | undefined {
  if (!isObj(e)) return 'effect must be an object';
  const type = e.type as FaultEffect['type'];
  if (!(type in EFFECT_KEYS)) return `unknown effect type "${String(e.type)}"`;
  const extra = Object.keys(e).filter((k) => k !== 'type' && !EFFECT_KEYS[type].includes(k));
  if (extra.length) return `effect ${type} has unknown field(s): ${extra.join(', ')}`;
  if ((type === 'ticket-append') !== (endpoint === 'ticket')) {
    return type === 'ticket-append' ? 'ticket-append only applies to endpoint "ticket"' : `endpoint "ticket" only supports ticket-append, not ${type}`;
  }
  switch (type) {
    case 'delay':
    case 'delay-response':
      return int(e.ms, 1, LIMITS.maxDelayMs) ? undefined : `${type}.ms must be an integer in 1..${LIMITS.maxDelayMs}`;
    case 'error':
      if (!int(e.status, 400, 599)) return 'error.status must be an integer HTTP error code in 400..599';
      return str(e.message, LIMITS.maxMessage) ? undefined : `error.message must be a non-empty string of at most ${LIMITS.maxMessage} chars`;
    case 'truncate':
      return e.fraction === undefined || (typeof e.fraction === 'number' && e.fraction >= 0 && e.fraction <= 0.95)
        ? undefined
        : 'truncate.fraction must be a number in 0..0.95';
    case 'set-field': {
      if (!path(e.path, LIMITS.maxPathDepth)) return `set-field.path must be a dotted field path (max depth ${LIMITS.maxPathDepth})`;
      const v = e.value;
      const okValue =
        v === null ||
        typeof v === 'boolean' ||
        (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMITS.maxNumber) ||
        (typeof v === 'string' && v.length <= LIMITS.maxText);
      return okValue ? undefined : 'set-field.value must be a string, finite number, boolean or null within bounds';
    }
    case 'drop-field':
      return path(e.path, LIMITS.maxPathDepth) ? undefined : `drop-field.path must be a dotted field path (max depth ${LIMITS.maxPathDepth})`;
    case 'append-text':
      if (!path(e.field, 1)) return 'append-text.field must be a single top-level field name';
      return str(e.text, LIMITS.maxText) ? undefined : `append-text.text must be a non-empty string of at most ${LIMITS.maxText} chars`;
    case 'ticket-append':
      return str(e.text, LIMITS.maxText) ? undefined : `ticket-append.text must be a non-empty string of at most ${LIMITS.maxText} chars`;
  }
}

/**
 * Strictly validates one untrusted spec against the catalog. Generated ids are
 * namespaced with "gen-" so they can never shadow a hand-written fault.
 */
export function validateSpec(input: unknown, catalog: Fault[]): Validation {
  const fail = (reason: string): Validation => ({ ok: false, reason });
  if (!isObj(input)) return fail('spec must be an object');
  const extra = Object.keys(input).filter((k) => !SPEC_KEYS.includes(k));
  if (extra.length) return fail(`unknown field(s): ${extra.join(', ')}`);

  const rawId = typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
  const id = rawId.startsWith(GENERATED_PREFIX) ? rawId : `${GENERATED_PREFIX}${rawId}`;
  if (!/^gen-[a-z0-9][a-z0-9-]{2,40}$/.test(id)) return fail('id must be kebab-case, 3-41 chars');
  if (!SPEC_KINDS.includes(input.kind as FaultKind)) return fail(`kind must be one of ${SPEC_KINDS.join(', ')}`);
  if (!str(input.title, LIMITS.maxTitle)) return fail(`title must be a non-empty string of at most ${LIMITS.maxTitle} chars`);
  if (!str(input.hypothesis, LIMITS.maxHypothesis)) return fail(`hypothesis must be a non-empty string of at most ${LIMITS.maxHypothesis} chars`);
  if (!SPEC_ENDPOINTS.includes(input.endpoint as FaultTarget)) return fail(`unknown endpoint "${String(input.endpoint)}" (known: ${SPEC_ENDPOINTS.join(', ')})`);
  if (input.scope !== 'call' && input.scope !== 'trial') return fail('scope must be "call" or "trial"');
  if (typeof input.rate !== 'number' || !(input.rate >= LIMITS.minRate && input.rate <= 1)) return fail(`rate must be a number in ${LIMITS.minRate}..1`);
  const endpoint = input.endpoint as FaultTarget;
  const effectError = validateEffect(input.effect, endpoint);
  if (effectError) return fail(effectError);

  const spec: FaultSpec = {
    id,
    kind: input.kind as FaultKind,
    title: (input.title as string).trim(),
    hypothesis: (input.hypothesis as string).trim(),
    endpoint,
    scope: input.scope,
    rate: input.rate,
    effect: { ...(input.effect as FaultEffect) },
  };
  if (catalog.some((f) => f.id === spec.id)) return fail(`id "${spec.id}" is already in the catalog`);
  const sig = signature(spec);
  const twin = catalog.find((f) => faultSignature(f) === sig);
  if (twin) return fail(`duplicate of existing fault "${twin.id}" (${sig})`);
  return { ok: true, spec };
}

// Field paths are validated above (no __proto__ etc.); these only walk own plain-object fields.
function parent(obj: unknown, path: string): { holder: Record<string, unknown>; key: string } | undefined {
  const segs = path.split('.');
  let cur: unknown = obj;
  for (const s of segs.slice(0, -1)) {
    if (!isObj(cur) || !Object.hasOwn(cur, s)) return undefined;
    cur = cur[s];
  }
  return isObj(cur) ? { holder: cur, key: segs.at(-1)! } : undefined;
}

function rewriteJson(raw: string, fn: (body: unknown) => void): string {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return raw;
  }
  fn(body);
  return JSON.stringify(body);
}

/** The only interpreter for specs: a fixed set of effects, no code from the spec ever runs. */
export function buildFault(spec: FaultSpec): Fault {
  const e = spec.effect;
  const fault: Fault = {
    id: spec.id,
    kind: spec.kind,
    title: spec.title,
    hypothesis: spec.hypothesis,
    endpoint: spec.endpoint,
    scope: spec.scope,
    rate: spec.rate,
    spec,
    inject: (next) => next(),
  };
  switch (e.type) {
    case 'delay':
      fault.inject = async (next, ctx) => (await sleep(e.ms, ctx.signal), next());
      break;
    case 'delay-response':
      fault.inject = async (next, ctx) => {
        const res = await next();
        await sleep(e.ms, ctx.signal);
        return res;
      };
      break;
    case 'error':
      fault.inject = async () => {
        throw new HttpError(e.status, e.message);
      };
      break;
    case 'truncate':
      fault.inject = async (next) => {
        const res = await next();
        return res.slice(0, Math.floor(res.length * (e.fraction ?? 0.5)));
      };
      break;
    case 'set-field':
      fault.inject = async (next) =>
        rewriteJson(await next(), (body) => {
          const p = parent(body, e.path);
          if (p) p.holder[p.key] = e.value;
        });
      break;
    case 'drop-field':
      fault.inject = async (next) =>
        rewriteJson(await next(), (body) => {
          const p = parent(body, e.path);
          if (p) delete p.holder[p.key];
        });
      break;
    case 'append-text':
      fault.inject = async (next) =>
        rewriteJson(await next(), (body) => {
          if (isObj(body) && typeof body[e.field] === 'string') body[e.field] = `${body[e.field]} ${e.text}`;
        });
      break;
    case 'ticket-append':
      fault.rewriteTicket = (ticket) => ({ ...ticket, message: `${ticket.message} ${e.text}` });
      break;
  }
  return fault;
}
