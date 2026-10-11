import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlaybookFixer } from '../bulwark/blue/fixer';
import { applyStrategy, PLAYBOOK } from '../bulwark/blue/playbook';
import { getFault } from '../bulwark/chaos/faults';
import { fixedWithOverhead, judge, runAll } from '../bulwark/judge/judge';
import { compareOverhead, parsePercent, perfOf, type Overhead, type Perf } from '../bulwark/judge/overhead';
import { evaluateSlo, parseSlo, planSlo } from '../bulwark/judge/slo';
import { createEntrant, parseTournament, proposeAll, rankContenders, type Contender } from '../bulwark/judge/tournament';
import type { TrialObservation } from '../bulwark/harness';
import type { ExperimentResult } from '../bulwark/scorecard';
import { loadTarget } from '../bulwark/target';
import { readFiles, Workspace } from '../bulwark/workspace';
import { clopperPearsonLower, zeroFailureTrials } from '../bulwark/stats';

// ---- SLO math ---------------------------------------------------------------

test('zero-failure trials: 0.95 → 59, 0.99 → 299, 0.999 → 2995 at 95% confidence', () => {
  assert.equal(zeroFailureTrials(0.95), 59);
  assert.equal(zeroFailureTrials(0.99), 299);
  assert.equal(zeroFailureTrials(0.999), 2995);
  assert.equal(zeroFailureTrials(0.9), 29);
  assert.equal(zeroFailureTrials(0.99, 0.99), 459);
});

test('zero-failure trials are the smallest n whose Clopper-Pearson bound at n/n reaches the target', () => {
  for (const target of [0.8, 0.9, 0.95, 0.975, 0.99]) {
    const n = zeroFailureTrials(target);
    assert.ok(clopperPearsonLower(n, n) >= target, `${n}/${n} should demonstrate ${target}`);
    assert.ok(clopperPearsonLower(n - 1, n - 1) < target, `${n - 1}/${n - 1} should not demonstrate ${target}`);
  }
});

test('Clopper-Pearson lower bound: known values and monotone in failures', () => {
  // 59/59: 0.05^(1/59) ≈ 0.9505
  assert.ok(Math.abs(clopperPearsonLower(59, 59) - 0.9505) < 1e-3);
  // 56/59 one-sided 95% lower bound ≈ 0.874 (beta quantile)
  assert.ok(Math.abs(clopperPearsonLower(56, 59) - 0.8738) < 2e-3);
  assert.ok(clopperPearsonLower(58, 59) < clopperPearsonLower(59, 59));
  assert.ok(clopperPearsonLower(30, 59) < clopperPearsonLower(56, 59));
  assert.equal(clopperPearsonLower(0, 10), 0);
});

test('SLO parsing, per-fault overrides, and the trial cap', () => {
  const spec = parseSlo('0.99,timeout-after-commit=99.5%');
  assert.equal(spec.default, 0.99);
  assert.equal(spec.perFault['timeout-after-commit'], 0.995);
  const plans = planSlo(spec, ['latency-spike', 'timeout-after-commit']);
  assert.deepEqual(plans.map((p) => [p.fault, p.trials]), [['latency-spike', 299], ['timeout-after-commit', 598]]);
  assert.deepEqual(planSlo(parseSlo('stuck-pending=0.9'), ['latency-spike', 'stuck-pending']).map((p) => p.fault), ['stuck-pending']);
  assert.throws(() => planSlo(parseSlo('0.999'), ['latency-spike']), /2,995 zero-failure trials.*cap of 1,000/);
  assert.equal(planSlo(parseSlo('0.999', 0.95, 5000), ['x'])[0].trials, 2995);
  assert.throws(() => parseSlo('1.5'), /between 0 and 1/);
  assert.deepEqual(planSlo(undefined, ['latency-spike']), []);
});

test('SLO verdict: demonstrated only when every planned trial passed', () => {
  const [plan] = planSlo(parseSlo('0.95'), ['f']);
  const ok = evaluateSlo(plan, 59, 59);
  assert.equal(ok.demonstrated, true);
  assert.ok(ok.lowerBound >= 0.95);
  const miss = evaluateSlo(plan, 58, 59);
  assert.equal(miss.demonstrated, false);
  assert.ok(miss.lowerBound < 0.95);
  assert.equal(evaluateSlo(plan, 40, 40).demonstrated, false, 'too few trials cannot demonstrate the SLO');
});

// ---- Overhead ---------------------------------------------------------------

const perf = (p: Partial<Perf>): Perf => ({ runs: 40, p50Ms: 100, p95Ms: 150, avgSteps: 5, ...p });

test('perfOf: percentiles, average steps, and cost only when every trial is priced', () => {
  const obs = [10, 20, 30, 40].map((d, i) => ({ durationMs: d, steps: i + 3 }) as TrialObservation);
  const p = perfOf(obs, () => undefined);
  assert.equal(p.p50Ms, 20);
  assert.equal(p.p95Ms, 40);
  assert.equal(p.avgSteps, 4.5);
  assert.equal(p.costPerRunUsd, undefined);
  assert.equal(perfOf(obs, () => 0.01).costPerRunUsd, 0.01);
  assert.equal(perfOf(obs, (o) => (o.steps > 3 ? 0.01 : undefined)).costPerRunUsd, undefined);
});

test('overhead budgets: latency over budget, step budget, noise floor, cost only when priced', () => {
  const base = perf({});
  assert.equal(compareOverhead(base, perf({ p50Ms: 200, p95Ms: 300 }), {}).withinBudget, true, 'no budgets → never exceeded');

  const slow = compareOverhead(base, perf({ p50Ms: 200, p95Ms: 300 }), { maxLatencyOverhead: 0.5 });
  assert.equal(slow.withinBudget, false);
  assert.equal(slow.exceeded.length, 2);
  assert.match(slow.exceeded[0], /p50 latency 100→200ms \(\+100%\) exceeds the \+50% budget/);

  // +100% but only +20ms: below the noise floor, not overhead.
  const tiny = compareOverhead(perf({ p50Ms: 20, p95Ms: 30 }), perf({ p50Ms: 40, p95Ms: 50 }), { maxLatencyOverhead: 0.5 });
  assert.equal(tiny.withinBudget, true);

  const steps = compareOverhead(base, perf({ avgSteps: 8 }), { maxStepOverhead: 2 });
  assert.deepEqual(steps.exceeded, ['avg steps 5.0→8.0 (+3.0) exceeds the +2 budget']);
  assert.equal(compareOverhead(base, perf({ avgSteps: 7 }), { maxStepOverhead: 2 }).withinBudget, true);

  assert.equal(compareOverhead(base, perf({ costPerRunUsd: 1 }), { maxCostOverhead: 0.1 }).withinBudget, true, 'unpriced base → cost not judged');
  const pricey = compareOverhead(perf({ costPerRunUsd: 0.01 }), perf({ costPerRunUsd: 0.02 }), { maxCostOverhead: 0.2 });
  assert.equal(pricey.withinBudget, false);
  assert.equal(pricey.costPct, 1);
});

test('fixed with overhead is a fixed verdict that exceeded a budget', () => {
  const over = compareOverhead(perf({}), perf({ avgSteps: 9 }), { maxStepOverhead: 1 });
  assert.equal(fixedWithOverhead({ status: 'fixed', overhead: over }), true);
  assert.equal(fixedWithOverhead({ status: 'rejected', overhead: over }), false);
  assert.equal(fixedWithOverhead({ status: 'fixed', overhead: compareOverhead(perf({}), perf({})) }), false);
  assert.equal(fixedWithOverhead({ status: 'fixed' }), false);
  assert.equal(parsePercent('50%'), 0.5);
  assert.equal(parsePercent('0.5'), 0.5);
  assert.equal(parsePercent('50'), 0.5);
});

// ---- Tournament ranking -----------------------------------------------------

const oh = (after: Partial<Perf>, budgets = {}): Overhead => compareOverhead(perf({}), perf(after), budgets);
const c = (entrant: string, x: Partial<Contender>): Contender => ({ entrant, status: 'fixed', diffSize: 10, overhead: oh({}), ...x });

test('tournament: a working fix beats a rejected one, whatever the diff size', () => {
  const { ranking, winner } = rankContenders([c('a', { status: 'rejected', diffSize: 1, summary: 'still failing 3/40' }), c('b', { diffSize: 90 })]);
  assert.equal(winner, 'b');
  assert.equal(ranking[1].outcome, 'loser');
  assert.match(ranking[1].reason, /rejected: still failing/);
});

test('tournament: SLO not demonstrated loses to SLO demonstrated', () => {
  const { winner, ranking } = rankContenders([c('a', { sloDemonstrated: false }), c('b', { sloDemonstrated: true, diffSize: 50 })]);
  assert.equal(winner, 'b');
  assert.match(ranking[1].reason, /SLO was not demonstrated/);
});

test('tournament: lower overhead wins, then smaller diff, then entrant order', () => {
  let r = rankContenders([c('heavy', { overhead: oh({ avgSteps: 7 }), diffSize: 2 }), c('lean', { diffSize: 40 })]);
  assert.equal(r.winner, 'lean');
  assert.match(r.ranking[1].reason, /higher overhead \(avg steps 7\.0 vs 5\.0\)/);

  r = rankContenders([c('slow', { overhead: oh({ p50Ms: 400 }) }), c('fast', {})]);
  assert.equal(r.winner, 'fast');

  r = rankContenders([c('noisy', { overhead: oh({ p50Ms: 120 }), diffSize: 5 }), c('quiet', { diffSize: 30 })]);
  assert.equal(r.winner, 'noisy', '20ms is inside the latency noise tolerance, so the smaller diff decides');

  r = rankContenders([c('big', { diffSize: 30 }), c('small', { diffSize: 5 })]);
  assert.equal(r.winner, 'small');
  assert.match(r.ranking[1].reason, /larger diff \(30 vs 5/);

  r = rankContenders([c('first', { strategy: 's' }), c('second', { strategy: 's' })]);
  assert.equal(r.winner, 'first');
  assert.match(r.ranking[1].reason, /same fix/);
});

test('tournament: an in-budget fix beats one flagged "fixed with overhead"; cost decides first', () => {
  const r = rankContenders([c('over', { overhead: oh({ avgSteps: 9 }, { maxStepOverhead: 1 }), diffSize: 1 }), c('within', { diffSize: 99 })]);
  assert.equal(r.winner, 'within');
  assert.match(r.ranking[1].reason, /over the overhead budget/);

  const priced = (cost: number, steps: number) => compareOverhead(perf({ costPerRunUsd: 0.01 }), perf({ costPerRunUsd: cost, avgSteps: steps }));
  const r2 = rankContenders([c('cheap-steps', { overhead: priced(0.05, 4) }), c('cheap-dollars', { overhead: priced(0.01, 6) })]);
  assert.equal(r2.winner, 'cheap-dollars');
});

test('tournament: no winner when nothing works; all candidates are reported', () => {
  const r = rankContenders([c('a', { status: 'rejected' }), c('b', { status: 'no-proposal', summary: 'timeout' }), c('c', { status: 'inconclusive' })]);
  assert.equal(r.winner, undefined);
  assert.deepEqual(r.ranking.map((x) => x.entrant), ['c', 'a', 'b']);
  assert.ok(r.ranking.every((x) => x.outcome === 'no-winner'));
});

test('tournament entrants: playbook entrants work offline and propose in parallel', async () => {
  assert.throws(() => parseTournament('playbook'), /at least two/);
  assert.deepEqual(parseTournament('playbook, playbook-strong'), ['playbook', 'playbook-strong']);
  const saved = { a: process.env.ANTHROPIC_API_KEY, z: process.env.ZG_ROUTER_API_KEY };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ZG_ROUTER_API_KEY;
  try {
    assert.throws(() => createEntrant('claude-sonnet-5'), /needs ZG_ROUTER_API_KEY/);
    const target = await loadTarget('targets/refundbot');
    const files = readFiles('targets/refundbot', target.editableFiles);
    const failing = { propose: async () => { throw new Error('model unavailable'); }, name: 'broken' };
    const entries = await proposeAll([createEntrant('playbook'), createEntrant('playbook-strong'), failing, new PlaybookFixer()], {
      fault: getFault('timeout-after-commit'), findings: [], files, before: {} as ExperimentResult, failed: [], rules: [], preferred: [],
    });
    assert.deepEqual(entries.map((e) => e.proposal?.strategy), ['retry-backoff', 'idempotency-key+escalate', undefined, 'retry-backoff']);
    assert.equal(entries[1].proposal?.author, 'playbook-strong');
    assert.equal(entries[2].error, 'model unavailable');
  } finally {
    if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.z !== undefined) process.env.ZG_ROUTER_API_KEY = saved.z;
  }
});

// ---- Judge wiring (real trials, small n) ------------------------------------

test('judge: SLO sets the after-fix trial count; overhead budgets reject or flag a working fix', async () => {
  const target = await loadTarget('targets/refundbot');
  const files = readFiles('targets/refundbot', target.editableFiles);
  const fixed = applyStrategy(PLAYBOOK.latency.find((s) => s.id === 'harden-lookup+escalate')!, files)!;
  mkdirSync('.bulwark', { recursive: true });
  const root = mkdtempSync(join('.bulwark', 'test-'));
  try {
    const dir = new Workspace(root, 'targets/refundbot').materialize('fixed', fixed);
    const opts = { trials: 6, seed: 7, brain: 'simulated' as const, deadlineMs: 5000, maxSteps: 50, traceSample: 0 };
    const base = await runAll(target, opts);
    assert.ok(base.baseline.perf, 'runAll measures perf');
    // Pretend the unpatched happy path took 1 step per run, so the fix looks like +4 steps.
    base.baseline = { ...base.baseline, perf: { ...base.baseline.perf!, avgSteps: 1 } };
    base['latency-spike'] = { ...base['latency-spike'], passed: 0, passRate: 0 };
    const fault = getFault('latency-spike');
    const [slo] = planSlo(parseSlo('0.8'), ['latency-spike']);
    assert.equal(slo.trials, 14);

    const ok = await judge({ fault, candidate: () => loadTarget(dir), baseResults: base, opts, slo });
    assert.equal(ok.status, 'fixed', ok.reasons.join('; '));
    assert.equal(ok.after.trials, 14, 'the fault under the SLO runs exactly the planned trials');
    assert.equal(ok.results.baseline.trials, 6, 'other experiments keep their trial counts');
    assert.equal(ok.slo?.demonstrated, true);

    const rejected = await judge({ fault, candidate: () => loadTarget(dir), baseResults: base, opts, budgets: { maxStepOverhead: 2 } });
    assert.equal(rejected.status, 'rejected');
    assert.match(rejected.reasons.join(' '), /overhead over budget: avg steps 1\.0→5\.0/);

    const flagged = await judge({ fault, candidate: () => loadTarget(dir), baseResults: base, opts, budgets: { maxStepOverhead: 2, policy: 'flag' } });
    assert.equal(flagged.status, 'fixed');
    assert.equal(fixedWithOverhead(flagged), true);
    assert.match(flagged.reasons.join(' '), /fixed with overhead/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
