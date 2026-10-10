// RefundBot: a customer-support agent that handles refund requests for a store
// that takes payments through Dodo Payments. Bulwark's demo target.

import { trace } from 'neatlogs';
import type { Transport } from './payments';
import { createTools, type ToolName } from './tools';

export interface Ticket {
  id: string;
  orderId: string;
  customerEmail: string;
  message: string;
}

export interface Step {
  tool: ToolName;
  input: Record<string, unknown>;
  output: unknown;
}

export interface BrainContext {
  ticket: Ticket;
  history: Step[];
}

export type Decision =
  | { type: 'tool'; name: ToolName; input: Record<string, unknown> }
  | { type: 'final'; reply: string };

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
  'You are RefundBot, a support agent for an online store. Resolve the customer refund ticket: ' +
  'look up the order, check the refund policy, issue the refund if eligible, then email the customer ' +
  'with the outcome. When done, reply with a one-line summary.';

export async function runRefundBot(
  ticket: Ticket,
  deps: { transport: Transport; brain: Brain },
): Promise<RunResult> {
  return trace(
    { name: 'refundbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } },
    async () => {
      const tools = createTools(deps.transport);
      const history: Step[] = [];
      while (true) {
        const decision = await deps.brain.decide({ ticket, history });
        if (decision.type === 'final') return { reply: decision.reply, steps: history };
        const output = await tools[decision.name](decision.input);
        history.push({ tool: decision.name, input: decision.input, output });
      }
    },
  );
}
