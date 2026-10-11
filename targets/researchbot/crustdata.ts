// Crustdata (docs.crustdata.com, API version 2025-11-01) as ResearchBot sees it:
// the response shapes of the two endpoints it calls, a live client (used only to
// record), and CrustdataCassette: the sandbox every trial runs against. It
// replays recorded responses, so hundreds of chaos trials cost zero credits and
// replay deterministically, and its ledger (every call, with the credits the real
// API charged for it) is the ground truth Bulwark checks the rules against.

import { readdirSync, readFileSync } from 'node:fs';

export const API_BASE = 'https://api.crustdata.com';
export const API_VERSION = '2025-11-01';

// The wire boundary: JSON string in, JSON string out, which is where real network
// faults happen and where Bulwark's chaos layer intercepts.
export type Endpoint = 'company.enrich' | 'person.search';
export type Transport = (endpoint: Endpoint, payload: Record<string, unknown>) => Promise<string>;

export const ENDPOINT_PATHS: Record<Endpoint, string> = {
  'company.enrich': '/company/enrich',
  'person.search': '/person/search',
};

// --- Response shapes (the subset ResearchBot reads) ---

export interface CompanyData {
  crustdata_company_id?: number;
  basic_info?: { name?: string; primary_domain?: string; website?: string; year_founded?: number; employee_count_range?: string };
  headcount?: { total?: number };
  funding?: { total_investment_usd?: number; last_round_type?: string; last_fundraise_date?: string };
  taxonomy?: { professional_network_industry?: string };
}

/** POST /company/enrich: one entry per identifier; `matches` is empty when nothing matched. */
export type EnrichResponse = { matched_on: string; match_type: string; matches: { confidence_score: number; company_data: CompanyData }[] }[];

export interface PersonProfile {
  crustdata_person_id: number;
  basic_profile: { name: string; current_title?: string; headline?: string };
}

/** POST /person/search: one page of profiles; `next_cursor` is null on the last page. */
export interface PersonSearchResponse {
  profiles: PersonProfile[];
  next_cursor: string | null;
  total_count: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}

// --- Cassettes ---

/** One recorded request/response, exactly as the real API answered it. */
export interface Interaction {
  endpoint: Endpoint;
  path: string;
  request: Record<string, unknown>;
  status: number;
  /** The real `X-Credits-Used` header (estimated from the price list in synthetic cassettes). */
  creditsUsed: number;
  response: unknown;
  /** Round-trip time when it was recorded. */
  ms?: number;
}

export interface Cassette {
  /** true for hand-written cassettes; recorded cassettes are false. Never mix the two up. */
  synthetic: boolean;
  domain: string;
  apiVersion: string;
  recordedAt: string;
  note?: string;
  interactions: Interaction[];
}

/** One call the sandbox served: the ledger entry the rules read. */
export interface ApiCall {
  endpoint: Endpoint;
  request: Record<string, unknown>;
  status: number;
  creditsUsed: number;
  response: unknown;
  /** `hit`: served from a recording. `miss`: nothing recorded, answered the way the API answers no match. */
  cassette: 'hit' | 'miss';
}

const CASSETTE_DIR = new URL('./cassettes/', import.meta.url);

/** Canonical key for a request: endpoint + JSON with sorted keys, so field order never matters. */
export function requestKey(endpoint: string, request: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return `${endpoint} ${JSON.stringify(canon(request))}`;
}

export function loadCassettes(dir: URL = CASSETTE_DIR): Cassette[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Cassette);
}

export interface Manifest {
  synthetic: boolean;
  /** The company the demo ticket asks about. */
  primary: string;
  domains: string[];
  recordedAt: string;
  creditsSpent?: number;
}

export function loadManifest(dir: URL = CASSETTE_DIR): Manifest {
  return JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as Manifest;
}

// Cassettes are read once per module graph (each workspace copy reads its own).
let cached: Cassette[] | undefined;
const cassettes = () => (cached ??= loadCassettes());

export class CrustdataCassette {
  readonly calls: ApiCall[] = [];
  private byKey = new Map<string, Interaction>();

  constructor(recorded: Cassette[] = cassettes()) {
    for (const c of recorded) for (const i of c.interactions) this.byKey.set(requestKey(i.endpoint, i.request), i);
  }

  get creditsUsed(): number {
    return this.calls.reduce((s, c) => s + c.creditsUsed, 0);
  }

  serve(endpoint: Endpoint, request: Record<string, unknown>): string {
    const key = requestKey(endpoint, request);
    const hit = this.byKey.get(key);
    const status = hit?.status ?? 200;
    const response = hit ? hit.response : noMatch(endpoint, request);
    this.calls.push({ endpoint, request: { ...request }, status, creditsUsed: hit?.creditsUsed ?? 0, response, cassette: hit ? 'hit' : 'miss' });
    if (status >= 400) {
      const err = response as { error?: { message?: string } };
      throw new HttpError(status, err?.error?.message ?? 'request failed');
    }
    if (!hit) return JSON.stringify(response);
    let raw = bodies.get(hit);
    if (raw === undefined) bodies.set(hit, (raw = JSON.stringify(response)));
    return raw;
  }
}

// Recorded bodies are large (a full company record is ~300KB), so each is serialized once.
const bodies = new WeakMap<Interaction, string>();

/**
 * What the API answers when nothing matches (docs: enrich returns 200 with empty
 * `matches`; search returns no profiles). A cursor past the recorded pages is
 * treated as the last page. No credits are charged for these.
 */
function noMatch(endpoint: Endpoint, request: Record<string, unknown>): unknown {
  if (endpoint === 'company.enrich') {
    const domains = Array.isArray(request.domains) ? request.domains : [];
    return domains.map((d) => ({ matched_on: String(d), match_type: 'domain', matches: [] }));
  }
  return { profiles: [], next_cursor: null, total_count: 0 };
}

/** Replay compresses real latency to a couple of milliseconds; faults add their own delays. */
export const REPLAY_LATENCY_MS = 2;

export function cassetteTransport(sb: CrustdataCassette, signal?: AbortSignal): Transport {
  return async (endpoint, payload) => {
    await new Promise((r) => setTimeout(r, REPLAY_LATENCY_MS));
    if (signal?.aborted) throw new Error('aborted');
    return sb.serve(endpoint, payload);
  };
}

// --- Live client (record mode only) ---

export interface LiveResult {
  status: number;
  body: unknown;
  creditsUsed: number;
  headers: Record<string, string>;
  ms: number;
}

/** One real API call. Only `record.ts` uses this; trials never touch the network. */
export async function liveCall(apiKey: string, endpoint: Endpoint, payload: Record<string, unknown>): Promise<LiveResult> {
  const start = performance.now();
  const res = await fetch(API_BASE + ENDPOINT_PATHS[endpoint], {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-api-version': API_VERSION },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const headers = Object.fromEntries([...res.headers].filter(([k]) => /^x-(credits|ratelimit)/i.test(k)));
  return { status: res.status, body, creditsUsed: Number(res.headers.get('x-credits-used') ?? 0), headers, ms: Math.round(performance.now() - start) };
}

/** Free account endpoint: remaining credit balance. */
export async function creditBalance(apiKey: string): Promise<number> {
  const res = await fetch(`${API_BASE}/account/credits`, { headers: { authorization: `Bearer ${apiKey}`, 'x-api-version': API_VERSION } });
  if (!res.ok) throw new Error(`GET /account/credits: HTTP ${res.status}`);
  return ((await res.json()) as { account: { credits: number } }).account.credits;
}
