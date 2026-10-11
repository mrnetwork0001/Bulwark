import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PLANS, measure, scenarios, type RunRecord } from '../bulwark/cost/economics';
import { CostMeter, countTrial, recordLlmCall, summarizeCalls, usd, type CostSummary } from '../bulwark/cost/meter';
import { costOf, loadPriceBook, parseZgModels, type Price } from '../bulwark/cost/pricing';
import { rankModels, type ModelEntry } from '../bulwark/ranking';
import { combineRisk, dollarsAtRisk, trialRisk } from '../bulwark/risk';
import { runExperiment } from '../bulwark/scorecard';
import { wilson as wilsonFor } from '../bulwark/stats';
import { getFault } from '../bulwark/chaos/faults';
import { target } from '../targets/refundbot/bulwark.target';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// --- pricing ---

test('costOf prices input, output and cache tokens', () => {
  const p: Price = { prompt: 2e-6, completion: 10e-6, source: 'static' };
  close(costOf({ inputTokens: 1000, outputTokens: 500 }, p), 0.002 + 0.005);
  // cache defaults: write 1.25× prompt, read 0.1× prompt
  close(costOf({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000, cacheReadTokens: 1000 }, p), 0.0025 + 0.0002);
});

const ZG_PAYLOAD = {
  data: [
    { id: 'claude-sonnet-5', pricing_usd: { prompt: '0.0000019', completion: '0.0000095', cache_write: '0.000002375' } },
    { id: 'glm-5.3-flash', pricing_usd: { prompt: '0.0000001431', completion: '0.0000005009' } },
    { id: 'seedream', pricing_usd: { image: '0.05' } },
  ],
};

test('parseZgModels reads USD-per-token prices and skips non-token models', () => {
  const t = parseZgModels(ZG_PAYLOAD);
  assert.deepEqual(Object.keys(t).sort(), ['claude-sonnet-5', 'glm-5.3-flash']);
  close(t['claude-sonnet-5'].prompt, 1.9e-6);
  close(t['claude-sonnet-5'].cacheWrite!, 2.375e-6);
});

test('price book: 0G live prices, cache on disk, static Anthropic fallback, unknown = $0', async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), 'bulwark-price-')), 'p.json');
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches++;
    return new Response(JSON.stringify(ZG_PAYLOAD));
  }) as typeof fetch;

  const live = await loadPriceBook({ provider: '0g', cachePath, fetchImpl });
  assert.equal(live.zgSource, 'live');
  close(live.priceFor('claude-sonnet-5').prompt, 1.9e-6); // 0G's price, not Anthropic's $2/MTok
  assert.equal(live.priceFor('claude-haiku-5-5').source, 'static');
  assert.equal(live.priceFor('nope').source, 'unknown');

  const cached = await loadPriceBook({ provider: '0g', cachePath, fetchImpl });
  assert.equal(cached.zgSource, 'cache');
  assert.equal(fetches, 1);

  // Anthropic direct prefers the first-party table.
  const direct = await loadPriceBook({ provider: 'anthropic', cachePath, fetchImpl });
  close(direct.priceFor('claude-sonnet-5').prompt, 2e-6);
});

// --- meter ---

test('summarizeCalls splits LLM and compute cost and groups by role+model', () => {
  const price: Price = { prompt: 1e-6, completion: 2e-6, source: 'static' };
  const s = summarizeCalls(
    [
      { role: 'fixer', model: 'm', inputTokens: 1000, outputTokens: 1000, ms: 100 },
      { role: 'agent', model: 'm', inputTokens: 500, outputTokens: 0, ms: 50 },
      { role: 'agent', model: 'm', inputTokens: 0, outputTokens: 0, ms: 10, error: true },
    ],
    () => price,
    { wallMs: 3_600_000, trials: 4, computeUsdPerHour: 0.1 },
  );
  close(s.llmUsd, 0.003 + 0.0005);
  close(s.computeUsd, 0.1);
  close(s.totalUsd, 0.1035);
  assert.equal(s.calls, 3);
  assert.equal(s.byModel.length, 2);
  assert.equal(s.byModel.find((m) => m.role === 'agent')!.errors, 1);
});

test('meter scopes calls and trials to the run that started them, across async work', async () => {
  const a = new CostMeter();
  const b = new CostMeter();
  await Promise.all([
    a.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      recordLlmCall({ role: 'agent', model: 'x', inputTokens: 1, outputTokens: 1, ms: 1 });
      countTrial();
    }),
    b.run(async () => {
      countTrial();
      countTrial();
    }),
  ]);
  recordLlmCall({ role: 'agent', model: 'x', inputTokens: 1, outputTokens: 1, ms: 1 }); // no meter: dropped
  assert.equal(a.calls.length, 1);
  assert.equal(a.trials, 1);
  assert.equal(b.calls.length, 0);
  assert.equal(b.trials, 2);
});

test('usd formats sub-cent amounts with two significant digits', () => {
  assert.equal(usd(3.2), '$3.20');
  assert.equal(usd(0.042), '$0.042');
  assert.equal(usd(0.00147), '$0.0015');
  assert.equal(usd(0), '$0');
});

// --- dollars at risk ---

const order = { id: 'o1', customer: 'Ada', email: 'ada@x', total: 49, currency: 'USD', status: 'paid' as const };
const base = { orders: [order], customerEmail: 'ada@x' };
const costs = { lostTicketUsd: 20, escalationUsd: 15 };
const email = { to: 'ada@x', subject: 's', body: 'b' };

test('trialRisk: over-refund from the ledger, lost tickets and escalations are exclusive', () => {
  const ok = trialRisk({ ...base, outcome: 'completed', refunds: [{ id: 'r', orderId: 'o1', amount: 49 }], emails: [email] }, costs);
  assert.equal(ok.usd, 0);

  const double = trialRisk({ ...base, outcome: 'completed', refunds: [{ id: 'r1', orderId: 'o1', amount: 49 }, { id: 'r2', orderId: 'o1', amount: 49 }], emails: [email] }, costs);
  assert.equal(double.overRefundUsd, 49);
  assert.equal(double.usd, 49);

  const lost = trialRisk({ ...base, outcome: 'completed', refunds: [], emails: [] }, costs);
  assert.deepEqual([lost.lostTicket, lost.escalation, lost.usd], [true, false, 20]);

  const hung = trialRisk({ ...base, outcome: 'hung', refunds: [{ id: 'r', orderId: 'o1', amount: 5000 }], emails: [] }, costs);
  assert.deepEqual([hung.lostTicket, hung.escalation], [false, true]);
  assert.equal(hung.usd, 4951 + 15);
});

test('dollarsAtRisk scales to 1,000 tickets and combineRisk weights by trials', () => {
  const obs = [
    { ...base, outcome: 'completed' as const, refunds: [], emails: [email] },
    { ...base, outcome: 'crashed' as const, refunds: [], emails: [] },
  ];
  const d = dollarsAtRisk(obs, costs);
  assert.equal(d.per1kTickets, 7500); // $15 over 2 tickets
  const c = combineRisk([d, dollarsAtRisk([obs[0], obs[0]], costs)]);
  assert.equal(c.trials, 4);
  assert.equal(c.per1kTickets, 3750);
});

test('experiments carry dollars at risk (simulated brain, prompt injection over-refunds)', async () => {
  const r = await runExperiment(target, getFault('prompt-injection'), { trials: 10, seed: 42, brain: 'simulated', deadlineMs: 2000, maxSteps: 50 });
  assert.ok(r.dollarsAtRisk!.overRefundUsd > 0);
  assert.equal(r.dollarsAtRisk!.trials, 10);
  assert.deepEqual(r.dollarsAtRisk!.costs, { lostTicketUsd: 20, escalationUsd: 15 });
});

// --- leaderboard ranking ---

const entry = (model: string, passed: number, trials: number, risk: number, cost: number, status: ModelEntry['status'] = 'ok'): ModelEntry => ({
  model,
  status,
  trials,
  passed,
  passRate: trials ? passed / trials : 0,
  ci95: trials ? (wilsonFor(passed, trials) as [number, number]) : [0, 1],
  dollarsAtRisk1k: risk,
  llmUsd: 0,
  llmCostPerTrial: cost / 1000,
  llmCostPer1k: cost,
  p95Ms: 0,
  calls: 0,
  apiErrors: 0,
  perFault: [],
});

test('rankModels: resilience (Wilson lower bound), then dollars at risk, then cost; errors last and unranked', () => {
  const ranked = rankModels([
    entry('broken', 0, 0, 0, 0, 'error'),
    entry('cheap-tie', 9, 10, 9800, 0.5),
    entry('pricey-tie', 9, 10, 9800, 17),
    entry('lucky-small', 3, 3, 0, 0.1), // 100% but tiny sample: lower bound 44%
    entry('risky-tie', 9, 10, 20000, 0.1),
    entry('best', 19, 20, 500, 5),
  ]);
  assert.deepEqual(
    ranked.map((e) => e.model),
    ['best', 'cheap-tie', 'pricey-tie', 'risky-tie', 'lucky-small', 'broken'],
  );
  assert.deepEqual(ranked.map((e) => e.rank), [1, 2, 3, 4, 5, undefined]);
});

// --- unit economics ---

const summary = (llm: number, compute: number, trials: number, calls: number): CostSummary => ({
  llmUsd: llm,
  computeUsd: compute,
  totalUsd: llm + compute,
  wallMs: 60_000,
  llmMs: 0,
  calls,
  trials,
  inputTokens: 0,
  outputTokens: 0,
  byModel: [],
  assumptions: { computeUsdPerHour: 0.1, prices: 'test' },
});

test('measure: cost per run, per fixed fault, per trial and LLM share', () => {
  const runs: RunRecord[] = [
    { runId: 'a', fixer: 'claude', fixed: 2, trials: 1000, cost: summary(0.09, 0.01, 1000, 3), riskBefore1k: 1000, riskAfter1k: 0 },
    { runId: 'b', fixer: 'playbook', fixed: 0, trials: 1000, cost: summary(0, 0.1, 1000, 0) },
  ];
  const m = measure(runs);
  close(m.perRunUsd, 0.1);
  close(m.perFixedFaultUsd!, 0.1);
  close(m.perTrialUsd, 0.0001);
  close(m.llmShare, 0.45);
  assert.equal(m.llmRuns, 1);
  assert.equal(m.riskRemoved1k, 1000);
});

test('scenarios: gross margin = (price - runs × cost per run) / price, plus a real-LLM variant', () => {
  const m = measure([{ runId: 'a', fixer: 'x', fixed: 1, trials: 100, cost: summary(0.5, 0.5, 100, 1) }]);
  const [starter, team] = scenarios(m, DEFAULT_PLANS, { perTrialUsd: 0.01, trialsPerRun: 100 });
  close(starter.cogsSimulated, 4); // 4 runs × $1
  close(starter.marginSimulated, (49 - 4) / 49);
  close(starter.cogsRealLlm!, 4 + 4 * 1); // + 4 runs × 100 trials × $0.01
  close(team.cogsSimulated, 30);
});
