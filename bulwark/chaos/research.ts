// ResearchBot's fault catalog: how a real data API (Crustdata) breaks. Endpoints
// are ResearchBot's: `company.enrich` (POST /company/enrich) and `person.search`
// (POST /person/search). Error bodies and headers follow Crustdata's docs:
// a 429 carries `x-ratelimit-reset` (seconds until capacity frees up).
//
// Transient faults (429 window, 5xx, latency, truncated body) hit a trial and then
// clear, the way real blips do, so a correct retry always gets through and a
// wrong one (e.g. retrying inside the rate-limit window) is caught by the Judge.

import type { Fault, FaultContext } from './faults';
import { HttpError, sleep } from './util';

/** Seconds a 429 tells the client to wait (Crustdata: `x-ratelimit-reset`). */
export const RATE_LIMIT_RESET_S = 2;

// Per-trial fault state (one FaultContext per trial).
const state = new WeakMap<FaultContext, { calls: number; limitedUntil?: number }>();
const stateOf = (ctx: FaultContext) => {
  let s = state.get(ctx);
  if (!s) state.set(ctx, (s = { calls: 0 }));
  return s;
};
/** True for the first call this fault sees in a trial: a blip that clears on retry. */
const firstCall = (ctx: FaultContext) => stateOf(ctx).calls++ === 0;

type Json = Record<string, any>;
const rewrite = (raw: string, fn: (body: any) => void): string => {
  const body = JSON.parse(raw);
  fn(body);
  return JSON.stringify(body);
};

export const RESEARCH_FAULTS: Fault[] = [
  {
    id: 'crustdata-429',
    kind: 'rate-limit',
    title: 'Company enrich returns 429 (rate limit window)',
    hypothesis: `If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the ${RATE_LIMIT_RESET_S}s x-ratelimit-reset window fails again.`,
    endpoint: 'company.enrich',
    scope: 'trial',
    rate: 0.5,
    inject: async (next, ctx) => {
      const s = stateOf(ctx);
      const now = performance.now();
      s.limitedUntil ??= now + RATE_LIMIT_RESET_S * 1000;
      if (now < s.limitedUntil) {
        throw new HttpError(429, 'Rate limit exceeded for this endpoint.', {
          'x-ratelimit-limit': '15',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(RATE_LIMIT_RESET_S),
          'retry-after': String(RATE_LIMIT_RESET_S),
        });
      }
      return next();
    },
  },
  {
    id: 'crustdata-5xx',
    kind: 'server-error',
    title: 'Person search returns 500 once',
    hypothesis: 'If /person/search has a transient 500, ResearchBot crashes because search_people never retries.',
    endpoint: 'person.search',
    scope: 'trial',
    rate: 0.5,
    inject: async (next, ctx) => {
      if (firstCall(ctx)) throw new HttpError(500, 'Internal Server Error: try again later');
      return next();
    },
  },
  {
    id: 'crustdata-latency',
    kind: 'latency',
    title: 'Company enrich responds after 10s',
    hypothesis: 'If /company/enrich takes 10s to respond, ResearchBot hangs because enrich_company has no timeout.',
    endpoint: 'company.enrich',
    scope: 'trial',
    rate: 0.5,
    inject: async (next, ctx) => {
      // The server does the work (and bills it); only the response is slow.
      const res = await next();
      if (firstCall(ctx)) await sleep(10_000, ctx.signal);
      return res;
    },
  },
  {
    id: 'truncated-json',
    kind: 'malformed',
    title: 'Person search body is cut off mid-JSON',
    hypothesis: 'If a /person/search response is truncated, ResearchBot crashes because it parses the body without validating or retrying.',
    endpoint: 'person.search',
    scope: 'trial',
    rate: 0.5,
    inject: async (next, ctx) => {
      const res = await next();
      return firstCall(ctx) ? res.slice(0, Math.floor(res.length / 2)) : res;
    },
  },
  {
    id: 'missing-field',
    kind: 'partial',
    title: 'Company record comes back without its headcount section',
    hypothesis: 'If /company/enrich returns a partial record (no headcount), ResearchBot crashes on the missing field, or, once that is guarded, invents a headcount.',
    endpoint: 'company.enrich',
    scope: 'trial',
    rate: 0.5,
    inject: async (next) =>
      rewrite(await next(), (body: Json[]) => {
        for (const entry of Array.isArray(body) ? body : []) for (const m of entry?.matches ?? []) if (m?.company_data) delete m.company_data.headcount;
      }),
  },
  {
    id: 'empty-people',
    kind: 'empty',
    title: 'Person search finds nobody',
    hypothesis: 'If /person/search returns zero profiles, ResearchBot treats it as success and invents decision-makers.',
    endpoint: 'person.search',
    scope: 'trial',
    rate: 0.5,
    inject: async () => JSON.stringify({ profiles: [], next_cursor: null, total_count: 0 }),
  },
  {
    id: 'pagination-loop',
    kind: 'loop',
    title: 'Person search cursor never advances',
    hypothesis: 'If /person/search ignores the cursor and keeps returning page 1 with a next_cursor, ResearchBot pages forever: unbounded calls, credits and time.',
    endpoint: 'person.search',
    scope: 'trial',
    rate: 0.5,
    inject: async (next, _ctx, payload = {}) => {
      // The server ignores the cursor: every request is answered (and billed) as page 1.
      const { cursor, ...firstPage } = payload;
      return rewrite(await next(firstPage), (body) => {
        body.next_cursor = (cursor as string | undefined) ?? body.next_cursor ?? 'stuck-cursor';
      });
    },
  },
];
