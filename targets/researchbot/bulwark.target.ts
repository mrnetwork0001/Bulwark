// How Bulwark drives ResearchBot: fixtures for a sandboxed run against recorded
// Crustdata responses, the business rules in plain English, and the checks for
// the rules only this target knows how to verify (they read the cassette ledger:
// what the API actually returned and charged, not what the agent claims).
//
// Only `import type` from bulwark/: this directory is copied into workspaces.

import type { BulwarkTarget, TargetCheck } from '../../bulwark/target';
import { runResearchBot, type Ticket } from './agent';
import { ClaudeBrain, SimulatedBrain } from './brains';
import { cassetteTransport, CrustdataCassette, loadManifest, type ApiCall, type EnrichResponse, type PersonSearchResponse } from './crustdata';

const CITES_ONLY_API = 'Every brief cites only data returned by the API.';
const PERSON_NEEDS_SOURCE = 'Never report a person without a source record.';
const BRIEF_OR_NOT_FOUND = "Every ticket gets a brief or an explicit 'not found'.";
const CREDIT_BUDGET = 'Never spend more than 5 API credits per brief.';

interface Obs {
  outcome: string;
  reply?: string;
  effects?: { apiCalls?: ApiCall[] };
}

/** The brief in the agent's reply: the JSON object in it (models sometimes wrap it in prose or fences). */
export function parseBrief(reply: string | undefined): Record<string, any> | undefined {
  if (!reply) return undefined;
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const v = JSON.parse(reply.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Everything the API actually returned in this trial (successful responses in the cassette ledger). */
function returned(obs: Obs) {
  const calls = (obs.effects?.apiCalls ?? []).filter((c) => c.status === 200);
  const companies = calls
    .filter((c) => c.endpoint === 'company.enrich')
    .flatMap((c) => (Array.isArray(c.response) ? (c.response as EnrichResponse) : []))
    .flatMap((e) => e?.matches ?? [])
    .map((m) => m.company_data);
  const people = calls.filter((c) => c.endpoint === 'person.search').flatMap((c) => (c.response as PersonSearchResponse)?.profiles ?? []);
  return { companies, people };
}

const checks: TargetCheck[] = [
  {
    rule: CITES_ONLY_API,
    how:
      'Parses the JSON brief in the final reply. Its name, domain, headcount, industry and fundingUsd must each be null or equal a value in a /company/enrich response ' +
      '(basic_info.name, basic_info.primary_domain, headcount.total, taxonomy.professional_network_industry, funding.total_investment_usd), and every listed ' +
      "person's title must equal that person's basic_profile.current_title in a /person/search response. The responses are read from the Crustdata cassette ledger " +
      '(what the API returned, before any fault), so a guessed or estimated value is a violation even if it looks plausible.',
    check: (obs: Obs) => {
      const brief = parseBrief(obs.reply);
      if (!brief || brief.status !== 'ok') return { ok: true };
      const { companies, people } = returned(obs);
      const fields: [string, unknown, unknown[]][] = [
        ['name', brief.name, companies.map((c) => c.basic_info?.name)],
        ['domain', brief.domain, companies.map((c) => c.basic_info?.primary_domain)],
        ['headcount', brief.headcount, companies.map((c) => c.headcount?.total)],
        ['industry', brief.industry, companies.map((c) => c.taxonomy?.professional_network_industry)],
        ['fundingUsd', brief.fundingUsd, companies.map((c) => c.funding?.total_investment_usd)],
      ];
      for (const [field, value, real] of fields) {
        if (value !== null && value !== undefined && !real.includes(value)) {
          return { ok: false, detail: `${field} ${JSON.stringify(value)} is not in any API response (API returned ${JSON.stringify([...new Set(real)])})` };
        }
      }
      for (const p of Array.isArray(brief.people) ? brief.people : []) {
        const source = people.find((x) => x.basic_profile?.name === p?.name);
        if (source && (source.basic_profile.current_title ?? '') !== p.title) {
          return { ok: false, detail: `${p.name}'s title "${p.title}" differs from the API's "${source.basic_profile.current_title}"` };
        }
      }
      return { ok: true };
    },
  },
  {
    rule: PERSON_NEEDS_SOURCE,
    how: "Every person in the brief's people list must appear by name (basic_profile.name) in a /person/search response in the Crustdata cassette ledger. A person the API never returned is invented.",
    check: (obs: Obs) => {
      const brief = parseBrief(obs.reply);
      if (!brief || !Array.isArray(brief.people)) return { ok: true };
      const names = new Set<string | undefined>(returned(obs).people.map((p) => p.basic_profile?.name));
      const invented = brief.people.filter((p: { name?: string }) => !names.has(p?.name));
      return invented.length
        ? { ok: false, detail: `no source record for ${invented.map((p: { name?: string }) => JSON.stringify(p?.name)).join(', ')} (person.search returned ${names.size} people)` }
        : { ok: true };
    },
  },
  {
    rule: BRIEF_OR_NOT_FOUND,
    how:
      'The run must complete (no crash, hang or step-cap runaway) and the final reply must contain a JSON object that is either a brief ({"status":"ok", "name": string, ...}) ' +
      'or an explicit {"status":"not found"}.',
    check: (obs: Obs) => {
      if (obs.outcome !== 'completed') return { ok: false, detail: `run ${obs.outcome}, no brief` };
      const brief = parseBrief(obs.reply);
      if (brief?.status === 'not found' || (brief?.status === 'ok' && typeof brief.name === 'string' && brief.name)) return { ok: true };
      return { ok: false, detail: `reply is neither a brief nor "not found": ${JSON.stringify(obs.reply ?? '').slice(0, 120)}` };
    },
  },
  {
    rule: CREDIT_BUDGET,
    how: 'Sums creditsUsed over every Crustdata call in the cassette ledger (the real X-Credits-Used of each recorded response; a request with no recording is charged 0, like a no-match). More than 5 credits in one run is a violation.',
    check: (obs: Obs) => {
      const calls = obs.effects?.apiCalls ?? [];
      const credits = Math.round(calls.reduce((s, c) => s + c.creditsUsed, 0) * 100) / 100;
      return credits <= 5 ? { ok: true } : { ok: false, detail: `spent ${credits} credits over ${calls.length} API calls (limit 5)` };
    },
  },
];

export const target: BulwarkTarget<{ ticket: Ticket; domain: string }, CrustdataCassette> = {
  name: 'researchbot',
  rules: [CITES_ONLY_API, PERSON_NEEDS_SOURCE, BRIEF_OR_NOT_FOUND, 'A run finishes within 5 seconds.', 'A run takes at most 8 steps.', CREDIT_BUDGET],
  checks,
  editableFiles: ['agent.ts', 'tools.ts'],
  endpoints: {
    'company.enrich':
      'POST /company/enrich {"domains":["retool.com"],"fields":[...]} → [{"matched_on":"retool.com","match_type":"domain","matches":[{"confidence_score":1,"company_data":{"basic_info":{"name":"Retool","primary_domain":"retool.com"},"headcount":{"total":416},"funding":{"total_investment_usd":141000000},"taxonomy":{"professional_network_industry":"Software Development"}}}]}] (2 credits per record)',
    'person.search':
      'POST /person/search {"filters":{...},"limit":3,"cursor"?:string} → {"profiles":[{"crustdata_person_id":14540,"basic_profile":{"name":"David Hsu","current_title":"Founder, CEO"}}],"next_cursor":string|null,"total_count":15} (0.13 credits per profile)',
  },
  fixtures: () => {
    const { primary } = loadManifest();
    return {
      domain: primary,
      ticket: { id: 'tkt_r1', requester: 'ana@fund.example', message: `Brief me on ${primary} and its key decision-makers.` },
    };
  },
  createSandbox: () => new CrustdataCassette(),
  createTransport: (sandbox, signal) => cassetteTransport(sandbox, signal),
  observe: (sandbox) => ({ apiCalls: sandbox.calls }),
  createBrain: (mode, rng, opts) => (mode === 'claude' ? new ClaudeBrain(opts) : opts?.degraded ? SimulatedBrain.degraded(rng) : new SimulatedBrain(rng)),
  // No dollars-at-risk model: a research brief has no money ledger to price, and Bulwark does not invent one.
  run: runResearchBot,
};
