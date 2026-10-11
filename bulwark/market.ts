// npm run market -- [--dry-run] [--refresh] [--max-credits 25] [--out docs/business]
//
// Measures Bulwark's addressable market with the Crustdata API: companies that
// build or run AI agents, by headcount band, plus companies hiring for AI-agent
// roles. Results are cached in docs/business/market-data.json, so reruns spend no
// credits unless --refresh is passed. Writes market-sizing.{md,csv} for cfo.ai.
//
// Measured counts (Crustdata), assumptions (agents per company, plan mix,
// adoption) and derived numbers (TAM/SAM/SOM, revenue) are kept apart everywhere.
//
// Endpoints (docs.crustdata.com, API version 2025-11-01):
//   POST /company/search  limit 1, read total_count. Billed per result returned:
//                         0.03 base + 0.1 taxonomy + 0.2 headcount = ≤0.33 credits/query.
//   POST /job/search      limit 0 + aggregations (count, group_by company id).
//                         No rows returned, so no per-result credits.
//   GET  /account/credits free; read before and after to measure what a run cost.

import './env';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PLANS, type Plan } from './cost/economics';

export const CRUSTDATA_BASE_URL = 'https://api.crustdata.com';
export const CRUSTDATA_API_VERSION = '2025-11-01';

// --- query builder ---

export interface Condition {
  field: string;
  type: string;
  value: unknown;
}
export interface Group {
  op: 'and' | 'or';
  conditions: Filter[];
}
export type Filter = Condition | Group;

export interface Band {
  id: string;
  min: number;
  max: number | null;
}

/** Headcount bands (inclusive). Crustdata has no >= / <=, so bands use > min-1 and < max+1. */
export const BANDS: Band[] = [
  { id: '1-10', min: 1, max: 10 },
  { id: '11-50', min: 11, max: 50 },
  { id: '51-200', min: 51, max: 200 },
  { id: '201-1000', min: 201, max: 1000 },
  { id: '1001-5000', min: 1001, max: 5000 },
  { id: '5001+', min: 5001, max: null },
];

export function headcountFilter(b: Band): Filter[] {
  const c: Filter[] = [{ field: 'headcount.total', type: '>', value: b.min - 1 }];
  if (b.max !== null) c.push({ field: 'headcount.total', type: '<', value: b.max + 1 });
  return c;
}

/** Specialities that mark a company as building AI agents / LLM products (fuzzy all-words match). */
export const AGENT_TERMS = ['AI Agents', 'Agentic AI', 'LLM', 'Large Language Models', 'Conversational AI'];
/** Crustdata category tag for AI companies (value from the Crustdata docs' own example). */
export const AI_CATEGORY = 'Artificial Intelligence (AI)';
/** Job-title phrases (exact phrase match: all-words matching "AI Agent" also hits e.g. "Insurance Agent, AI tools"). */
export const ROLE_TERMS: Record<string, string[]> = {
  ai_agent: ['AI Agent', 'Agentic'],
  llm_engineer: ['LLM Engineer', 'LLM'],
  agent_reliability: ['Agent Reliability', 'AI Reliability'],
  ai_support: ['AI Support', 'AI Customer Support'],
};
export const JOB_WINDOW_DAYS = 90;
const DISTINCT_CAP = 1000;

/** `(.)` = fuzzy all-words match, `[.]` = exact phrase. */
const anyOf = (field: string, terms: string[], type: '(.)' | '[.]' = '(.)'): Group => ({ op: 'or', conditions: terms.map((t) => ({ field, type, value: t })) });

export const agentBuilderFilter = (): Group => anyOf('taxonomy.professional_network_specialities', AGENT_TERMS);
/** TAM: AI-category companies OR agent builders, so SAM ⊆ TAM by construction. */
export const aiMarketFilter = (): Group => ({
  op: 'or',
  conditions: [{ field: 'taxonomy.categories', type: 'in', value: [AI_CATEGORY] }, agentBuilderFilter()],
});
export const supportAiFilter = (): Group => anyOf('taxonomy.professional_network_specialities', ['AI Customer Support', 'AI Customer Service']);

export type Segment = 'ai_market' | 'agent_builders' | 'support_ai' | `hiring_${string}`;

export interface QuerySpec {
  id: string;
  segment: Segment;
  band?: string;
  endpoint: '/company/search' | '/job/search';
  description: string;
  body: Record<string, unknown>;
  /** Upper bound on credits at list price. */
  maxCredits: number;
}

const COMPANY_CREDITS_PER_RESULT = { base: 0.03, taxonomy: 0.1, headcount: 0.2 };

function companyQuery(id: string, segment: Segment, description: string, filter: Filter, band?: Band): QuerySpec {
  const filters: Filter = band ? { op: 'and', conditions: [filter, ...headcountFilter(band)] } : filter;
  const c = COMPANY_CREDITS_PER_RESULT;
  return {
    id,
    segment,
    band: band?.id,
    endpoint: '/company/search',
    description,
    body: { filters, limit: 1, fields: ['crustdata_company_id'] },
    maxCredits: +(c.base + c.taxonomy + (band ? c.headcount : 0)).toFixed(2),
  };
}

export function isoDaysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The full, fixed set of queries `npm run market` sends. */
export function buildQueries(now = new Date()): QuerySpec[] {
  const q: QuerySpec[] = [];
  const segs: [Segment, string, () => Filter][] = [
    ['ai_market', `AI companies: category "${AI_CATEGORY}" OR agent/LLM specialities`, aiMarketFilter],
    ['agent_builders', `Agent builders: specialities match any of ${AGENT_TERMS.map((t) => `"${t}"`).join(', ')}`, agentBuilderFilter],
  ];
  for (const [seg, desc, f] of segs) {
    q.push(companyQuery(`${seg}:all`, seg, `${desc} (any headcount)`, f()));
    for (const b of BANDS) q.push(companyQuery(`${seg}:${b.id}`, seg, `${desc}, headcount ${b.id}`, f(), b));
  }
  q.push(companyQuery('support_ai:all', 'support_ai', 'AI customer-support companies: specialities "AI Customer Support" or "AI Customer Service"', supportAiFilter()));

  const since = isoDaysAgo(JOB_WINDOW_DAYS, now);
  const roles: [string, string[]][] = [...Object.entries(ROLE_TERMS), ['any', Object.values(ROLE_TERMS).flat()]];
  for (const [role, terms] of roles) {
    q.push({
      id: `hiring_${role}:${JOB_WINDOW_DAYS}d`,
      segment: `hiring_${role}`,
      endpoint: '/job/search',
      description: `Job listings added since ${since} with title containing any exact phrase ${terms.map((t) => `"${t}"`).join(', ')}`,
      body: {
        filters: { op: 'and', conditions: [anyOf('job_details.title', terms, '[.]'), { field: 'metadata.date_added', type: '=>', value: since }] },
        limit: 0,
        aggregations: [{ type: 'count' }, { type: 'group_by', field: 'company.basic_info.company_id', agg: 'count', size: DISTINCT_CAP }],
      },
      maxCredits: 0,
    });
  }
  return q;
}

// --- runner ---

export interface QueryResult {
  id: string;
  segment: Segment;
  band?: string;
  endpoint: string;
  description: string;
  body: Record<string, unknown>;
  status: number;
  /** Matching companies (company search) or job listings (job search). null if Crustdata didn't report one. */
  totalCount: number | null;
  /** Job search only: distinct companies among the listings (group_by buckets). */
  distinctCompanies?: number | null;
  /** True when distinctCompanies hit the group_by cap, so the real number is at least this. */
  distinctCapped?: boolean;
  creditsUsed: number | null;
  ranAt: string;
  error?: string;
}

export interface MarketData {
  source: 'crustdata-api';
  baseUrl: string;
  apiVersion: string;
  ranAt: string;
  creditsBefore: number | null;
  creditsAfter: number | null;
  /** Sum of X-Credits-Used headers. */
  creditsUsed: number;
  results: QueryResult[];
}

type Fetch = typeof fetch;

export function headers(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-api-version': CRUSTDATA_API_VERSION };
}

async function balance(apiKey: string, f: Fetch, baseUrl: string): Promise<number | null> {
  try {
    const r = await f(`${baseUrl}/account/credits`, { headers: headers(apiKey) });
    if (!r.ok) return null;
    const j = (await r.json()) as { account?: { credits?: number } };
    return typeof j.account?.credits === 'number' ? j.account.credits : null;
  } catch {
    return null;
  }
}

export async function runQueries(
  specs: QuerySpec[],
  opts: { apiKey: string; fetch?: Fetch; baseUrl?: string; maxCredits?: number; log?: (s: string) => void },
): Promise<MarketData> {
  const f = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? CRUSTDATA_BASE_URL;
  const budget = opts.maxCredits ?? 25;
  const planned = specs.reduce((s, q) => s + q.maxCredits, 0);
  if (planned > budget) throw new Error(`planned queries may cost up to ${planned.toFixed(2)} credits, over --max-credits ${budget}`);
  const creditsBefore = await balance(opts.apiKey, f, baseUrl);
  const results: QueryResult[] = [];
  let spent = 0;
  for (const q of specs) {
    const ranAt = new Date().toISOString();
    const r = await f(`${baseUrl}${q.endpoint}`, { method: 'POST', headers: headers(opts.apiKey), body: JSON.stringify(q.body) });
    const credHeader = r.headers.get('x-credits-used');
    const creditsUsed = credHeader === null ? null : Number(credHeader);
    spent += creditsUsed ?? 0;
    const base = { id: q.id, segment: q.segment, band: q.band, endpoint: q.endpoint, description: q.description, body: q.body, status: r.status, creditsUsed, ranAt };
    if (!r.ok) {
      const text = (await r.text()).slice(0, 300);
      if (r.status === 401 || r.status === 403) throw new Error(`Crustdata rejected the API key (${r.status}): ${text}`);
      results.push({ ...base, totalCount: null, error: `HTTP ${r.status}: ${text}` });
    } else {
      const j = (await r.json()) as { total_count?: number | null; aggregations?: { type: string; value?: number; buckets?: unknown[] }[] };
      const res: QueryResult = { ...base, totalCount: typeof j.total_count === 'number' ? j.total_count : null };
      if (q.endpoint === '/job/search') {
        const g = j.aggregations?.find((a) => a.type === 'group_by');
        res.distinctCompanies = Array.isArray(g?.buckets) ? g.buckets.length : null;
        res.distinctCapped = res.distinctCompanies !== null && res.distinctCompanies >= DISTINCT_CAP;
        const c = j.aggregations?.find((a) => a.type === 'count');
        if (res.totalCount === null && typeof c?.value === 'number') res.totalCount = c.value;
      }
      results.push(res);
    }
    opts.log?.(`  ${q.id.padEnd(28)} ${results.at(-1)!.totalCount ?? results.at(-1)!.error ?? 'null'}  (${creditsUsed ?? '?'} credits)`);
    if (spent > budget) throw new Error(`stopped: spent ${spent} credits, over --max-credits ${budget}`);
  }
  const creditsAfter = await balance(opts.apiKey, f, baseUrl);
  return { source: 'crustdata-api', baseUrl, apiVersion: CRUSTDATA_API_VERSION, ranAt: new Date().toISOString(), creditsBefore, creditsAfter, creditsUsed: +spent.toFixed(4), results };
}

// --- derivation ---

export type PlanName = 'Starter' | 'Team' | 'Enterprise';

export interface MarketAssumptions {
  /** Production AI agents per buying company, by headcount band. */
  agentsPerCompany: Record<string, number>;
  /** Which plan a company of that size buys. */
  planByBand: Record<string, PlanName>;
  /** Share of SAM companies paying for Bulwark at the end of each year. Year 3 is the SOM. */
  adoption: [number, number, number];
}

/** Assumptions, not measurements. */
export const DEFAULT_MARKET_ASSUMPTIONS: MarketAssumptions = {
  agentsPerCompany: { '1-10': 1, '11-50': 2, '51-200': 3, '201-1000': 5, '1001-5000': 10, '5001+': 20 },
  planByBand: { '1-10': 'Starter', '11-50': 'Starter', '51-200': 'Team', '201-1000': 'Team', '1001-5000': 'Enterprise', '5001+': 'Enterprise' },
  adoption: [0.001, 0.003, 0.01],
};

export interface BandRow {
  band: string;
  tamCompanies: number | null;
  samCompanies: number | null;
  agentsPerCompany: number;
  plan: PlanName;
  priceUsd: number;
  /** Annual contract value per company = agents × price × 12. */
  acvUsd: number;
  tamUsd: number;
  samUsd: number;
}

export interface Derived {
  bands: BandRow[];
  missingBands: string[];
  tam: { companies: number; agents: number; arrUsd: number };
  sam: { companies: number; agents: number; arrUsd: number };
  som: { companies: number; agents: number; arrUsd: number; adoption: number };
  years: { year: number; adoption: number; customers: number; agents: number; arrUsd: number }[];
  hiring: { segment: string; jobs: number | null; companies: number | null; capped: boolean }[];
  supportAi: number | null;
  unbanded: { tam: number | null; sam: number | null };
}

export function derive(data: Pick<MarketData, 'results'>, plans: Plan[] = DEFAULT_PLANS, a: MarketAssumptions = DEFAULT_MARKET_ASSUMPTIONS): Derived {
  const count = (id: string) => data.results.find((r) => r.id === id)?.totalCount ?? null;
  const price = (name: PlanName) => {
    const p = plans.find((x) => x.name === name);
    if (!p) throw new Error(`no plan named ${name}`);
    return p.priceUsd;
  };
  const missingBands: string[] = [];
  const bands: BandRow[] = BANDS.map((b) => {
    const tamCompanies = count(`ai_market:${b.id}`);
    const samCompanies = count(`agent_builders:${b.id}`);
    if (tamCompanies === null || samCompanies === null) missingBands.push(b.id);
    const agentsPerCompany = a.agentsPerCompany[b.id];
    const plan = a.planByBand[b.id];
    const priceUsd = price(plan);
    const acvUsd = agentsPerCompany * priceUsd * 12;
    return { band: b.id, tamCompanies, samCompanies, agentsPerCompany, plan, priceUsd, acvUsd, tamUsd: (tamCompanies ?? 0) * acvUsd, samUsd: (samCompanies ?? 0) * acvUsd };
  });
  const tot = (f: (r: BandRow) => number) => bands.reduce((s, r) => s + f(r), 0);
  const atAdoption = (x: number) => ({
    companies: tot((r) => (r.samCompanies ?? 0) * x),
    agents: tot((r) => (r.samCompanies ?? 0) * x * r.agentsPerCompany),
    arrUsd: tot((r) => r.samUsd * x),
  });
  const y3 = a.adoption[2];
  const hiring = data.results
    .filter((r) => r.endpoint === '/job/search')
    .map((r) => ({ segment: r.segment, jobs: r.totalCount, companies: r.distinctCompanies ?? null, capped: !!r.distinctCapped }));
  return {
    bands,
    missingBands,
    tam: { companies: tot((r) => r.tamCompanies ?? 0), agents: tot((r) => (r.tamCompanies ?? 0) * r.agentsPerCompany), arrUsd: tot((r) => r.tamUsd) },
    sam: { companies: tot((r) => r.samCompanies ?? 0), agents: tot((r) => (r.samCompanies ?? 0) * r.agentsPerCompany), arrUsd: tot((r) => r.samUsd) },
    som: { ...atAdoption(y3), adoption: y3 },
    years: a.adoption.map((x, i) => {
      const v = atAdoption(x);
      return { year: i + 1, adoption: x, customers: v.companies, agents: v.agents, arrUsd: v.arrUsd };
    }),
    hiring,
    supportAi: count('support_ai:all'),
    unbanded: { tam: count('ai_market:all'), sam: count('agent_builders:all') },
  };
}

// --- rendering ---

const n = (x: number | null) => (x === null ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const $ = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x).toLocaleString('en-US')}`);
const pc = (x: number) => `${+(x * 100).toFixed(2)}%`;

export function assumptionLines(a: MarketAssumptions = DEFAULT_MARKET_ASSUMPTIONS): string[] {
  return [
    `- **Agents per company** (by headcount): ${BANDS.map((b) => `${b.id}: ${a.agentsPerCompany[b.id]}`).join(', ')}. A guess at production agents per buyer, not measured.`,
    `- **Plan by company size**: ${BANDS.map((b) => `${b.id}: ${a.planByBand[b.id]}`).join(', ')}. Prices per agent per month from the economics module (${DEFAULT_PLANS.map((p) => `${p.name} $${p.priceUsd}`).join(', ')}).`,
    `- **Adoption** (share of SAM companies paying at year end): Year 1 ${pc(a.adoption[0])}, Year 2 ${pc(a.adoption[1])}, Year 3 ${pc(a.adoption[2])}. SOM = Year 3. Deliberately conservative.`,
    '- **TAM** = companies tagged AI by Crustdata, or with agent/LLM specialities. **SAM** = the agent/LLM-speciality subset (companies that build or ship agents). Companies with no headcount on record are not in any band, so they are left out.',
    '- Every company in a band is priced at that band\'s plan, with all its agents covered. ARR = companies × agents × price × 12.',
  ];
}

export function marketSectionMd(d: Derived, data: Pick<MarketData, 'ranAt'>): string[] {
  return [
    '## Market (Crustdata)',
    '',
    `Measured with the Crustdata API on ${data.ranAt.slice(0, 10)} (\`npm run market\`, full queries in [market-sizing.md](market-sizing.md)). Company counts are measured; dollars use the assumptions listed below.`,
    '',
    '| | Companies (measured) | Agents (assumed per company) | ARR |',
    '|---|---|---|---|',
    `| TAM: AI companies | ${n(d.tam.companies)} | ${n(d.tam.agents)} | ${$(d.tam.arrUsd)} |`,
    `| SAM: companies building AI agents | ${n(d.sam.companies)} | ${n(d.sam.agents)} | ${$(d.sam.arrUsd)} |`,
    `| SOM: ${pc(d.som.adoption)} of SAM (assumed adoption) | ${n(d.som.companies)} | ${n(d.som.agents)} | ${$(d.som.arrUsd)} |`,
    '',
    '### Revenue scenario (assumed adoption × measured SAM)',
    '',
    '| Year | Adoption (assumed) | Paying companies | Agents | ARR at year end |',
    '|---|---|---|---|---|',
    ...d.years.map((y) => `| ${y.year} | ${pc(y.adoption)} | ${n(y.customers)} | ${n(y.agents)} | ${$(y.arrUsd)} |`),
    '',
    '**Market assumptions (not measured):**',
    '',
    ...assumptionLines(),
    '',
  ];
}

export function renderSizingMd(data: MarketData, d: Derived): string {
  const q = data.results;
  const credits = data.creditsBefore !== null && data.creditsAfter !== null ? `${+(data.creditsBefore - data.creditsAfter).toFixed(2)} by account balance, ` : '';
  return [
    '# Bulwark market sizing',
    '',
    `Generated by \`npm run market\` from Crustdata API queries run on ${data.ranAt.slice(0, 10)} (${q.length} queries, ${credits}${data.creditsUsed} by X-Credits-Used). ` +
      'Every number in **Measured** is a count Crustdata returned. **Assumptions** are choices. **Derived** combines the two.',
    '',
    '## Measured (Crustdata, with exact queries and date)',
    '',
    `API: \`${data.baseUrl}\`, \`x-api-version: ${data.apiVersion}\`. Company counts are \`total_count\` from \`POST /company/search\` with \`limit: 1\`. Job counts are \`total_count\` from \`POST /job/search\` with \`limit: 0\`, and distinct companies are the number of \`group_by company.basic_info.company_id\` buckets (capped at ${DISTINCT_CAP}; "≥" means the cap was hit).`,
    '',
    '| Query | Description | Count | Distinct companies | Credits | Ran at |',
    '|---|---|---|---|---|---|',
    ...q.map(
      (r) =>
        `| \`${r.id}\` | ${r.description} | ${r.error ? `error: ${r.error.replace(/\|/g, '/').slice(0, 80)}` : n(r.totalCount)} | ${r.endpoint === '/job/search' ? `${r.distinctCapped ? '≥' : ''}${n(r.distinctCompanies ?? null)}` : ''} | ${r.creditsUsed ?? '?'} | ${r.ranAt} |`,
    ),
    '',
    '<details><summary>Exact request bodies</summary>',
    '',
    ...q.flatMap((r) => [`\`${r.id}\`: \`POST ${r.endpoint}\``, '', '```json', JSON.stringify(r.body), '```', '']),
    '</details>',
    '',
    '## Assumptions',
    '',
    ...assumptionLines(),
    '',
    '## Derived',
    '',
    ...(d.missingBands.length ? [`> Bands with no count from Crustdata (left out of the totals): ${d.missingBands.join(', ')}.`, ''] : []),
    '| Headcount | TAM companies | SAM companies | Agents / company | Plan | ACV / company | TAM ARR | SAM ARR |',
    '|---|---|---|---|---|---|---|---|',
    ...d.bands.map((b) => `| ${b.band} | ${n(b.tamCompanies)} | ${n(b.samCompanies)} | ${b.agentsPerCompany} | ${b.plan} ($${b.priceUsd}) | ${$(b.acvUsd)} | ${$(b.tamUsd)} | ${$(b.samUsd)} |`),
    `| **Total** | **${n(d.tam.companies)}** | **${n(d.sam.companies)}** | | | | **${$(d.tam.arrUsd)}** | **${$(d.sam.arrUsd)}** |`,
    '',
    `Unbanded totals (any headcount, including companies with none on record): TAM ${n(d.unbanded.tam)}, SAM ${n(d.unbanded.sam)}.`,
    '',
    '| | Companies | Agents | ARR |',
    '|---|---|---|---|',
    `| TAM | ${n(d.tam.companies)} | ${n(d.tam.agents)} | ${$(d.tam.arrUsd)} |`,
    `| SAM | ${n(d.sam.companies)} | ${n(d.sam.agents)} | ${$(d.sam.arrUsd)} |`,
    `| SOM (${pc(d.som.adoption)} of SAM) | ${n(d.som.companies)} | ${n(d.som.agents)} | ${$(d.som.arrUsd)} |`,
    '',
    '### Revenue scenario, Year 1 to 3',
    '',
    '| Year | Adoption (assumed) | Paying companies | Agents | ARR at year end |',
    '|---|---|---|---|---|',
    ...d.years.map((y) => `| ${y.year} | ${pc(y.adoption)} | ${n(y.customers)} | ${n(y.agents)} | ${$(y.arrUsd)} |`),
    '',
    '### Demand signal: hiring (measured, not used in the math)',
    '',
    `Companies posting jobs in the last ${JOB_WINDOW_DAYS} days whose titles name agent or LLM work. This corroborates SAM; it is not added to it.`,
    '',
    '| Role query | Job listings | Distinct companies |',
    '|---|---|---|',
    ...d.hiring.map((h) => `| ${h.segment.replace('hiring_', '')} | ${n(h.jobs)} | ${h.capped ? '≥' : ''}${n(h.companies)} |`),
    '',
    `AI customer-support companies (support_ai:all): ${n(d.supportAi)}.`,
    '',
    '## Reproduce',
    '',
    '```bash',
    'npm run market -- --dry-run   # print the exact queries, no key or credits needed',
    'npm run market                # re-derive from the cached market-data.json (no credits)',
    'npm run market -- --refresh   # re-run the queries (needs CRUSTDATA_API_KEY; ~5 credits)',
    '```',
    '',
  ].join('\n');
}

export function marketCsvRows(d: Derived, a: MarketAssumptions = DEFAULT_MARKET_ASSUMPTIONS): (string | number)[][] {
  const rows: (string | number)[][] = [];
  const add = (section: string, metric: string, value: number | null, unit: string, basis: 'measured' | 'assumed' | 'derived') =>
    rows.push([section, metric, value === null ? '' : +value.toFixed(4), unit, basis]);
  for (const b of d.bands) {
    add('market_measured', `tam_companies_${b.band}`, b.tamCompanies, 'count', 'measured');
    add('market_measured', `sam_companies_${b.band}`, b.samCompanies, 'count', 'measured');
  }
  for (const h of d.hiring) {
    add('market_measured', `${h.segment}_jobs_${JOB_WINDOW_DAYS}d`, h.jobs, 'count', 'measured');
    add('market_measured', `${h.segment}_companies_${JOB_WINDOW_DAYS}d${h.capped ? '_min' : ''}`, h.companies, 'count', 'measured');
  }
  for (const b of BANDS) {
    add('market_assumption', `agents_per_company_${b.id}`, a.agentsPerCompany[b.id], 'count', 'assumed');
    add('market_assumption', `plan_price_${b.id}_${a.planByBand[b.id].toLowerCase()}`, d.bands.find((x) => x.band === b.id)!.priceUsd, 'USD/agent/month', 'assumed');
  }
  a.adoption.forEach((x, i) => add('market_assumption', `adoption_year_${i + 1}`, x, 'fraction', 'assumed'));
  for (const k of ['tam', 'sam', 'som'] as const) {
    add('market_derived', `${k}_companies`, d[k].companies, 'count', 'derived');
    add('market_derived', `${k}_agents`, d[k].agents, 'count', 'derived');
    add('market_derived', `${k}_arr`, d[k].arrUsd, 'USD/year', 'derived');
  }
  for (const y of d.years) {
    add('revenue_scenario', `year_${y.year}_customers`, y.customers, 'count', 'derived');
    add('revenue_scenario', `year_${y.year}_agents`, y.agents, 'count', 'derived');
    add('revenue_scenario', `year_${y.year}_arr`, y.arrUsd, 'USD/year', 'derived');
  }
  return rows;
}

export function loadMarketData(file: string): MarketData | undefined {
  if (!existsSync(file)) return undefined;
  const d = JSON.parse(readFileSync(file, 'utf8')) as MarketData;
  return d.source === 'crustdata-api' && d.results?.some((r) => r.totalCount !== null) ? d : undefined;
}

export function dryRun(specs: QuerySpec[]): string {
  const total = specs.reduce((s, q) => s + q.maxCredits, 0);
  const out = [`Dry run: ${specs.length} queries to ${CRUSTDATA_BASE_URL}, at most ${total.toFixed(2)} credits at list price.`, `Headers: authorization: Bearer $CRUSTDATA_API_KEY, content-type: application/json, x-api-version: ${CRUSTDATA_API_VERSION}`, ''];
  for (const q of specs) out.push(`# ${q.id} (≤${q.maxCredits} credits): ${q.description}`, `POST ${CRUSTDATA_BASE_URL}${q.endpoint}`, JSON.stringify(q.body), '');
  return out.join('\n');
}

// --- CLI ---

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      'max-credits': { type: 'string', default: '25' },
      out: { type: 'string', default: 'docs/business' },
    },
  });
  const specs = buildQueries();
  if (values['dry-run']) {
    console.log(dryRun(specs));
    return;
  }
  const out = values.out!;
  const cache = join(out, 'market-data.json');
  let data = values.refresh ? undefined : loadMarketData(cache);
  if (data) console.log(`Using cached Crustdata results from ${data.ranAt} (${cache}); pass --refresh to re-query.`);
  else {
    const apiKey = process.env.CRUSTDATA_API_KEY;
    if (!apiKey) throw new Error('CRUSTDATA_API_KEY is not set. Set CRUSTDATA_API_KEY in .env to measure the market (or run `npm run market -- --dry-run` to see the queries). No market numbers were written.');
    console.log(`Querying Crustdata (${specs.length} queries)...`);
    data = await runQueries(specs, { apiKey, maxCredits: Number(values['max-credits']), log: console.log });
    if (!data.results.some((r) => r.totalCount !== null)) throw new Error('Crustdata returned no counts; nothing written. See the errors above.');
    mkdirSync(out, { recursive: true });
    writeFileSync(cache, JSON.stringify(data, null, 2) + '\n');
  }
  const d = derive(data);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'market-sizing.md'), renderSizingMd(data, d));
  const rows = [['section', 'metric', 'value', 'unit', 'basis'], ...marketCsvRows(d)];
  writeFileSync(join(out, 'market-sizing.csv'), rows.map((r) => r.join(',')).join('\n') + '\n');
  console.log(`TAM ${n(d.tam.companies)} companies / ${$(d.tam.arrUsd)}; SAM ${n(d.sam.companies)} / ${$(d.sam.arrUsd)}; SOM ${n(d.som.companies)} / ${$(d.som.arrUsd)}`);
  console.log(`Credits used by the measuring run: ${data.creditsUsed}. Wrote ${out}/market-sizing.md and .csv`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
