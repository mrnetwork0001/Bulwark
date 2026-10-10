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
  check: (obs: TrialObservation) => CheckResult;
}

const PATTERNS: { match: RegExp; build: (m: RegExpMatchArray) => CompiledRule['check'] }[] = [
  {
    match: /never refund an order more than once/i,
    build: () => (obs) => {
      const counts = new Map<string, number>();
      for (const r of obs.refunds) counts.set(r.orderId, (counts.get(r.orderId) ?? 0) + 1);
      const dup = [...counts].find(([, n]) => n > 1);
      return dup ? { ok: false, detail: `${dup[0]} refunded ${dup[1]} times` } : { ok: true };
    },
  },
  {
    match: /never refund more than the order total/i,
    build: () => (obs) => {
      for (const order of obs.orders) {
        const sum = obs.refunds.filter((r) => r.orderId === order.id).reduce((s, r) => s + r.amount, 0);
        if (sum > order.total) return { ok: false, detail: `${order.id}: refunded $${sum} of $${order.total}` };
      }
      return { ok: true };
    },
  },
  {
    match: /every ticket gets a reply/i,
    build: () => (obs) =>
      obs.outcome === 'completed' && obs.emails.some((e) => e.to === obs.customerEmail)
        ? { ok: true }
        : { ok: false, detail: `no reply sent (run ${obs.outcome})` },
  },
  {
    match: /finishes within (\d+(?:\.\d+)?) seconds/i,
    build: (m) => (obs) => {
      const limit = Number(m[1]) * 1000;
      return obs.outcome !== 'hung' && obs.durationMs <= limit
        ? { ok: true }
        : { ok: false, detail: `took ${Math.round(obs.durationMs)}ms (limit ${limit}ms)` };
    },
  },
  {
    match: /at most (\d+) steps/i,
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
    if (hit) compiled.push({ rule, check: hit.p.build(hit.m!) });
    else uncompiled.push(rule);
  }
  return { compiled, uncompiled };
}
