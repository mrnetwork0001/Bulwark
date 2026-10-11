import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AutoFixer, proposalProblem, proposeSafely, type FixContext, type Fixer, type SelfFaultReport } from '../bulwark/blue/fixer';
import { getFault } from '../bulwark/chaos/faults';
import { CheckpointStore } from '../bulwark/checkpoints';
import { judge, runAll } from '../bulwark/judge/judge';
import { observeFailure } from '../bulwark/observe/evidence';
import { runExperiment, type ExperimentResult } from '../bulwark/scorecard';
import { flushWithin, parsePlan, SelfFaults } from '../bulwark/selfchaos/faults';
import { runSelfChaos } from '../bulwark/selfchaos/run';
import { loadTarget } from '../bulwark/target';
import { readFiles, Workspace } from '../bulwark/workspace';
import { target as refundbot } from '../targets/refundbot/bulwark.target';

const TARGET_DIR = 'targets/refundbot';
const tmp = () => (mkdirSync('.bulwark', { recursive: true }), mkdtempSync(join('.bulwark', 'test-self-')));

function fixCtx(): FixContext {
  const before = { fault: 'rate-limit', trials: 10, passed: 5, violations: {}, examples: [], outcomes: {} } as unknown as ExperimentResult;
  return { target: 'refundbot', fault: getFault('rate-limit', refundbot), findings: [], files: readFiles(TARGET_DIR, refundbot.editableFiles), before, failed: [], rules: [], preferred: [] };
}

test('self-fault plans: parsed, validated, fired once each at the next or the Nth opportunity', () => {
  assert.deepEqual(parsePlan('blue-llm=429,5xx@3; checkpoint=missing'), { 'blue-llm': ['429', '5xx@3'], checkpoint: ['missing'] });
  assert.throws(() => SelfFaults.parse('disk=full'), /unknown self-fault seam "disk"/);
  assert.throws(() => SelfFaults.parse('blue-llm=418'), /unknown blue-llm self-fault "418"/);
  const sf = SelfFaults.parse('blue-llm=429,5xx@3');
  assert.deepEqual([sf.take('blue-llm'), sf.take('blue-llm'), sf.take('blue-llm'), sf.take('blue-llm')], ['429', undefined, '5xx', undefined]);
  assert.deepEqual(sf.injected.map((i) => `${i.fault}@${i.at}`), ['429@1', '5xx@3']);
  assert.equal(SelfFaults.parse('trial=throw@99').pending()[0].fault, 'throw@99');
  assert.equal(SelfFaults.fromEnv(''), undefined);
});

test('blue-llm seam: a 429, a 5xx and a hung LLM call each fall back to the playbook, and are reported', async () => {
  for (const [fault, why] of [['429', /^429 rate_limit_error/], ['5xx', /^503 overloaded_error/], ['timeout', /timed out after 0s/]] as const) {
    const sf = new SelfFaults({ 'blue-llm': [fault] });
    const reports: SelfFaultReport[] = [];
    const fixer = new AutoFixer({ llm: sf.llm(), llmDeadlineMs: 50, onSelfFault: (r) => reports.push(r) });
    const started = Date.now();
    const p = await fixer.propose(fixCtx());
    assert.ok(Date.now() - started < 2000, 'a hung LLM never stalls Blue');
    assert.equal(p?.author, 'playbook');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].seam, 'blue-llm');
    assert.match(reports[0].fault, why);
    assert.match(reports[0].how, /fell back: playbook proposed/);
  }
});

test('blue-proposal seam: a malformed or empty proposal never reaches the Judge', async () => {
  const ctx = fixCtx();
  assert.equal(proposalProblem({ strategy: 'x', files: { 'agent.ts': 42 } }, ctx.files), "proposal's agent.ts is empty or not text");
  assert.equal(proposalProblem({ strategy: 'x', files: { 'evil.ts': 'x' } }, ctx.files), 'proposal edits evil.ts, which is not an editable file');
  assert.equal(proposalProblem({ strategy: 'x', files: { ...ctx.files } }, ctx.files), 'proposal changes nothing');
  assert.equal(proposalProblem(null, ctx.files), 'proposal is not an object');
  for (const fault of ['malformed', 'empty']) {
    const sf = new SelfFaults({ 'blue-proposal': [fault] });
    const reports: SelfFaultReport[] = [];
    const p = await new AutoFixer({ llm: sf.llm(), onSelfFault: (r) => reports.push(r) }).propose(ctx);
    assert.equal(p?.author, 'playbook');
    assert.equal(proposalProblem(p, ctx.files), undefined);
    assert.equal(reports[0].seam, 'blue-proposal');
  }
  // Without a fault the stand-in LLM's own proposal goes through.
  assert.equal((await new AutoFixer({ llm: new SelfFaults({}).llm() }).propose(ctx))?.author, 'llm-standin');
});

test('a fixer that throws (e.g. --fixer claude on a 429) ends the attempt, not the run', async () => {
  const reports: SelfFaultReport[] = [];
  const boom: Fixer = { name: 'claude-x', propose: async () => Promise.reject(Object.assign(new Error('Too Many Requests'), { status: 429 })) };
  assert.equal(await proposeSafely(boom, fixCtx(), (r) => reports.push(r)), null);
  assert.match(reports[0].fault, /^429 Too Many Requests/);
  assert.match(reports[0].how, /treated as no proposal/);
});

test('checkpoint seam: a corrupt, missing or tampered checkpoint restores the verified in-memory copy', () => {
  const root = tmp();
  try {
    const store = new CheckpointStore(join(root, 'ck'));
    const sf = new SelfFaults({ checkpoint: ['corrupt', 'missing'] });
    const files = { 'agent.ts': 'export const a = 1;\n' };
    for (const fault of ['corrupt', 'missing']) {
      const cp = store.save('t', files);
      assert.equal(sf.checkpoint(store.pathOf(cp.id)), fault);
      const r = store.restoreVerified(cp.id);
      assert.deepEqual(r.files, files);
      assert.match(r.issue!, fault === 'missing' ? /missing/ : /corrupt/);
    }
    const cp = store.save('t', files);
    const raw = JSON.parse(readFileSync(store.pathOf(cp.id), 'utf8'));
    writeFileSync(store.pathOf(cp.id), JSON.stringify({ ...raw, files: { 'agent.ts': 'tampered' } }));
    assert.match(store.restoreVerified(cp.id).issue!, /checksum mismatch/);
    assert.deepEqual(store.restore(cp.id), files);
    // A fresh store has no in-memory copy: an unreadable file is an error, never silently empty files.
    rmSync(store.pathOf(cp.id));
    assert.throws(() => new CheckpointStore(join(root, 'ck')).restoreVerified(cp.id), /cannot restore/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace seam: a patch that does not load is rejected by the Judge without running it', async () => {
  const root = tmp();
  try {
    const opts = { trials: 4, seed: 3, brain: 'simulated' as const, deadlineMs: 1500, maxSteps: 50 };
    const fault = getFault('rate-limit', refundbot);
    const base = await runAll(refundbot, opts);
    const files = readFiles(TARGET_DIR, refundbot.editableFiles);
    const dir = new Workspace(root, TARGET_DIR).materialize('broken', { ...files, 'tools.ts': files['tools.ts'] + '\n// edit\n' });
    assert.equal(new SelfFaults({ workspace: ['syntax-error'] }).workspace(dir, ['tools.ts']), 'syntax-error');
    const v = await judge({ fault, candidate: () => loadTarget(dir), baseResults: base, opts });
    assert.equal(v.status, 'rejected');
    assert.match(v.reasons[0], /^patched code failed to load/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('neatlogs seam: export that hangs and read-back that fails degrade to local evidence within the budget', async () => {
  const down = new SelfFaults({ neatlogs: ['down'] }).neatlogs()!;
  const started = Date.now();
  assert.equal(await flushWithin(down.flush, 50), false);
  assert.equal(await flushWithin(() => Promise.reject(new Error('export failed')), 50), false);
  assert.equal(await flushWithin(async () => true, 50), true);
  const r = await observeFailure({
    fault: 'rate-limit',
    candidates: [{ seed: 1, source: 'before' }],
    waitMs: 300,
    pollMs: 50,
    apiKey: down.apiKey,
    fetcher: down.fetcher,
    rerun: async () => down.traceId,
  });
  assert.equal(r.record.status, 'pending');
  assert.equal(r.evidence, undefined);
  assert.ok(Date.now() - started < 2000);
});

test('trial seam: a worker that throws is re-run from its seed; one that throws again counts as crashed, never dropped', async () => {
  const opts = { trials: 6, seed: 5, brain: 'simulated' as const, deadlineMs: 1500, maxSteps: 50 };
  const clean = await runExperiment(refundbot, undefined, opts);
  const reports: SelfFaultReport[] = [];
  const once = await runExperiment(refundbot, undefined, { ...opts, beforeTrial: new SelfFaults({ trial: ['throw@3'] }).beforeTrial, onSelfFault: (r) => reports.push(r) });
  assert.equal(once.passed, clean.passed, 'the re-run trial is the same trial');
  assert.match(reports[0].how, /re-ran the trial/);
  const twice = await runExperiment(refundbot, undefined, { ...opts, beforeTrial: new SelfFaults({ trial: ['throw-twice@2'] }).beforeTrial, onSelfFault: (r) => reports.push(r) });
  assert.equal(twice.trials, opts.trials);
  assert.equal(twice.passed, clean.passed - 1);
  assert.equal(twice.outcomes.crashed, 1);
  assert.match(reports[1].how, /counted as a crashed trial/);
  // Without a hook, a harness throw used to reject the whole experiment; now it is contained.
  await assert.doesNotReject(runExperiment(refundbot, undefined, { ...opts, trials: 2, beforeTrial: () => { throw new Error('boom'); } }));
});

test('self-chaos loop: every seam faulted at once, every fault recovered, and the run still reaches 100%', async () => {
  const root = tmp();
  try {
    let after: ExperimentResult[] = [];
    const r = await runSelfChaos({
      targetDir: TARGET_DIR,
      deadlineMs: 1500,
      faults: ['prompt-injection', 'stuck-pending'],
      redTrials: 6,
      judgeTrials: 12,
      memory: false,
      readbackWaitMs: 0,
      stateDir: root,
      llmDeadlineMs: 100,
      plan: {
        'blue-llm': ['429', 'timeout'],
        'blue-proposal': ['malformed'],
        checkpoint: ['corrupt'],
        workspace: ['syntax-error@1'],
        neatlogs: ['down'],
        trial: ['throw@3'],
      },
    }, (e) => {
      if (e.type === 'scorecard' && e.phase === 'after') after = e.results;
    });
    assert.equal(r.totals.injected, 7, JSON.stringify(r.notInjected));
    assert.equal(r.totals.recovered, 7, JSON.stringify(r.seams, null, 1));
    assert.deepEqual(r.organic, []);
    for (const id of ['baseline', 'prompt-injection', 'stuck-pending']) {
      const x = after.find((a) => a.fault === id)!;
      assert.equal(x.passed, x.trials, id);
    }
    assert.deepEqual(r.summary.fixed.sort(), ['prompt-injection', 'stuck-pending']);
    assert.ok(existsSync(join(r.summary.dir, 'summary.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
