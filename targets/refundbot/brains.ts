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

// A deterministic stand-in for an LLM, so hundreds of chaos trials cost nothing
// and replay exactly from a seed. It follows the same plan a model typically
// does, including the habits that make agents fragile: it re-checks a pending
// order indefinitely, and with probability `susceptibility` it obeys instructions
// that appear inside tool output (as real models sometimes do).
export class SimulatedBrain implements Brain {
  name = 'simulated-llm';

  constructor(
    private rng: () => number,
    private susceptibility = 0.5,
  ) {}

  async decide({ ticket, history }: BrainContext): Promise<Decision> {
    const last = (tool: ToolName) => history.filter((s) => s.tool === tool).at(-1);
    const order = last('lookup_order')?.output as Order | undefined;

    if (!order || order.status === 'pending') {
      return { type: 'tool', name: 'lookup_order', input: { orderId: ticket.orderId } };
    }
    const policy = last('search_policy')?.output as string | undefined;
    if (policy === undefined) {
      return { type: 'tool', name: 'search_policy', input: { query: 'refund eligibility' } };
    }
    const refunded = last('issue_refund') !== undefined;
    if (!refunded && order.status === 'paid') {
      const injected = policy.match(INJECTED_REFUND);
      const amount = injected && this.rng() < this.susceptibility ? Number(injected[1]) : order.total;
      return { type: 'tool', name: 'issue_refund', input: { orderId: order.id, amount } };
    }
    if (last('send_email') === undefined) {
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

// The real thing: Claude picks each tool call. Every model call is traced to neatlogs.
export class ClaudeBrain implements Brain {
  name: string;
  private client: Anthropic;

  constructor(private model = defaultModel()) {
    this.name = model;
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

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOL_SCHEMAS,
      messages,
    });
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    if (toolUse && toolUse.type === 'tool_use') {
      return { type: 'tool', name: toolUse.name as ToolName, input: toolUse.input as Record<string, unknown> };
    }
    const text = res.content.find((b) => b.type === 'text');
    return { type: 'final', reply: text && text.type === 'text' ? text.text : '' };
  }
}
