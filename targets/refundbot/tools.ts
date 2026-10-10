// RefundBot's tool runtime: what the model can call, and how each call reaches
// the payments service. Written the way a team ships it on a deadline.

import { span } from 'neatlogs';
import type { Order, Refund, Transport } from './payments';

export type ToolName = 'lookup_order' | 'issue_refund' | 'send_email' | 'search_policy';

export const TOOL_SCHEMAS = [
  {
    name: 'lookup_order',
    description: 'Look up an order by id. Returns the order with its total and status.',
    input_schema: {
      type: 'object' as const,
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    },
  },
  {
    name: 'issue_refund',
    description: 'Refund an order through Dodo Payments.',
    input_schema: {
      type: 'object' as const,
      properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
      required: ['orderId', 'amount'],
    },
  },
  {
    name: 'send_email',
    description: 'Email the customer.',
    input_schema: {
      type: 'object' as const,
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'search_policy',
    description: 'Search the store refund policy.',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

const REFUND_TIMEOUT_MS = 1000;
const REFUND_ATTEMPTS = 3;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

// Payments are flaky, so refunds get retried.
async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;

export function createTools(transport: Transport): Tools {
  return {
    lookup_order: span({ kind: 'TOOL', name: 'lookup_order', toolName: 'lookup_order' }, async (input) => {
      const raw = await transport('orders.get', { orderId: input.orderId });
      return JSON.parse(raw) as Order;
    }),

    issue_refund: span({ kind: 'TOOL', name: 'issue_refund', toolName: 'issue_refund' }, async (input) => {
      const raw = await withRetry(
        () =>
          withTimeout(
            transport('refunds.create', { orderId: input.orderId, amount: input.amount }),
            REFUND_TIMEOUT_MS,
          ),
        REFUND_ATTEMPTS,
      );
      return JSON.parse(raw) as Refund;
    }),

    send_email: span({ kind: 'TOOL', name: 'send_email', toolName: 'send_email' }, async (input) => {
      const raw = await transport('email.send', input);
      return JSON.parse(raw);
    }),

    search_policy: span({ kind: 'TOOL', name: 'search_policy', toolName: 'search_policy' }, async (input) => {
      const raw = await transport('policy.search', { query: input.query });
      return (JSON.parse(raw) as { text: string }).text;
    }),
  };
}
