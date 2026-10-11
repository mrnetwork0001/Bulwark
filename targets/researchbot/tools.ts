// ResearchBot's tool runtime: what the model can call, and how each call reaches
// Crustdata. Written the way a team ships it on a deadline.

import { span } from 'neatlogs';
import type { EnrichResponse, PersonSearchResponse, Transport } from './crustdata';

export type ToolName = 'enrich_company' | 'search_people';

export const TOOL_SCHEMAS = [
  {
    name: 'enrich_company',
    description: 'Look up a company by its website domain (Crustdata company enrich). Returns name, domain, headcount, industry and total funding.',
    input_schema: {
      type: 'object' as const,
      properties: { domain: { type: 'string', description: 'bare website domain, e.g. retool.com' } },
      required: ['domain'],
    },
  },
  {
    name: 'search_people',
    description: "Find a company's key decision-makers (CXOs and VPs) by its website domain (Crustdata person search). Returns name and title for each.",
    input_schema: {
      type: 'object' as const,
      properties: { domain: { type: 'string' }, limit: { type: 'number', description: 'people per page, default 3' } },
      required: ['domain'],
    },
  },
];

export interface CompanyFacts {
  name: string;
  domain: string;
  headcount: number | null;
  industry: string | null;
  fundingUsd: number | null;
}

export interface PersonFacts {
  id: number;
  name: string;
  title: string;
}

/** Company enrich sections the brief needs (2 credits per record whatever the sections, per Crustdata pricing). */
export const COMPANY_FIELDS = ['basic_info', 'headcount', 'funding', 'taxonomy'];
export const LEADER_SENIORITY = ['CXO', 'Vice President'];

export function enrichRequest(domain: string): Record<string, unknown> {
  return { domains: [domain], fields: COMPANY_FIELDS };
}

/** Current CXOs and VPs at the company, by website domain. Only name and title come back (base price + one experience filter). */
export function peopleQuery(domain: string, limit: number): Record<string, unknown> {
  return {
    filters: {
      op: 'and',
      conditions: [
        { field: 'experience.employment_details.current.company_website_domain', type: '=', value: domain },
        { field: 'experience.employment_details.current.seniority_level', type: 'in', value: LEADER_SENIORITY },
      ],
    },
    fields: ['basic_profile.name', 'basic_profile.current_title'],
    sorts: [{ field: 'crustdata_person_id', order: 'asc' }],
    limit,
  };
}

export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;

export function createTools(transport: Transport): Tools {
  return {
    enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
      const raw = await transport('company.enrich', enrichRequest(String(input.domain)));
      const company = (JSON.parse(raw) as EnrichResponse)[0].matches[0].company_data;
      return {
        name: company.basic_info!.name,
        domain: company.basic_info!.primary_domain,
        headcount: company.headcount!.total,
        industry: company.taxonomy!.professional_network_industry,
        fundingUsd: company.funding!.total_investment_usd,
      };
    }),

    search_people: span({ kind: 'TOOL', name: 'search_people', toolName: 'search_people' }, async (input) => {
      const people: PersonFacts[] = [];
      let cursor: string | null = null;
      // Collect every page of leaders.
      do {
        const raw = await transport('person.search', { ...peopleQuery(String(input.domain), Number(input.limit ?? 3)), ...(cursor ? { cursor } : {}) });
        const page = JSON.parse(raw) as PersonSearchResponse;
        for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
        cursor = page.next_cursor;
      } while (cursor);
      return people;
    }),
  };
}
