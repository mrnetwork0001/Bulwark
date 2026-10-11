import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { diffFromParams, diffTimelines, renderDiffText } from '../bulwark/diff';
import { getFault } from '../bulwark/chaos/faults';
import type { TrialEvent } from '../bulwark/recorder';
import { runExperiment } from '../bulwark/scorecard';
import { target } from '../targets/refundbot/bulwark.target';

// Workspaces import the target's packages (neatlogs), so they live inside the repo, under the gitignored .bulwark/.
const scratch = () => {
  mkdirSync('.bulwark', { recursive: true });
  return mkdtempSync(join('.bulwark', 'test-diff-'));
};

// Tiny timelines: i/t filled in, timings deliberately different on each side.
const tl = (events: Record<string, unknown>[], t0 = 0): TrialEvent[] => events.map((e, i) => ({ ...e, i, t: t0 + i * 7 }) as TrialEvent);
const call = (endpoint: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'call' as const, call: 1, endpoint, input, attempt: 1, ...extra });
const result = (endpoint: string, output: unknown, ms = 1) => ({ type: 'result' as const, call: 1, endpoint, output, ms });
const effect = (data: Record<string, unknown>) => ({ type: 'effect' as const, effect: 'refund', data });
const outcome = (o: string, durationMs = 10) => ({ type: 'outcome' as const, outcome: o, steps: 3, durationMs });

test('identical timelines (timings aside) do not diverge', () => {
  const a = tl([call('orders.get', { orderId: 'o1' }), result('orders.get', { id: 'o1' }, 3), outcome('completed', 12)]);
  const b = tl([call('orders.get', { orderId: 'o1' }), result('orders.get', { id: 'o1' }, 900), outcome('completed', 990)], 50);
  const d = diffTimelines(a, b);
  assert.equal(d.divergence, -1);
  assert.equal(d.pivot, -1);
  assert.deepEqual(d.counts, { same: 3, changed: 0, 'only-before': 0, 'only-after': 0 });
  assert.match(d.explanation, /No divergence/);
});

test('a removed side effect is only-before, a changed input is changed, and divergence is the first difference', () => {
  const before = tl([
    call('orders.get', { orderId: 'o1' }),
    call('refunds.create', { orderId: 'o1', amount: 49 }),
    effect({ id: 'rf_1', orderId: 'o1', amount: 49 }),
    call('refunds.create', { orderId: 'o1', amount: 49 }, { retryOf: 2, attempt: 2, call: 3 }),
    effect({ id: 'rf_2', orderId: 'o1', amount: 49 }),
    { ...result('refunds.create', { id: 'rf_2' }), call: 3 },
    outcome('completed'),
  ]);
  const after = tl([
    call('orders.get', { orderId: 'o1' }),
    call('refunds.create', { orderId: 'o1', amount: 49, idempotencyKey: 'k' }),
    effect({ id: 'rf_1', orderId: 'o1', amount: 49 }),
    call('refunds.create', { orderId: 'o1', amount: 49, idempotencyKey: 'k' }, { retryOf: 2, attempt: 2, call: 3 }),
    { ...result('refunds.create', { id: 'rf_1' }), call: 3 },
    outcome('completed'),
  ]);
  const d = diffTimelines(before, after);
  assert.deepEqual(
    d.rows.map((r) => r.kind),
    ['same', 'changed', 'same', 'changed', 'only-before', 'changed', 'same'],
  );
  assert.equal(d.divergence, 1);
  assert.equal(d.pivot, 4);
  assert.deepEqual(d.rows[1].changes, [{ path: 'input.idempotencyKey', after: 'k' }]);
  assert.deepEqual(d.rows[5].changes, [{ path: 'output.id', before: 'rf_2', after: 'rf_1' }]);
  // Every event of each side appears exactly once, in order.
  assert.deepEqual(d.rows.flatMap((r) => (r.b === undefined ? [] : [r.b])), before.map((e) => e.i));
  assert.deepEqual(d.rows.flatMap((r) => (r.a === undefined ? [] : [r.a])), after.map((e) => e.i));
  assert.match(d.explanation, /^Diverges at step 2: refunds\.create now carries idempotencyKey="k"\./);
  assert.match(d.explanation, /At step 5, before, a second refund of \$49 on o1 \(rf_2\) went through; after, it no longer happens, and the refunds\.create retry returns/);
});

test('alignment prefers exact matches and pairs a result with an error as a change', () => {
  // The after side drops the first of two identical-key effects: the exact match must pair with rf_2.
  const before = tl([effect({ id: 'rf_1' }), effect({ id: 'rf_2' }), result('orders.get', { ok: true }), outcome('completed')]);
  const after = tl([effect({ id: 'rf_2' }), { type: 'error', call: 1, endpoint: 'orders.get', error: 'boom', ms: 1 }, outcome('crashed')]);
  const d = diffTimelines(before, after);
  assert.deepEqual(d.rows.map((r) => [r.kind, r.b, r.a]), [
    ['only-before', 0, undefined],
    ['same', 1, 0],
    ['changed', 2, 1],
    ['changed', 3, 2],
  ]);
  assert.equal(d.divergence, 0);
  assert.match(d.explanation, /before, a refund .*rf_1.* went through; after, it no longer happens/);
});

test('an extra event on the after side is only-after', () => {
  const before = tl([call('orders.get', { orderId: 'o1' }), outcome('completed')]);
  const after = tl([call('orders.get', { orderId: 'o1' }), call('orders.get', { orderId: 'o1' }, { retryOf: 1 }), outcome('completed')]);
  const d = diffTimelines(before, after);
  assert.deepEqual(d.rows.map((r) => r.kind), ['same', 'only-after', 'same']);
  assert.equal(d.divergence, 1);
  assert.match(d.explanation, /after, a second orders\.get call went out \(a retry\); before, it did not/);
});

test('real double refund: before vs the playbook fix diverges at the idempotency key, and the second refund is gone', async () => {
  const r = await runExperiment(target, getFault('timeout-after-commit'), { trials: 10, seed: 42, brain: 'simulated', deadlineMs: 5000, maxSteps: 50 });
  const seed = r.examples.find((e) => e.rule === 'Never refund an order more than once.')!.seed;

  // A loop workspace with the idempotency fix, as the orchestrator would materialize it.
  const state = scratch();
  const ws = join(state, 'runs', 'run-1', 'ws', 'timeout-after-commit-accepted');
  try {
    mkdirSync(ws, { recursive: true });
    cpSync('targets/refundbot', ws, { recursive: true, filter: (src) => !src.includes('chaos-tests') });
    const tools = join(ws, 'tools.ts');
    const src = readFileSync(tools, 'utf8');
    const patched = src.replace(
      "transport('refunds.create', { orderId: input.orderId, amount: input.amount })",
      "transport('refunds.create', { orderId: input.orderId, idempotencyKey: `refund:${input.orderId}`, amount: input.amount })",
    );
    assert.notEqual(patched, src, 'expected the unkeyed refunds.create call in tools.ts');
    writeFileSync(tools, patched);

    const q = new URLSearchParams({ fault: 'timeout-after-commit', seed: String(seed), run: 'run-1', target: 'refundbot' });
    const res = await diffFromParams(q, state);
    assert.ok(res.before.broken.some((b) => b.rule === 'Never refund an order more than once.'));
    const d = res.diff;
    assert.ok(d.divergence >= 0);
    const div = d.rows[d.divergence];
    assert.equal(div.kind, 'changed');
    assert.equal(res.after.timeline[div.a!].type, 'call');
    assert.ok(div.changes!.some((c) => c.path === 'input.idempotencyKey'));
    const gone = d.rows[d.pivot];
    assert.equal(gone.kind, 'only-before');
    const ev = res.before.timeline[gone.b!];
    assert.ok(ev.type === 'effect' && ev.effect === 'refund');
    assert.equal(res.after.observation.refunds?.length, 1);
    assert.match(renderDiffText(res), /▶/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('diff API validates its parameters strictly', async () => {
  const state = scratch();
  try {
    const ok = { fault: 'timeout-after-commit', seed: '7', run: 'run-1' };
    const bad: [Record<string, string>, RegExp][] = [
      [{ ...ok, fault: '' }, /fault/],
      [{ ...ok, fault: 'baseline' }, /fault/],
      [{ ...ok, fault: '../x' }, /fault/],
      [{ ...ok, seed: '-1' }, /seed/],
      [{ ...ok, seed: '1.5' }, /seed/],
      [{ ...ok, seed: '99999999999' }, /seed/],
      [{ ...ok, seed: '4294967296' }, /seed/],
      [{ ...ok, run: '' }, /run/],
      [{ ...ok, run: '../runs' }, /run/],
      [{ ...ok, run: 'a/b' }, /run/],
      [{ ...ok, ws: '../../targets/refundbot' }, /ws/],
      [{ ...ok, ws: 'a.b' }, /ws/],
      [{ ...ok, target: '../bulwark' }, /target|unknown|allowlist|not/i],
      [ok, /no workspace/],
    ];
    for (const [params, re] of bad) await assert.rejects(diffFromParams(new URLSearchParams(params), state), re, JSON.stringify(params));

    // A workspace for another target is refused.
    const ws = join(state, 'runs', 'run-2', 'ws', 'timeout-after-commit-accepted');
    mkdirSync(ws, { recursive: true });
    cpSync('targets/researchbot', ws, { recursive: true });
    await assert.rejects(diffFromParams(new URLSearchParams({ ...ok, run: 'run-2' }), state), /is for researchbot, not refundbot/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
