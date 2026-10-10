import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getFault } from '../bulwark/chaos/faults';
import { compileRules } from '../bulwark/invariants';
import { runExperiment } from '../bulwark/scorecard';
import { wilson } from '../bulwark/stats';
import { PaymentsSandbox } from '../targets/refundbot/payments';
import { target } from '../targets/refundbot/bulwark.target';

const opts = { trials: 10, seed: 42, brain: 'simulated' as const, deadlineMs: 2000, maxSteps: 50 };

test('wilson interval matches known values at the extremes', () => {
  const [lo0, hi0] = wilson(0, 20);
  assert.equal(lo0, 0);
  assert.ok(Math.abs(hi0 - 0.161) < 0.001);
  const [lo20, hi20] = wilson(20, 20);
  assert.ok(Math.abs(lo20 - 0.839) < 0.001);
  assert.equal(hi20, 1);
});

test('every RefundBot rule compiles; unknown rules are reported, not skipped', () => {
  assert.equal(compileRules(target.rules).uncompiled.length, 0);
  const { uncompiled } = compileRules(['Always be polite.']);
  assert.deepEqual(uncompiled, ['Always be polite.']);
});

test('sandbox honours idempotency keys', () => {
  const sb = new PaymentsSandbox(target.fixtures().orders);
  sb.createRefund({ orderId: 'ord_1001', amount: 49, idempotencyKey: 'k1' });
  sb.createRefund({ orderId: 'ord_1001', amount: 49, idempotencyKey: 'k1' });
  assert.equal(sb.refunds.length, 1);
});

test('baseline: RefundBot passes every rule when nothing breaks', async () => {
  const r = await runExperiment(target, undefined, opts);
  assert.equal(r.passed, r.trials);
});

test('timeout-after-commit reproduces the double refund, deterministically', async () => {
  const a = await runExperiment(target, getFault('timeout-after-commit'), opts);
  const b = await runExperiment(target, getFault('timeout-after-commit'), opts);
  assert.ok(a.violations['Never refund an order more than once.'] > 0);
  assert.deepEqual(a.violations, b.violations);
});
