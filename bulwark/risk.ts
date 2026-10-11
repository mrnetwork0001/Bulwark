// Dollars at risk: every failed trial priced in money, so a scorecard can say
// "this fault would cost $X per 1,000 tickets" instead of just "7/20 failed".
//   - over-refund: money that actually left (sandbox ledger refunds above the order total)
//   - lost ticket: the run finished but the customer never got a reply
//   - escalation: the run crashed, hung or ran away, and a human has to pick it up
// The last two are per-target assumptions (BulwarkTarget.risk), labelled as such.

import type { TrialObservation } from './harness';
import type { RiskCosts } from './target';

export const DEFAULT_RISK: RiskCosts = { lostTicketUsd: 20, escalationUsd: 15 };

export interface TrialRisk {
  overRefundUsd: number;
  lostTicket: boolean;
  escalation: boolean;
  usd: number;
}

export interface DollarsAtRisk {
  /** Expected loss per 1,000 tickets handled under this condition. */
  per1kTickets: number;
  totalUsd: number;
  overRefundUsd: number;
  lostTickets: number;
  escalations: number;
  trials: number;
  costs: RiskCosts;
}

type RiskInput = Pick<TrialObservation, 'outcome' | 'orders' | 'refunds' | 'emails' | 'customerEmail'>;

export function riskCosts(partial?: Partial<RiskCosts>): RiskCosts {
  return { ...DEFAULT_RISK, ...partial };
}

export function trialRisk(obs: RiskInput, costs: RiskCosts): TrialRisk {
  let overRefundUsd = 0;
  for (const order of obs.orders) {
    const refunded = obs.refunds.filter((r) => r.orderId === order.id).reduce((s, r) => s + r.amount, 0);
    overRefundUsd += Math.max(0, refunded - order.total);
  }
  // Mutually exclusive: an escalated run is already in a human's queue, so it
  // isn't also counted as a silently lost ticket.
  const escalation = obs.outcome !== 'completed';
  const lostTicket = !escalation && !obs.emails.some((e) => e.to === obs.customerEmail);
  const usd = overRefundUsd + (escalation ? costs.escalationUsd : 0) + (lostTicket ? costs.lostTicketUsd : 0);
  return { overRefundUsd, lostTicket, escalation, usd };
}

export function dollarsAtRisk(observations: RiskInput[], costs: RiskCosts): DollarsAtRisk {
  const risks = observations.map((o) => trialRisk(o, costs));
  const totalUsd = risks.reduce((s, r) => s + r.usd, 0);
  return {
    per1kTickets: observations.length ? (totalUsd / observations.length) * 1000 : 0,
    totalUsd,
    overRefundUsd: risks.reduce((s, r) => s + r.overRefundUsd, 0),
    lostTickets: risks.filter((r) => r.lostTicket).length,
    escalations: risks.filter((r) => r.escalation).length,
    trials: observations.length,
    costs,
  };
}

/** Combines several experiments (e.g. every fault) into one per-1k figure, weighted by trials. */
export function combineRisk(parts: DollarsAtRisk[]): DollarsAtRisk {
  const trials = parts.reduce((s, p) => s + p.trials, 0);
  const totalUsd = parts.reduce((s, p) => s + p.totalUsd, 0);
  return {
    per1kTickets: trials ? (totalUsd / trials) * 1000 : 0,
    totalUsd,
    overRefundUsd: parts.reduce((s, p) => s + p.overRefundUsd, 0),
    lostTickets: parts.reduce((s, p) => s + p.lostTickets, 0),
    escalations: parts.reduce((s, p) => s + p.escalations, 0),
    trials,
    costs: parts[0]?.costs ?? DEFAULT_RISK,
  };
}

/** "$1,234" for a per-1k figure. */
export const money = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
