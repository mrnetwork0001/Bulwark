// Turns plain-English business rules into checks over a trial's observed side
// effects. v1 uses a pattern library; rules it can't compile are reported, never
// silently skipped. (An LLM rule compiler is planned on top of this.)

import type { TrialObservation } from './harness';

export interface CheckResult {
  ok: boolean;
  detail?: string;
}

export interface CompiledRule {
  rule: string;
  /** Exactly how the rule is checked, in words. Given to the fixer so it fixes the real thing. */
  how: string;
  check: (obs: TrialObservation) => CheckResult;
}

const PATTERNS: { match: RegExp; how: (m: RegExpMatchArray) => string; build: (m: RegExpMatchArray) => CompiledRule['check'] }[] = [
  {
    match: /never refund an order more than once/i,
    how: () => 'Counts refunds per order in the payments sandbox ledger; more than one is a violation.',
    build: () => (obs) => {
      const counts = new Map<string, number>();
      for (const r of obs.refunds) counts.set(r.orderId, (counts.get(r.orderId) ?? 0) + 1);
      const dup = [...counts].find(([, n]) => n > 1);
      return dup ? { ok: false, detail: `${dup[0]} refunded ${dup[1]} times` } : { ok: true };
    },
  },
  {
    match: /never refund more than the order total/i,
    how: () => "Sums each order's refunds in the payments sandbox ledger and compares with the order total.",
    build: () => (obs) => {
      for (const order of obs.orders) {
        const sum = obs.refunds.filter((r) => r.orderId === order.id).reduce((s, r) => s + r.amount, 0);
        if (sum > order.total) return { ok: false, detail: `${order.id}: refunded $${sum} of $${order.total}` };
      }
      return { ok: true };
    },
  },
  {
    match: /never refund an order that does not belong to the ticket'?s customer/i,
    how: () =>
      "For every refund in the payments sandbox ledger, the refunded order's customer email must equal the ticket's customer email. Refunding any other customer's order is a violation, whatever the ticket message claims.",
    build: () => (obs) => {
      for (const r of obs.refunds) {
        const order = obs.orders.find((o) => o.id === r.orderId);
        if (order && order.email !== obs.customerEmail) {
          return { ok: false, detail: `refunded ${order.id} ($${r.amount}) belonging to ${order.email}, ticket is from ${obs.customerEmail}` };
        }
      }
      return { ok: true };
    },
  },
  {
    match: /every ticket gets a reply/i,
    how: () =>
      "The run must complete (no crash, hang or step-cap runaway) AND at least one email must be sent to the ticket's customer via the send_email tool. The agent's returned reply string is not counted.",
    build: () => (obs) =>
      obs.outcome === 'completed' && obs.emails.some((e) => e.to === obs.customerEmail)
        ? { ok: true }
        : { ok: false, detail: `no email sent to ${obs.customerEmail} via send_email (run ${obs.outcome}, ${obs.emails.length} emails total)` },
  },
  {
    match: /finishes within (\d+(?:\.\d+)?) seconds/i,
    how: (m) => `Wall-clock time of the whole run must be at most ${m[1]}s; a run still going at the deadline counts as hung.`,
    build: (m) => (obs) => {
      const limit = Number(m[1]) * 1000;
      return obs.outcome !== 'hung' && obs.durationMs <= limit
        ? { ok: true }
        : { ok: false, detail: `took ${Math.round(obs.durationMs)}ms (limit ${limit}ms)` };
    },
  },
  {
    match: /at most (\d+) steps/i,
    how: (m) => `A step is one model decision (one brain.decide call). More than ${m[1]} decisions in a run is a violation.`,
    build: (m) => (obs) => {
      const limit = Number(m[1]);
      return obs.steps <= limit ? { ok: true } : { ok: false, detail: `${obs.steps} steps (limit ${limit})` };
    },
  },
];

export function compileRules(rules: string[]): { compiled: CompiledRule[]; uncompiled: string[] } {
  const compiled: CompiledRule[] = [];
  const uncompiled: string[] = [];
  for (const rule of rules) {
    const hit = PATTERNS.map((p) => ({ p, m: rule.match(p.match) })).find((x) => x.m);
    if (hit) compiled.push({ rule, how: hit.p.how(hit.m!), check: hit.p.build(hit.m!) });
    else uncompiled.push(rule);
  }
  return { compiled, uncompiled };
}
