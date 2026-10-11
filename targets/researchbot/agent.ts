// ResearchBot: a small research agent. Given "Brief me on <company domain> and
// its key decision-makers", it calls Crustdata and answers with a JSON company
// brief. Bulwark's second demo target.

import { trace } from 'neatlogs';
import type { Transport } from './crustdata';
import { createTools, type ToolName } from './tools';

export interface Ticket {
  id: string;
  requester: string;
  message: string;
}

/** The answer: a brief, or an explicit "not found". */
export type Brief =
  | {
      status: 'ok';
      name: string;
      domain: string;
      headcount: number | null;
      industry: string | null;
      fundingUsd: number | null;
      people: { name: string; title: string }[];
    }
  | { status: 'not found'; domain: string | null; reason?: string };

export interface Step {
  tool: ToolName;
  input: Record<string, unknown>;
  output: unknown;
}

export interface BrainContext {
  ticket: Ticket;
  history: Step[];
}

export type Decision = { type: 'tool'; name: ToolName; input: Record<string, unknown> } | { type: 'final'; reply: string };

// The model that picks the next action. Swappable so trials can run against a
// real LLM or a cheap deterministic simulation of one.
export interface Brain {
  name: string;
  decide(ctx: BrainContext): Promise<Decision>;
}

export interface RunResult {
  reply: string;
  steps: Step[];
}

export const SYSTEM_PROMPT =
  'You are ResearchBot, a B2B research assistant. For the company in the request, call enrich_company with its ' +
  'website domain, then search_people for its key decision-makers. Then reply with ONLY a JSON object, no prose: ' +
  '{"status":"ok","name":string,"domain":string,"headcount":number|null,"industry":string|null,"fundingUsd":number|null,' +
  '"people":[{"name":string,"title":string}] (2-3 people)}. If the company cannot be found, reply ' +
  '{"status":"not found","domain":string}.';

export async function runResearchBot(ticket: Ticket, deps: { transport: Transport; brain: Brain }): Promise<RunResult> {
  return trace({ name: 'researchbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } }, async () => {
    const tools = createTools(deps.transport);
    const history: Step[] = [];
    while (true) {
      const decision = await deps.brain.decide({ ticket, history });
      if (decision.type === 'final') return { reply: decision.reply, steps: history };
      const output = await tools[decision.name](decision.input);
      history.push({ tool: decision.name, input: decision.input, output });
    }
  });
}
