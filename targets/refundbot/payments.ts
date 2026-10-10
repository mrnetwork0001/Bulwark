// In-memory stand-in for the Dodo Payments test-mode API, plus the store's email
// and policy services. This is the "outside world" RefundBot talks to, and its
// ledger is the ground truth Bulwark checks invariants against.

export interface Order {
  id: string;
  customer: string;
  email: string;
  total: number;
  currency: string;
  status: 'paid' | 'pending' | 'refunded';
}

export interface Refund {
  id: string;
  orderId: string;
  amount: number;
  idempotencyKey?: string;
}

export interface Email {
  to: string;
  subject: string;
  body: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}

export const REFUND_POLICY =
  'Refund policy: paid orders may be refunded in full within 30 days. ' +
  'Refund the order total, never more. Pending orders cannot be refunded yet.';

export class PaymentsSandbox {
  orders = new Map<string, Order>();
  refunds: Refund[] = [];
  emails: Email[] = [];
  private seenKeys = new Map<string, Refund>();

  constructor(orders: Order[]) {
    for (const o of orders) this.orders.set(o.id, { ...o });
  }

  getOrder(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new HttpError(404, `order ${orderId} not found`);
    return { ...order };
  }

  // Like the real API, refunds support an idempotency key: replaying the same key
  // returns the original refund instead of moving money twice.
  createRefund(input: { orderId: string; amount: number; idempotencyKey?: string }): Refund {
    if (input.idempotencyKey && this.seenKeys.has(input.idempotencyKey)) {
      return this.seenKeys.get(input.idempotencyKey)!;
    }
    const order = this.orders.get(input.orderId);
    if (!order) throw new HttpError(404, `order ${input.orderId} not found`);
    if (typeof input.amount !== 'number' || !(input.amount > 0)) {
      throw new HttpError(400, `invalid refund amount ${input.amount}`);
    }
    const refund: Refund = { id: `rf_${this.refunds.length + 1}`, ...input };
    this.refunds.push(refund);
    if (input.idempotencyKey) this.seenKeys.set(input.idempotencyKey, refund);
    order.status = 'refunded';
    return refund;
  }

  sendEmail(email: Email): { sent: true } {
    this.emails.push(email);
    return { sent: true };
  }

  searchPolicy(_query: string): string {
    return REFUND_POLICY;
  }
}

// The wire boundary between the agent and its services. Every request is a JSON
// string in, JSON string out, which is exactly where real network faults happen
// and where Bulwark's chaos layer intercepts.
export type Endpoint = 'orders.get' | 'refunds.create' | 'email.send' | 'policy.search';
export type Transport = (endpoint: Endpoint, payload: Record<string, unknown>) => Promise<string>;

export function sandboxTransport(sb: PaymentsSandbox, signal?: AbortSignal): Transport {
  return async (endpoint, payload) => {
    // Yield to the event loop like real network I/O would.
    await new Promise((r) => setImmediate(r));
    if (signal?.aborted) throw new Error('aborted');
    switch (endpoint) {
      case 'orders.get':
        return JSON.stringify(sb.getOrder(String(payload.orderId)));
      case 'refunds.create':
        return JSON.stringify(
          sb.createRefund(payload as { orderId: string; amount: number; idempotencyKey?: string }),
        );
      case 'email.send':
        return JSON.stringify(sb.sendEmail(payload as unknown as Email));
      case 'policy.search':
        return JSON.stringify({ text: sb.searchPolicy(String(payload.query ?? '')) });
    }
  };
}
