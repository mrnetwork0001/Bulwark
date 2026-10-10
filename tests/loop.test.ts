import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlaybookFixer } from '../bulwark/blue/fixer';
import { applyStrategy, PLAYBOOK } from '../bulwark/blue/playbook';
import { getFault } from '../bulwark/chaos/faults';
import { CheckpointStore } from '../bulwark/checkpoints';
import { StrategyMemory } from '../bulwark/memory';
import { analyzeTarget } from '../bulwark/red/analyze';
import { runExperiment, type ExperimentResult } from '../bulwark/scorecard';
import { fisherGreater } from '../bulwark/stats';
import { loadTarget } from '../bulwark/target';
import { readFiles, Workspace, type Files } from '../bulwark/workspace';

const TARGET_DIR = 'targets/refundbot';
// Inside the repo, so patched copies resolve node_modules like real workspaces do.
const tmp = () => (mkdirSync('.bulwark', { recursive: true }), mkdtempSync(join('.bulwark', 'test-')));

test('fisher test: 40/40 vs 18/40 is significant, 20/20 vs 19/20 is not', () => {
  assert.ok(fisherGreater(40, 40, 18, 40) < 1e-6);
  assert.ok(fisherGreater(20, 20, 19, 20) > 0.05);
});

test('Red analyzer finds a weak link for every fault in the catalog', async () => {
  const target = await loadTarget(TARGET_DIR);
  const covered = new Set(analyzeTarget(TARGET_DIR, target).flatMap((f) => f.faults));
  for (const id of ['latency-spike', 'timeout-after-commit', 'malformed-response', 'rate-limit', 'prompt-injection', 'stuck-pending']) {
    assert.ok(covered.has(id), `no finding for ${id}`);
  }
});

test('every playbook strategy applies cleanly to the original RefundBot', async () => {
  const target = await loadTarget(TARGET_DIR);
  const files = readFiles(TARGET_DIR, target.editableFiles);
  for (const [kind, strategies] of Object.entries(PLAYBOOK)) {
    for (const s of strategies) assert.ok(applyStrategy(s, files), `${kind}/${s.id} did not apply`);
  }
});

test('all winning strategies compose into code that loads and still passes the baseline', async () => {
  const target = await loadTarget(TARGET_DIR);
  let files: Files = readFiles(TARGET_DIR, target.editableFiles);
  for (const id of ['idempotency-key+escalate', 'refund-guard', 'harden-lookup', 'step-budget']) {
    const s = Object.values(PLAYBOOK).flat().find((x) => x.id === id)!;
    files = applyStrategy(s, files) ?? files;
  }
  const root = tmp();
  try {
    const dir = new Workspace(root, TARGET_DIR).materialize('composed', files);
    const patched = await loadTarget(dir);
    const r = await runExperiment(patched, undefined, { trials: 5, seed: 1, brain: 'simulated', deadlineMs: 2000, maxSteps: 50 });
    assert.equal(r.passed, r.trials);
    assert.equal(analyzeTarget(dir, patched).filter((f) => f.severity === 'high' && f.kind !== 'injection').length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('playbook fixer skips strategies the Judge already rejected, and follows memory', async () => {
  const target = await loadTarget(TARGET_DIR);
  const files = readFiles(TARGET_DIR, target.editableFiles);
  const fault = getFault('timeout-after-commit');
  const before = {} as ExperimentResult;
  const fixer = new PlaybookFixer();

  const first = await fixer.propose({ fault, findings: [], files, before, failed: [], preferred: [] });
  assert.equal(first?.strategy, 'retry-backoff');
  const second = await fixer.propose({ fault, findings: [], files, before, failed: [{ strategy: 'retry-backoff', author: 'playbook', rationale: '', reasons: [] }], preferred: [] });
  assert.equal(second?.strategy, 'idempotency-key');
  const remembered = await fixer.propose({ fault, findings: [], files, before, failed: [], preferred: ['idempotency-key+escalate'] });
  assert.equal(remembered?.strategy, 'idempotency-key+escalate');
});

test('checkpoints restore the exact files; memory ranks winners first', () => {
  const root = tmp();
  try {
    const store = new CheckpointStore(join(root, 'ck'));
    const cp = store.save('before', { 'a.ts': 'one' });
    assert.deepEqual(store.restore(cp.id), { 'a.ts': 'one' });

    const mem = new StrategyMemory(join(root, 'memory.json'));
    mem.record('latency', 'slow-fix', false);
    mem.record('latency', 'good-fix', true);
    mem.save();
    assert.deepEqual(new StrategyMemory(join(root, 'memory.json')).ranked('latency'), ['good-fix']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
