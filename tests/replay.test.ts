import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { getFault } from '../bulwark/chaos/faults';
import { runTrial } from '../bulwark/harness';
import { stableTimeline } from '../bulwark/recorder';
import { replayTrial, resolveReplayDir } from '../bulwark/replay';
import { runExperiment } from '../bulwark/scorecard';
import { target } from '../targets/refundbot/bulwark.target';

const opts = { trials: 10, seed: 42, brain: 'simulated' as const, deadlineMs: 5000, maxSteps: 50 };

async function doubleRefundSeed(): Promise<number> {
  const r = await runExperiment(target, getFault('timeout-after-commit'), opts);
  const ex = r.examples.find((e) => e.rule === 'Never refund an order more than once.');
  assert.ok(ex, 'expected a double refund among the trials');
  return ex.seed;
}

test('scorecard lists every trial with its seed, in order', async () => {
  const r = await runExperiment(target, getFault('rate-limit'), opts);
  assert.equal(r.perTrial.length, r.trials);
  assert.equal(r.perTrial.filter((t) => t.passed).length, r.passed);
  assert.ok(r.perTrial.every((t) => Number.isInteger(t.seed)));
});

test('replaying a double refund shows the fault, the timeout, the retry and two refunds', async () => {
  const seed = await doubleRefundSeed();
  const r = await replayTrial({ target, fault: 'timeout-after-commit', seed });
  const calls = r.timeline.filter((e) => e.type === 'call' && e.endpoint === 'refunds.create');
  assert.ok(calls.length >= 2);
  assert.ok(r.timeline.some((e) => e.type === 'fault' && e.endpoint === 'refunds.create'));
  assert.ok(r.timeline.some((e) => e.type === 'timeout'));
  assert.ok(calls.some((e) => e.type === 'call' && e.retryOf));
  assert.ok(r.timeline.filter((e) => e.type === 'effect' && e.effect === 'refund').length >= 2);
  assert.equal(r.timeline.filter((e) => e.type === 'outcome').length, 1);
  assert.ok(r.broken.some((b) => b.rule === 'Never refund an order more than once.' && b.detail && b.how));
  r.timeline.forEach((e, i) => assert.equal(e.i, i));
});

test('replays are deterministic and recording does not change the trial', async () => {
  const seed = await doubleRefundSeed();
  for (const fault of ['timeout-after-commit', 'prompt-injection', 'stuck-pending']) {
    const a = await replayTrial({ target, fault, seed });
    const b = await replayTrial({ target, fault, seed });
    assert.deepEqual(stableTimeline(a.timeline), stableTimeline(b.timeline), fault);
    const plain = await runTrial({ ...opts, target, fault: getFault(fault), seed, traced: false });
    assert.equal(plain.timeline, undefined);
    assert.equal(plain.outcome, a.observation.outcome);
    assert.deepEqual(plain.refunds, a.observation.refunds);
    assert.equal(plain.steps, a.observation.steps);
  }
});

test('replay rejects unknown faults and bad seeds', async () => {
  await assert.rejects(replayTrial({ target, fault: 'nope', seed: 1 }), /unknown fault/);
  await assert.rejects(replayTrial({ target, fault: 'baseline', seed: -1 }), /seed/);
});

test('replay dir resolution refuses path traversal', () => {
  assert.equal(resolveReplayDir({}), resolve('targets/refundbot'));
  assert.equal(resolveReplayDir({ target: 'refundbot' }), resolve('targets/refundbot'));
  assert.equal(resolveReplayDir({ target: 'targets/refundbot' }), resolve('targets/refundbot'));
  for (const bad of ['../bulwark', '..', 'targets/../bulwark', '/etc', 'refundbot/../../x', '', 'a/b']) {
    assert.throws(() => resolveReplayDir({ target: bad }), Error, bad);
  }

  const state = mkdtempSync(join(tmpdir(), 'bulwark-replay-'));
  try {
    const ws = join(state, 'runs', '2026-10-11T03-12-25-548Z', 'ws', 'timeout-after-commit-accepted');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'bulwark.target.ts'), '');
    assert.equal(resolveReplayDir({ run: '2026-10-11T03-12-25-548Z', ws: 'timeout-after-commit-accepted' }, state), ws);
    const bad: [string, string][] = [
      ['..', 'x'],
      ['2026-10-11T03-12-25-548Z', '..'],
      ['2026-10-11T03-12-25-548Z', '../ws/timeout-after-commit-accepted'],
      ['../runs', 'x'],
      ['a/b', 'c'],
      ['2026-10-11T03-12-25-548Z', 'missing'],
      ['2026-10-11T03-12-25-548Z', ''],
      ['', 'timeout-after-commit-accepted'],
      ['x%2F..', 'y'],
    ];
    for (const [run, w] of bad) assert.throws(() => resolveReplayDir({ run, ws: w }, state), Error, `${run} ${w}`);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
