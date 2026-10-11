// npm run record:crustdata -- --record [--domains retool.com,stripe.com] [--primary retool.com] [--max-credits 40]
//
// Record mode: makes REAL Crustdata calls (exactly the requests ResearchBot
// sends) for a few well-known companies and saves the real responses as
// cassettes in targets/researchbot/cassettes/. Every trial afterwards replays
// them for free. Needs CRUSTDATA_API_KEY and the explicit --record flag.
// Cost: one company enrich (2 credits) + one person search (about 0.13 credits
// per returned profile) per company. Credits are read before and after from the
// free /account/credits endpoint and written to the manifest.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { API_VERSION, creditBalance, ENDPOINT_PATHS, liveCall, type Cassette, type Endpoint, type EnrichResponse, type Interaction, type Manifest, type PersonSearchResponse } from './crustdata';
import { enrichRequest, peopleQuery } from './tools';

const DIR = new URL('./cassettes/', import.meta.url);

function loadEnv(): void {
  // The target stays decoupled from Bulwark, so it reads .env itself.
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

/** What the brief needs from a recording; anything missing makes the company a poor demo (the baseline must pass). */
function problems(enrich: unknown, people: unknown): string[] {
  const out: string[] = [];
  const data = (enrich as EnrichResponse)?.[0]?.matches?.[0]?.company_data;
  if (!data) return ['no company match'];
  if (typeof data.basic_info?.name !== 'string') out.push('basic_info.name');
  if (typeof data.headcount?.total !== 'number') out.push('headcount.total');
  if (typeof data.funding?.total_investment_usd !== 'number') out.push('funding.total_investment_usd');
  if (typeof data.taxonomy?.professional_network_industry !== 'string') out.push('taxonomy.professional_network_industry');
  const profiles = (people as PersonSearchResponse)?.profiles ?? [];
  if (profiles.length < 2) out.push(`only ${profiles.length} leaders found`);
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      record: { type: 'boolean', default: false },
      domains: { type: 'string', default: 'retool.com,stripe.com,figma.com,notion.so' },
      primary: { type: 'string' },
      'max-credits': { type: 'string', default: '40' },
      limit: { type: 'string', default: '3' },
      force: { type: 'boolean', default: false },
    },
  });
  loadEnv();
  const key = process.env.CRUSTDATA_API_KEY;
  if (!values.record || !key) {
    console.error('Record mode makes real (paid) Crustdata calls. It needs CRUSTDATA_API_KEY and --record.');
    process.exit(1);
  }
  const domains = values.domains!.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const maxCredits = Number(values['max-credits']);
  const before = await creditBalance(key);
  console.log(`Crustdata balance before: ${before} credits. Recording ${domains.length} companies (cap ${maxCredits} credits).`);

  // Real cassettes already on disk are kept (and not paid for again) unless --force.
  mkdirSync(DIR, { recursive: true });
  const existing = readdirSync(DIR)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as Cassette)
    .filter((c) => !c.synthetic && !(values.force && domains.includes(c.domain)));
  const recorded: Cassette[] = [];
  let spent = 0;
  for (const domain of domains) {
    if (existing.some((c) => c.domain === domain)) {
      console.log(`  ${domain}: already recorded, kept (pass --force to re-record)`);
      continue;
    }
    if (spent + 2.5 > maxCredits) {
      console.log(`  stop: next company could exceed the ${maxCredits}-credit cap`);
      break;
    }
    const interactions: Interaction[] = [];
    const call = async (endpoint: Endpoint, request: Record<string, unknown>) => {
      const r = await liveCall(key, endpoint, request);
      spent += r.creditsUsed;
      interactions.push({ endpoint, path: ENDPOINT_PATHS[endpoint], request, status: r.status, creditsUsed: r.creditsUsed, response: r.body, ms: r.ms });
      console.log(`  ${domain} ${ENDPOINT_PATHS[endpoint]} → HTTP ${r.status}, ${r.creditsUsed} credits, ${r.ms}ms ${JSON.stringify(r.headers)}`);
      return r;
    };
    const enrich = await call('company.enrich', enrichRequest(domain));
    const people = enrich.status === 200 ? await call('person.search', peopleQuery(domain, Number(values.limit))) : undefined;
    const issues = problems(enrich.body, people?.body);
    if (issues.length) console.log(`  ⚠ ${domain}: missing ${issues.join(', ')}`);
    recorded.push({
      synthetic: false,
      domain,
      apiVersion: API_VERSION,
      recordedAt: new Date().toISOString(),
      note: `Real Crustdata responses, recorded by targets/researchbot/record.ts.${issues.length ? ` Missing for the brief: ${issues.join(', ')}.` : ''}`,
      interactions,
    });
  }

  const after = await creditBalance(key);
  // Synthetic cassettes go once real ones exist; real ones are written next to those already kept.
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.json') || f === 'manifest.json') continue;
    const c = JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as Cassette;
    if (c.synthetic || recorded.some((r) => r.domain === c.domain)) rmSync(new URL(f, DIR));
  }
  for (const c of recorded) writeFileSync(new URL(`${c.domain}.json`, DIR), JSON.stringify(c, null, 2) + '\n');
  const all = [...existing, ...recorded];
  const good = all.filter((c) => !/Missing for the brief/.test(c.note ?? ''));
  const previous = existsSync(new URL('manifest.json', DIR)) ? (JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as Manifest) : undefined;
  const thisRun = Math.round(spent * 100) / 100;
  const manifest: Manifest = {
    synthetic: false,
    primary: values.primary ?? (previous && !previous.synthetic && good.some((c) => c.domain === previous.primary) ? previous.primary : good[0]?.domain ?? all[0]?.domain),
    domains: all.map((c) => c.domain).sort(),
    recordedAt: new Date().toISOString(),
    creditsSpent: Math.round(((previous && !previous.synthetic ? previous.creditsSpent ?? 0 : 0) + thisRun) * 100) / 100,
  };
  writeFileSync(new URL('manifest.json', DIR), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nCredits this run: ${thisRun} (sum of X-Credits-Used); balance ${before} → ${after}. All cassettes so far: ${manifest.creditsSpent} credits.`);
  console.log(`Wrote ${recorded.length} cassettes (${all.length} total); the demo ticket asks about ${manifest.primary}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
