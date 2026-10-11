import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PLANS } from '../bulwark/cost/economics';
import {
  BANDS,
  CRUSTDATA_API_VERSION,
  DEFAULT_MARKET_ASSUMPTIONS,
  buildQueries,
  derive,
  dryRun,
  headcountFilter,
  isoDaysAgo,
  loadMarketData,
  marketCsvRows,
  marketSectionMd,
  renderSizingMd,
  runQueries,
  type Group,
  type MarketData,
  type QueryResult,
} from '../bulwark/market';

const NOW = new Date('2026-10-11T12:00:00Z');

// --- query builder ---

test('headcount bands are inclusive using only > and < (Crustdata has no >= / <=)', () => {
  assert.deepEqual(headcountFilter(BANDS[1]), [
    { field: 'headcount.total', type: '>', value: 10 },
    { field: 'headcount.total', type: '<', value: 51 },
  ]);
  assert.deepEqual(headcountFilter(BANDS.at(-1)!), [{ field: 'headcount.total', type: '>', value: 5000 }]);
  // bands tile 1..∞ with no gap or overlap
  for (let i = 1; i < BANDS.length; i++) assert.equal(BANDS[i].min, BANDS[i - 1].max! + 1);
});

test('buildQueries: company counts use limit 1, job counts use limit 0 + aggregations, and the whole set stays far under budget', () => {
  const q = buildQueries(NOW);
  assert.equal(new Set(q.map((x) => x.id)).size, q.length, 'ids are unique');
  const companies = q.filter((x) => x.endpoint === '/company/search');
  const jobs = q.filter((x) => x.endpoint === '/job/search');
  assert.equal(companies.length, 2 * (BANDS.length + 1) + 1);
  for (const c of companies) {
    assert.equal(c.body.limit, 1);
    assert.deepEqual(c.body.fields, ['crustdata_company_id']);
  }
  for (const j of jobs) {
    assert.equal(j.body.limit, 0);
    assert.equal(j.maxCredits, 0);
    const f = j.body.filters as Group;
    assert.deepEqual(f.conditions[1], { field: 'metadata.date_added', type: '=>', value: '2026-07-13' });
  }
  const total = q.reduce((s, x) => s + x.maxCredits, 0);
  assert.ok(total < 10, `max ${total} credits`);
  // a banded agent-builder query ANDs the speciality group with the band
  const b = q.find((x) => x.id === 'agent_builders:51-200')!;
  const f = b.body.filters as Group;
  assert.equal(f.op, 'and');
  assert.equal((f.conditions[0] as Group).op, 'or');
  assert.deepEqual(f.conditions.slice(1), headcountFilter(BANDS[2]));
  assert.equal(b.maxCredits, 0.33);
});

test('TAM filter contains the SAM filter, so SAM ⊆ TAM by construction', () => {
  const q = buildQueries(NOW);
  const tam = q.find((x) => x.id === 'ai_market:all')!.body.filters as Group;
  const sam = q.find((x) => x.id === 'agent_builders:all')!.body.filters;
  assert.equal(tam.op, 'or');
  assert.deepEqual(tam.conditions[1], sam);
});

test('isoDaysAgo and dryRun', () => {
  assert.equal(isoDaysAgo(90, NOW), '2026-07-13');
  const s = dryRun(buildQueries(NOW));
  assert.match(s, /20 queries/);
  assert.match(s, /POST https:\/\/api\.crustdata\.com\/company\/search/);
  assert.doesNotMatch(s, /Bearer [^$]/);
});

// --- runner (fetch mocked) ---

function mockFetch(calls: { url: string; init?: RequestInit }[], over: Partial<Record<string, () => Response>> = {}): typeof fetch {
  let balance = 5000;
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const path = new URL(u).pathname;
    if (over[path]) return over[path]!();
    if (path === '/account/credits') return Response.json({ account: { credits: balance } });
    const body = JSON.parse(String(init!.body));
    if (path === '/company/search') {
      balance -= 0.33;
      return Response.json({ companies: [{ crustdata_company_id: 1 }], next_cursor: 'x', total_count: 1234 }, { headers: { 'x-credits-used': '0.33' } });
    }
    assert.equal(body.limit, 0);
    return Response.json(
      { job_listings: [], next_cursor: null, total_count: 77, aggregations: [{ type: 'count', field: null, value: 77 }, { type: 'group_by', field: 'company.basic_info.company_id', buckets: [{ key: 1, count: 50 }, { key: 2, count: 27 }] }] },
      { headers: { 'x-credits-used': '0' } },
    );
  }) as typeof fetch;
}

test('runQueries sends the right headers and body, reads total_count, distinct companies and credits', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const specs = buildQueries(NOW);
  const d = await runQueries(specs, { apiKey: 'k-test', fetch: mockFetch(calls) });
  assert.equal(calls.length, specs.length + 2, 'one call per query + balance before/after');
  const first = calls[1];
  assert.equal(first.url, 'https://api.crustdata.com/company/search');
  const h = first.init!.headers as Record<string, string>;
  assert.equal(h.authorization, 'Bearer k-test');
  assert.equal(h['x-api-version'], CRUSTDATA_API_VERSION);
  assert.deepEqual(JSON.parse(String(first.init!.body)), specs[0].body);
  const c = d.results.find((r) => r.id === 'agent_builders:11-50')!;
  assert.equal(c.totalCount, 1234);
  assert.equal(c.creditsUsed, 0.33);
  const j = d.results.find((r) => r.endpoint === '/job/search')!;
  assert.equal(j.totalCount, 77);
  assert.equal(j.distinctCompanies, 2);
  assert.equal(j.distinctCapped, false);
  assert.equal(d.creditsUsed, +(0.33 * 15).toFixed(4));
  assert.equal(d.creditsBefore, 5000);
  assert.ok(Math.abs(d.creditsBefore! - d.creditsAfter! - 0.33 * 15) < 1e-9);
});

test('runQueries refuses a plan over budget before spending anything, and fails fast on a bad key', async () => {
  const calls: { url: string }[] = [];
  await assert.rejects(runQueries(buildQueries(NOW), { apiKey: 'k', fetch: mockFetch(calls), maxCredits: 1 }), /over --max-credits 1/);
  assert.equal(calls.length, 0);
  await assert.rejects(
    runQueries(buildQueries(NOW), { apiKey: 'bad', fetch: mockFetch([], { '/company/search': () => new Response('unauthorized', { status: 401 }) }) }),
    /rejected the API key \(401\)/,
  );
});

test('runQueries records a non-auth HTTP error as a null count, never a number', async () => {
  const d = await runQueries(buildQueries(NOW).slice(0, 1), { apiKey: 'k', fetch: mockFetch([], { '/company/search': () => new Response('bad field', { status: 400 }) }) });
  assert.equal(d.results[0].totalCount, null);
  assert.match(d.results[0].error!, /HTTP 400/);
});

// --- derivation ---

function fixture(tam: number[], sam: number[], extra: Partial<QueryResult>[] = []): MarketData {
  const r = (id: string, totalCount: number | null, endpoint = '/company/search'): QueryResult =>
    ({ id, segment: id.split(':')[0] as QueryResult['segment'], endpoint, description: '', body: {}, status: 200, totalCount, creditsUsed: 0, ranAt: '2026-10-11T00:00:00Z' });
  return {
    source: 'crustdata-api',
    baseUrl: 'https://api.crustdata.com',
    apiVersion: CRUSTDATA_API_VERSION,
    ranAt: '2026-10-11T00:00:00Z',
    creditsBefore: 100,
    creditsAfter: 96,
    creditsUsed: 4,
    results: [...BANDS.map((b, i) => r(`ai_market:${b.id}`, tam[i])), ...BANDS.map((b, i) => r(`agent_builders:${b.id}`, sam[i])), ...extra.map((e) => ({ ...r('x', null), ...e }))],
  };
}

test('derive: TAM/SAM/SOM and revenue follow agents × plan price × 12 × adoption', () => {
  const data = fixture([1000, 500, 200, 100, 20, 10], [100, 50, 20, 10, 2, 1], [{ id: 'hiring_any:90d', segment: 'hiring_any', endpoint: '/job/search', totalCount: 900, distinctCompanies: 1000, distinctCapped: true }]);
  const d = derive(data, DEFAULT_PLANS, DEFAULT_MARKET_ASSUMPTIONS);
  // ACVs: Starter $49×12=588/agent, Team $199×12=2388, Enterprise $799×12=9588
  const acv = [1 * 588, 2 * 588, 3 * 2388, 5 * 2388, 10 * 9588, 20 * 9588];
  assert.deepEqual(d.bands.map((b) => b.acvUsd), acv);
  assert.equal(d.tam.companies, 1830);
  assert.equal(d.sam.companies, 183);
  assert.equal(d.sam.agents, 100 + 100 + 60 + 50 + 20 + 20);
  const samArr = [100, 50, 20, 10, 2, 1].reduce((s, c, i) => s + c * acv[i], 0);
  assert.equal(d.sam.arrUsd, samArr);
  assert.ok(Math.abs(d.som.arrUsd - samArr * 0.01) < 1e-6);
  assert.ok(Math.abs(d.som.companies - 1.83) < 1e-9);
  assert.equal(d.years.length, 3);
  assert.ok(Math.abs(d.years[0].arrUsd - samArr * 0.001) < 1e-6);
  assert.equal(d.years[2].arrUsd, d.som.arrUsd);
  assert.deepEqual(d.hiring, [{ segment: 'hiring_any', jobs: 900, companies: 1000, capped: true }]);
  assert.deepEqual(d.missingBands, []);
});

test('derive: a band Crustdata gave no count for is flagged and left out, not guessed', () => {
  const d = derive(fixture([10, 10, 10, 10, 10, 10], [1, 1, 1, 1, 1, NaN].map((x) => (Number.isNaN(x) ? (null as unknown as number) : x))));
  assert.deepEqual(d.missingBands, ['5001+']);
  assert.equal(d.sam.companies, 5);
  assert.equal(d.bands.at(-1)!.samUsd, 0);
});

test('renderers label measured, assumed and derived numbers', () => {
  const data = fixture([1000, 500, 200, 100, 20, 10], [100, 50, 20, 10, 2, 1]);
  const d = derive(data);
  const md = renderSizingMd(data, d);
  const i = (s: string) => md.indexOf(s);
  assert.ok(i('## Measured (Crustdata') > 0 && i('## Assumptions') > i('## Measured') && i('## Derived') > i('## Assumptions'));
  assert.match(md, /2026-10-11/);
  const sec = marketSectionMd(d, data).join('\n');
  assert.match(sec, /## Market \(Crustdata\)/);
  assert.match(sec, /Revenue scenario/);
  assert.match(sec, /not measured/);
  const rows = marketCsvRows(d);
  assert.ok(rows.some((r) => r[0] === 'market_measured' && r[4] === 'measured'));
  assert.ok(rows.some((r) => r[0] === 'market_assumption' && r[4] === 'assumed'));
  assert.ok(rows.some((r) => r[1] === 'year_3_arr' && r[4] === 'derived'));
});

test('loadMarketData ignores missing files and files with no real counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bulwark-market-'));
  assert.equal(loadMarketData(join(dir, 'nope.json')), undefined);
  const empty = fixture([], []);
  empty.results = empty.results.map((r) => ({ ...r, totalCount: null }));
  writeFileSync(join(dir, 'empty.json'), JSON.stringify(empty));
  assert.equal(loadMarketData(join(dir, 'empty.json')), undefined);
  writeFileSync(join(dir, 'ok.json'), JSON.stringify(fixture([1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1])));
  assert.equal(loadMarketData(join(dir, 'ok.json'))!.results.length, 12);
});
