import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getFault } from '../bulwark/chaos/faults';
import {
  collectIncidents,
  incidentSpecs,
  incidentsFromTrace,
  loadRunSummaries,
  sweepIncidents,
  traceIncidents,
  traceRefs,
  writeIncidentSpecs,
  type RunSummary,
} from '../bulwark/incidents';
import type { Fetcher, NeatlogsTrace } from '../bulwark/observe/neatlogs';
import { runExperiment } from '../bulwark/scorecard';
import { target } from '../targets/refundbot/bulwark.target';

const runA: RunSummary = {
  runId: '2026-10-11T04-41-17-678Z',
  target: 'refundbot',
  targetHash: 'h1',
  before: {
    baseline: { examples: [], perTrial: [{ seed: 1, outcome: 'completed', passed: true }] },
    'timeout-after-commit': {
      examples: [{ rule: 'Never refund an order more than once.', seed: 11, traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      perTrial: [
        { seed: 10, outcome: 'completed', passed: true },
        { seed: 11, outcome: 'completed', passed: false },
        { seed: 12, outcome: 'crashed', passed: false },
      ],
    },
  },
  records: [{ fault: 'timeout-after-commit', observe: { traceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', seed: 12 } }],
};
// An older run: examples only, the same failure seen again, plus a new one.
const runB: RunSummary = {
  runId: '2026-10-10T11-02-29-298Z',
  target: 'refundbot',
  before: {
    'timeout-after-commit': { examples: [{ rule: 'Never refund more than the order total.', seed: 11 }] },
    'rate-limit': { examples: [{ rule: 'Every ticket gets a reply to the customer.', seed: 7 }] },
  },
};

test('collector: distinct failing (target, fault, seed) from perTrial and examples, merged across runs', () => {
  const xs = collectIncidents([runB, runA]);
  assert.deepEqual(
    xs.map((x) => `${x.fault}:${x.seed}`),
    ['rate-limit:7', 'timeout-after-commit:11', 'timeout-after-commit:12'],
  );
  const dup = xs.find((x) => x.seed === 11)!;
  assert.deepEqual(dup.rules.sort(), ['Never refund an order more than once.', 'Never refund more than the order total.']);
  assert.deepEqual(dup.seenIn.sort(), ['run 2026-10-10T11-02-29-298Z', 'run 2026-10-11T04-41-17-678Z']);
  assert.deepEqual(dup.targetHashes, ['h1']);
  assert.ok(!xs.some((x) => x.seed === 10 || x.fault === 'baseline'), 'passing trials are not incidents');
});

test('loadRunSummaries: --run, --last, and plain names only', () => {
  const state = mkdtempSync(join(tmpdir(), 'bulwark-incidents-'));
  try {
    for (const s of [runA, runB]) {
      mkdirSync(join(state, 'runs', s.runId), { recursive: true });
      writeFileSync(join(state, 'runs', s.runId, 'summary.json'), JSON.stringify(s));
    }
    mkdirSync(join(state, 'runs', '2026-10-11T09-00-00-000Z')); // a crashed run: no summary.json
    assert.deepEqual(loadRunSummaries(state).map((s) => s.runId), [runB.runId, runA.runId]);
    assert.deepEqual(loadRunSummaries(state, { last: 1 }).map((s) => s.runId), [runA.runId]);
    assert.deepEqual(loadRunSummaries(state, { run: runB.runId }).map((s) => s.runId), [runB.runId]);
    assert.throws(() => loadRunSummaries(state, { run: '../x' }), /plain run id/);
    assert.throws(() => loadRunSummaries(state, { run: 'nope' }), /no run nope/);
    assert.deepEqual(loadRunSummaries(join(state, 'missing')), []);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('traceRefs: trace ids from scorecard examples and observe steps, with the failing seeds', () => {
  const refs = traceRefs([runA, runB]);
  assert.deepEqual(
    refs.map((r) => [r.traceId.slice(0, 4), r.failing]),
    [
      ['aaaa', ['timeout-after-commit:11']],
      ['bbbb', ['timeout-after-commit:12']],
    ],
  );
});

// A phase trace in the neatlogs v3 shape: one experiment, three traced trials.
const phaseTrace: NeatlogsTrace = {
  _id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: '2 red: attack scorecard BEFORE',
  spans: [
    { span_id: 'root', node_type: 'workflow', node_name: '2 red: attack scorecard BEFORE', status: 'SUCCESS' },
    { span_id: 'exp', parent_span_id: 'root', node_name: 'experiment: timeout-after-commit', status: 'SUCCESS' },
    // Known failing from the run (seed 11), clean spans.
    { span_id: 't11', parent_span_id: 'exp', node_name: 'bulwark.trial', status: 'SUCCESS', span_metadata: { fault: 'timeout-after-commit', seed: 11 } },
    // Not in the run's examples, but a tool call under it errored: still an incident.
    { span_id: 't21', parent_span_id: 'exp', node_name: 'bulwark.trial', status: 'SUCCESS', data: { attributes: { fault: 'timeout-after-commit', seed: '21' } } },
    { span_id: 'tool', parent_span_id: 't21', node_type: 'tool_call', node_name: 'issue_refund', status: 'ERROR', data: { error_message: 'aborted' } },
    // A passing trial: not an incident.
    { span_id: 't30', parent_span_id: 'exp', node_name: 'bulwark.trial', status: 'SUCCESS', span_metadata: { fault: 'timeout-after-commit', seed: 30 } },
    // A no-fault trial with a neatlogs detection: a baseline incident.
    { span_id: 't40', parent_span_id: 'root', node_name: 'bulwark.trial', status: 'SUCCESS', span_metadata: { fault: 'none', seed: 40 }, detections: [{ type: 'loop' }] },
    // Junk attributes are ignored.
    { span_id: 'tx', parent_span_id: 'root', node_name: 'bulwark.trial', status: 'ERROR', span_metadata: { fault: '../x', seed: 5 } },
    { span_id: 'ty', parent_span_id: 'root', node_name: 'bulwark.trial', status: 'ERROR', span_metadata: { fault: 'rate-limit', seed: -1 } },
  ],
};

test('trace parser: failing bulwark.trial spans become (fault, seed) incidents', () => {
  const found = incidentsFromTrace(phaseTrace, { target: 'refundbot', failing: ['timeout-after-commit:11'] });
  assert.deepEqual(
    found.map((f) => [f.fault, f.seed, f.why]),
    [
      ['timeout-after-commit', 11, 'recorded as failing by its run'],
      ['timeout-after-commit', 21, 'a span in the trial errored'],
      ['baseline', 40, 'neatlogs flagged a detection'],
    ],
  );
});

test('trace read-back with a mocked fetch: one trace read, one pending, one dead-lettered', async () => {
  const prev = process.env.NEATLOGS_API_KEY;
  process.env.NEATLOGS_API_KEY = 'test-key';
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers['x-api-key'], 'test-key');
    const id = url.split('/').pop()!;
    if (id.startsWith('aaaa')) return { status: 200, json: async () => phaseTrace };
    if (id.startsWith('bbbb')) return { status: 202, json: async () => ({ _id: id, finalizationStatus: 'pending', spans: [] }) };
    return { status: 409, json: async () => ({ finalizationStatus: 'dlq' }) };
  };
  try {
    const refs = [...traceRefs([runA]), { traceId: 'cccccccccccccccccccccccccccccccc', target: 'refundbot', runs: ['r'], failing: [] }];
    const { reads, incidents } = await traceIncidents(refs, { fetcher, waitMs: 0 });
    assert.equal(calls.length, 3, 'each trace read once, no waiting');
    assert.deepEqual(reads.map((r) => [r.status, r.http, r.trialSpans, r.incidents]), [
      ['read', 200, 6, 3],
      ['pending', 202, 0, 0],
      ['unavailable', 409, 0, 0],
    ]);
    assert.deepEqual(incidents.map((i) => `${i.fault}:${i.seed}`), ['baseline:40', 'timeout-after-commit:11', 'timeout-after-commit:21']);
    assert.ok(incidents.every((i) => i.seenIn.includes('neatlogs trace aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')));

    // Merged with the run-summary incidents: seed 11 is one incident seen in both sources.
    const pool = new Map();
    collectIncidents([runA], pool);
    const merged = await traceIncidents(traceRefs([runA]).slice(0, 1), { fetcher, into: pool });
    const s11 = merged.incidents.find((i) => i.seed === 11)!;
    assert.deepEqual(s11.seenIn, ['run 2026-10-11T04-41-17-678Z', 'neatlogs trace aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    assert.equal(merged.incidents.length, 4);

    delete process.env.NEATLOGS_API_KEY;
    const none = await traceIncidents(refs, { fetcher });
    assert.ok(none.reads.every((r) => r.status === 'unavailable' && /NEATLOGS_API_KEY/.test(r.reason ?? '')));
  } finally {
    if (prev === undefined) delete process.env.NEATLOGS_API_KEY;
    else process.env.NEATLOGS_API_KEY = prev;
  }
});

test('sweep re-runs real incidents: double refunds still fail on the current code; unknown faults are skipped; specs replay the exact seeds', async () => {
  const r = await runExperiment(target, getFault('timeout-after-commit'), { trials: 10, seed: 42, brain: 'simulated', deadlineMs: 5000, maxSteps: 50 });
  const failing = r.perTrial.filter((t) => !t.passed).map((t) => t.seed);
  const passing = r.perTrial.find((t) => t.passed)!.seed;
  assert.ok(failing.length >= 2);
  const inc = (fault: string, seed: number) => ({ target: 'refundbot', fault, seed, rules: [], seenIn: ['test'], targetHashes: [] });
  const { results } = await sweepIncidents([inc('timeout-after-commit', failing[0]), inc('timeout-after-commit', failing[1]), inc('timeout-after-commit', passing), inc('no-such-fault', 1), { ...inc('rate-limit', 1), target: 'nope' }]);
  assert.deepEqual(results.map((x) => x.status), ['still-fails', 'still-fails', 'fixed', 'skipped', 'skipped']);
  assert.match(results[3].reason!, /unknown fault/);
  assert.match(results[4].reason!, /unknown target/);

  const specs = incidentSpecs(results);
  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0].spec.seeds, [...failing.slice(0, 2)].sort((a, b) => a - b));
  assert.equal(specs[0].spec.trials, 2);
  assert.equal(specs[0].path, 'chaos-tests/incident-timeout-after-commit.json');

  const dir = mkdtempSync(join(tmpdir(), 'bulwark-specs-'));
  try {
    const [file] = writeIncidentSpecs(specs, dir);
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(spec.createdBy, 'bulwark');
    // The spec reproduces exactly those incidents: every trial fails on the unfixed code.
    const replay = await runExperiment(target, getFault(spec.fault), { trials: spec.seeds.length, seed: spec.seed, seeds: spec.seeds, brain: 'simulated', deadlineMs: 5000, maxSteps: 50 });
    assert.deepEqual(replay.perTrial.map((t) => t.seed), spec.seeds);
    assert.equal(replay.passed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The shape neatlogs actually returns for a finalized Bulwark phase trace (checked against trace
// 27c7249e… on Oct 11): span_metadata is null, so fault and seed come from the experiment parent and
// the trial's output text.
const realShape: NeatlogsTrace = {
  _id: 'dddddddddddddddddddddddddddddddd',
  spans: [
    { span_id: 'root', node_name: '2 red: attack scorecard BEFORE', node_type: 'workflow', status: 'SUCCESS', span_metadata: undefined },
    { span_id: 'e1', parent_span_id: 'root', node_name: 'experiment: latency-spike', status: 'SUCCESS' },
    { span_id: 'e2', parent_span_id: 'root', node_name: 'experiment: timeout-after-commit', status: 'SUCCESS' },
    { span_id: 'e0', parent_span_id: 'root', node_name: 'experiment: baseline', status: 'SUCCESS' },
    { span_id: 'a', parent_span_id: 'e1', node_name: 'bulwark.trial', node_type: 'chain', status: 'SUCCESS', data: { output_value: 'Seed: 2657296630\nOutcome: hung\nDurationMs: 5002\nSteps: 1', error_message: '' } },
    { span_id: 'b', parent_span_id: 'e2', node_name: 'bulwark.trial', node_type: 'chain', status: 'SUCCESS', data: { output_value: 'Seed: 3886347927\nOutcome: completed\nSteps: 5', error_message: '' } },
    { span_id: 'c', parent_span_id: 'e2', node_name: 'bulwark.trial', node_type: 'chain', status: 'SUCCESS', data: { output_value: 'Seed: 3869570308\nOutcome: completed\nSteps: 5', error_message: '' } },
    { span_id: 'c1', parent_span_id: 'c', node_name: 'issue_refund', node_type: 'tool_call', status: 'SUCCESS', data: { error_message: '' } },
    { span_id: 'z', parent_span_id: 'e0', node_name: 'bulwark.trial', node_type: 'chain', status: 'SUCCESS', data: { output_value: 'Seed: 1606880409\nOutcome: completed' } },
  ],
};

test('trace parser, real neatlogs shape: fault from the experiment span, seed and outcome from the output text', async () => {
  const { trialInfo, focusTrial } = await import('../bulwark/observe/neatlogs');
  assert.deepEqual(trialInfo(realShape.spans![4], realShape.spans!), { fault: 'latency-spike', seed: 2657296630, outcome: 'hung' });
  const found = incidentsFromTrace(realShape, { target: 'refundbot', failing: ['timeout-after-commit:3869570308'] });
  assert.deepEqual(found.map((f) => [f.fault, f.seed, f.why]), [
    ['latency-spike', 2657296630, 'the trial hung'],
    ['timeout-after-commit', 3869570308, 'recorded as failing by its run'],
  ]);
  // focusTrial narrows this shape too (it used to fall back to the whole trace).
  assert.deepEqual(focusTrial(realShape, { fault: 'timeout-after-commit', seed: 3869570308 }).map((s) => s.span_id), ['c', 'c1']);
});
