import type { Brain, RunResult, Ticket } from '../targets/refundbot/agent';
import type { Order, Transport } from '../targets/refundbot/payments';

// What Bulwark needs to know about an agent under test.
export interface BulwarkTarget {
  name: string;
  /** Business invariants in plain English, checked on every trial. */
  rules: string[];
  fixtures: () => { orders: Order[]; ticket: Ticket };
  run: (ticket: Ticket, deps: { transport: Transport; brain: Brain }) => Promise<RunResult>;
}
