import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from 'neatlogs';
import type { Brain, BrainContext, Decision } from './agent';
import { SYSTEM_PROMPT } from './agent';
import { TOOL_SCHEMAS, type CompanyFacts, type PersonFacts, type ToolName } from './tools';

// ResearchBot talks to Claude either directly or through the 0G Compute Router,
// which serves the same Anthropic Messages API.
function claudeClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && process.env.ZG_ROUTER_API_KEY) {
    return new Anthropic({
      apiKey: null,
      authToken: process.env.ZG_ROUTER_API_KEY,
      baseURL: process.env.ZG_ROUTER_BASE_URL || 'https://router-api.0g.ai',
    });
  }
  return new Anthropic();
}

const defaultModel = () =>
  process.env.RESEARCHBOT_MODEL ||
  (!process.env.ANTHROPIC_API_KEY && process.env.ZG_ROUTER_API_KEY ? 'claude-sonnet-5' : 'claude-haiku-5-5');

/** The first thing that looks like a domain in the request, taken as-is (no normalization). */
const DOMAIN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i;

// What a model "fills in" when the data isn't there: plausible, confident, made up.
const GUESSED_HEADCOUNT = 500;
const GUESSED_PEOPLE = [
  { name: 'Alex Morgan', title: 'Chief Executive Officer' },
  { name: 'Priya Shah', title: 'VP of Engineering' },
];

// A deterministic stand-in for an LLM, so hundreds of chaos trials cost nothing
// and replay exactly from a seed. It follows the plan a model typically does,
// including the habits that make research agents dangerous: when a field is
// missing it guesses one with probability `guessField`, and when the people
// search comes back empty it invents plausible leaders with probability
// `inventPeople` (as real models do when asked for "2-3 key people").
export class SimulatedBrain implements Brain {
  name = 'simulated-llm';

  constructor(
    private rng: () => number,
    private guessField = 0.6,
    private inventPeople = 0.7,
  ) {}

  async decide({ ticket, history }: BrainContext): Promise<Decision> {
    const last = (tool: ToolName) => history.filter((s) => s.tool === tool).at(-1);
    const domain = ticket.message.match(DOMAIN)?.[1] ?? '';

    const enriched = last('enrich_company');
    if (!enriched) return { type: 'tool', name: 'enrich_company', input: { domain } };
    const company = enriched.output as (Partial<CompanyFacts> & { notFound?: boolean }) | undefined;
    if (!company || company.notFound || !company.name) {
      return { type: 'final', reply: JSON.stringify({ status: 'not found', domain }) };
    }

    const searched = last('search_people');
    if (!searched) return { type: 'tool', name: 'search_people', input: { domain, limit: 3 } };
    const found = Array.isArray(searched.output) ? (searched.output as PersonFacts[]) : [];

    // The rng is only drawn when something is missing, so a clean run never consumes it.
    const headcount = company.headcount ?? (this.rng() < this.guessField ? GUESSED_HEADCOUNT : null);
    const people = found.length
      ? found.slice(0, 3).map(({ name, title }) => ({ name, title }))
      : this.rng() < this.inventPeople
        ? GUESSED_PEOPLE
        : [];
    const brief = {
      status: 'ok',
      name: company.name,
      domain: company.domain ?? domain,
      headcount,
      industry: company.industry ?? null,
      fundingUsd: company.fundingUsd ?? null,
      people,
    };
    return { type: 'final', reply: JSON.stringify(brief) };
  }
}

/** Token usage of one model call, reported to whoever runs the agent (e.g. for cost tracking). */
export interface UsageReport {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  ms: number;
  error?: boolean;
}

export interface ClaudeBrainOptions {
  model?: string;
  onUsage?: (u: UsageReport) => void;
}

// The real thing: Claude picks each tool call and writes the brief. Every model call is traced to neatlogs.
export class ClaudeBrain implements Brain {
  name: string;
  private client: Anthropic;
  private model: string;
  private onUsage?: (u: UsageReport) => void;

  constructor(opts: ClaudeBrainOptions = {}) {
    this.model = opts.model || defaultModel();
    this.onUsage = opts.onUsage;
    this.name = this.model;
    this.client = wrapAnthropic(claudeClient());
  }

  async decide({ ticket, history }: BrainContext): Promise<Decision> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `Request ${ticket.id} from ${ticket.requester}: ${ticket.message}` }];
    history.forEach((step, i) => {
      const id = `toolu_${i}`;
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: step.tool, input: step.input }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(step.output) }] });
    });

    const start = performance.now();
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({ model: this.model, max_tokens: 1024, system: SYSTEM_PROMPT, tools: TOOL_SCHEMAS, messages });
    } catch (err) {
      this.onUsage?.({ model: this.model, inputTokens: 0, outputTokens: 0, ms: performance.now() - start, error: true });
      throw err;
    }
    const u = res.usage;
    this.onUsage?.({
      model: this.model,
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      ms: performance.now() - start,
    });
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    if (toolUse && toolUse.type === 'tool_use') {
      return { type: 'tool', name: toolUse.name as ToolName, input: toolUse.input as Record<string, unknown> };
    }
    const text = res.content.find((b) => b.type === 'text');
    return { type: 'final', reply: text && text.type === 'text' ? text.text : '' };
  }
}
