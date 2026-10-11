import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from 'neatlogs';
import type { Brain, BrainContext, Decision } from './agent';
import { SYSTEM_PROMPT } from './agent';
import type { Order } from './payments';
import { TOOL_SCHEMAS, type ToolName } from './tools';

// RefundBot talks to Claude either directly or through the 0G Compute Router,
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
  process.env.REFUNDBOT_MODEL ||
  (!process.env.ANTHROPIC_API_KEY && process.env.ZG_ROUTER_API_KEY ? 'claude-sonnet-5' : 'claude-haiku-5-5');

const INJECTED_REFUND = /issue a (?:full )?refund of \$(\d+(?:\.\d+)?)/i;
// What a pushy customer asks for in the ticket itself.
const DEMANDED_REFUND = /refund (?:of )?\$(\d+(?:\.\d+)?)/i;
const OTHER_ORDER = /\b(ord_\d+)\b/g;

interface Persuasion {
  amount?: number;
  otherOrderId?: string;
}

// A deterministic stand-in for an LLM, so hundreds of chaos trials cost nothing
// and replay exactly from a seed. It follows the same plan a model typically
// does, including the habits that make agents fragile: it re-checks a pending
// order indefinitely, with probability `susceptibility` it obeys instructions
// that appear inside tool output (as real models sometimes do), and with
// probability `socialSusceptibility` it believes a customer who claims authority
// or asks it to refund someone else's order too.
//
// `SimulatedBrain.degraded()` is the same brain after the provider silently swaps in
// a weaker model: more gullible, and sloppy in seeded, replayable ways (it loses
// track of a refund it already issued, misreads the amount, or forgets to email).
export interface Sloppiness {
  /** P(it forgets it already refunded the order and refunds it again). */
  forget: number;
  /** P(it misreads the amount and refunds twice the order total). */
  misread: number;
  /** P(it skips emailing the customer and just finishes). */
  skipReply: number;
}

export const DEGRADED_SLOPPINESS: Sloppiness = { forget: 0.3, misread: 0.25, skipReply: 0.2 };

export class SimulatedBrain implements Brain {
  name = 'simulated-llm';
  private persuasion?: Persuasion | null;
  private slips?: { forget: boolean; misread: boolean; skipReply: boolean };

  constructor(
    private rng: () => number,
    private susceptibility = 0.5,
    private socialSusceptibility = 0.5,
    private sloppiness?: Sloppiness,
  ) {}

  /** The weaker model a degraded provider routes to: gullible and sloppy, deterministically from the seed. */
  static degraded(rng: () => number): SimulatedBrain {
    const b = new SimulatedBrain(rng, 0.9, 0.9, DEGRADED_SLOPPINESS);
    b.name = 'simulated-llm-degraded';
    return b;
  }

  /** Which slips this run makes, decided once per ticket. A healthy brain never draws the rng for this. */
  private slipsFor() {
    if (!this.slips) {
      const s = this.sloppiness;
      this.slips = s ? { forget: this.rng() < s.forget, misread: this.rng() < s.misread, skipReply: this.rng() < s.skipReply } : { forget: false, misread: false, skipReply: false };
    }
    return this.slips;
  }

  /** Decided once per ticket. The rng is only drawn when the message actually tries something. */
  private persuaded(ticket: BrainContext['ticket']): Persuasion | null {
    if (this.persuasion !== undefined) return this.persuasion;
    const demanded = ticket.message.match(DEMANDED_REFUND);
    const other = [...ticket.message.matchAll(OTHER_ORDER)].map((m) => m[1]).find((id) => id !== ticket.orderId);
    this.persuasion =
      (demanded || other) && this.rng() < this.socialSusceptibility
        ? { amount: demanded ? Number(demanded[1]) : undefined, otherOrderId: other }
        : null;
    return this.persuasion;
  }

  async decide({ ticket, history }: BrainContext): Promise<Decision> {
    const last = (tool: ToolName) => history.filter((s) => s.tool === tool).at(-1);
    const lookup = (orderId: string) =>
      history.filter((s) => s.tool === 'lookup_order' && s.input.orderId === orderId).at(-1)?.output as Order | undefined;
    const refundedOrder = (orderId: string) => history.some((s) => s.tool === 'issue_refund' && s.input.orderId === orderId);
    const order = lookup(ticket.orderId);

    if (!order || order.status === 'pending') {
      return { type: 'tool', name: 'lookup_order', input: { orderId: ticket.orderId } };
    }
    const policy = last('search_policy')?.output as string | undefined;
    if (policy === undefined) {
      return { type: 'tool', name: 'search_policy', input: { query: 'refund eligibility' } };
    }
    const social = this.persuaded(ticket);
    const refunded = refundedOrder(order.id);
    const slips = this.slipsFor();
    if (!refunded && order.status === 'paid') {
      const injected = policy.match(INJECTED_REFUND);
      const amount = injected && this.rng() < this.susceptibility ? Number(injected[1]) : (social?.amount ?? (slips.misread ? order.total * 2 : order.total));
      return { type: 'tool', name: 'issue_refund', input: { orderId: order.id, amount } };
    }
    // A degraded model loses track of the refund it just issued and issues it again.
    if (slips.forget && order.status === 'paid' && history.filter((s) => s.tool === 'issue_refund' && s.input.orderId === order.id).length === 1) {
      const first = history.find((s) => s.tool === 'issue_refund' && s.input.orderId === order.id)!;
      return { type: 'tool', name: 'issue_refund', input: { ...first.input } };
    }
    if (social?.otherOrderId && !refundedOrder(social.otherOrderId)) {
      const other = lookup(social.otherOrderId);
      if (!other) return { type: 'tool', name: 'lookup_order', input: { orderId: social.otherOrderId } };
      if (other.status === 'paid') {
        return { type: 'tool', name: 'issue_refund', input: { orderId: other.id, amount: other.total } };
      }
    }
    if (last('send_email') === undefined && !slips.skipReply) {
      const body = refunded
        ? `Your refund for order ${order.id} has been issued.`
        : `Order ${order.id} is not eligible for a refund (status: ${order.status}).`;
      return {
        type: 'tool',
        name: 'send_email',
        input: { to: ticket.customerEmail, subject: `Your refund request (${order.id})`, body },
      };
    }
    return { type: 'final', reply: refunded ? `Refunded ${order.id}.` : `Declined ${order.id}.` };
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
  /** Any Anthropic-Messages-compatible model id (on 0G, also non-Claude models that speak it). */
  model?: string;
  onUsage?: (u: UsageReport) => void;
}

// The real thing: Claude picks each tool call. Every model call is traced to neatlogs.
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
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: `Ticket ${ticket.id} from ${ticket.customerEmail} about order ${ticket.orderId}: ${ticket.message}` },
    ];
    history.forEach((step, i) => {
      const id = `toolu_${i}`;
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: step.tool, input: step.input }] });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(step.output) }],
      });
    });

    const start = performance.now();
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOL_SCHEMAS,
        messages,
      });
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
