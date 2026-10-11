// neatlogs read-back (bulwark/observe) and Entire Graph (bulwark/red/graph), with mocked fetch and runner.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixPrompt, type FixContext } from '../bulwark/blue/fixer';
import { getFault } from '../bulwark/chaos/faults';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFiles, previousFailures } from '../bulwark/loop/orchestrator';
import { describeObserve, observeFailure, recheckPending, type ObserveRecord } from '../bulwark/observe/evidence';
import { focusTrial, readTrace, summarizeTrace, type Fetcher, type NeatlogsTrace } from '../bulwark/observe/neatlogs';
import { attachBlast, describeBlast, EntireGraph, graphFor, type Runner } from '../bulwark/red/graph';
import type { ExperimentResult } from '../bulwark/scorecard';

const withKey = async <T>(key: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.NEATLOGS_API_KEY;
  if (key === undefined) delete process.env.NEATLOGS_API_KEY;
  else process.env.NEATLOGS_API_KEY = key;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NEATLOGS_API_KEY;
    else process.env.NEATLOGS_API_KEY = prev;
  }
};

/** Replies with each response in turn, then repeats the last one. */
function scripted(responses: { status: number; body?: unknown }[]): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(`${url} ${init.headers['x-api-key']}`);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { status: r.status, json: async () => r.body ?? {} };
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

// A phase trace holding two trials; only the seed-7 trial (and its tool span) should be picked.
const PHASE: NeatlogsTrace = {
  _id: 'abc123',
  name: '2 red: attack scorecard BEFORE',
  status: 'success',
  detections: [],
  spans: [
    { span_id: 'root', node_type: 'workflow', node_name: '2 red: attack scorecard BEFORE', createdAt: '1' },
    { span_id: 'exp', parent_span_id: 'root', node_type: 'workflow', node_name: 'experiment: timeout-after-commit', createdAt: '2' },
    { span_id: 'tool8', parent_span_id: 't8', node_type: 'tool_call', node_name: 'issue_refund', createdAt: '3', data: { input_value: '{"orderId":"ord_1001"}' } },
    { span_id: 't8', parent_span_id: 'exp', node_type: 'chain', node_name: 'bulwark.trial', span_metadata: { seed: 8, fault: 'timeout-after-commit' }, createdAt: '3' },
    { span_id: 't7', parent_span_id: 'exp', node_type: 'chain', node_name: 'bulwark.trial', span_metadata: { seed: 7, fault: 'timeout-after-commit' }, createdAt: '4' },
    {
      span_id: 'tool7',
      parent_span_id: 't7',
      node_type: 'tool_call',
      node_name: 'issue_refund',
      status: 'ERROR',
      createdAt: '5',
      detections: [{ type: 'error', message: 'timed out' }],
      data: { input_value: '{"orderId":"ord_1001","amount":49}', duration_ms: 812.4, error_type: 'Error', error_message: 'timed out after 800ms' },
    },
  ],
};

test('readTrace: unavailable without a key, and never calls neatlogs', async () => {
  const f = scripted([{ status: 200, body: PHASE }]);
  const r = await withKey(undefined, () => readTrace('abc123', { fetcher: f }));
  assert.equal(r.status, 'unavailable');
  assert.equal(f.calls.length, 0);
});

test('readTrace: polls through 404 and 202 pending until 200 with spans', async () => {
  const f = scripted([{ status: 404 }, { status: 202, body: { finalizationStatus: 'pending', spans: [] } }, { status: 200, body: PHASE }]);
  const r = await withKey('k', () => readTrace('abc123', { fetcher: f, waitMs: 5000, pollMs: 1 }));
  assert.equal(r.status, 'read');
  assert.equal(r.trace?.spans?.length, 6);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[0], /\/api\/traces\/v3\/abc123 k$/);
});

test('readTrace: pending when the wait budget runs out, with the last stage', async () => {
  const f = scripted([{ status: 202, body: { finalizationStatus: 'pending', spans: [] } }]);
  const r = await withKey('k', () => readTrace('abc123', { fetcher: f, waitMs: 30, pollMs: 5 }));
  assert.equal(r.status, 'pending');
  assert.equal(r.stage, 'pending');
  assert.ok(f.calls.length >= 2);
});

test('readTrace: a rejected key and a dead-lettered trace are unavailable, not retried', async () => {
  for (const [status, body] of [[401, {}], [409, { finalizationStatus: 'dlq', error: 'Trace processing failed' }]] as const) {
    const f = scripted([{ status, body }]);
    const r = await withKey('k', () => readTrace('abc123', { fetcher: f, waitMs: 5000, pollMs: 1 }));
    assert.equal(r.status, 'unavailable');
    assert.equal(f.calls.length, 1);
  }
});

test('focusTrial narrows a phase trace to one trial and its descendants', () => {
  const spans = focusTrial(PHASE, { fault: 'timeout-after-commit', seed: 7 });
  assert.deepEqual(spans.map((s) => s.span_id).sort(), ['t7', 'tool7']);
  // Unknown seed: keep the whole trace rather than nothing.
  assert.equal(focusTrial(PHASE, { seed: 99 }).length, 6);
});

test('summarizeTrace lists detections, then the trial timeline with input, duration and error', () => {
  const s = summarizeTrace(PHASE, { focus: { fault: 'timeout-after-commit', seed: 7 } });
  assert.match(s, /2 of 6 spans: the trial with seed 7/);
  assert.match(s, /neatlogs detection: .*timed out/);
  assert.match(s, /tool_call issue_refund status=ERROR 812ms input=\{"orderId":"ord_1001","amount":49\} error=Error: timed out after 800ms/);
  assert.doesNotMatch(s, /seed 8/);
});

test('observeFailure: reads the first traced candidate and digests the failing trial', async () => {
  const f = scripted([{ status: 200, body: PHASE }]);
  const { record, evidence } = await withKey('k', () =>
    observeFailure({ fault: 'timeout-after-commit', candidates: [{ seed: 3, source: 'before' }, { seed: 7, traceId: 'abc123', source: 'before' }], waitMs: 1000, pollMs: 1, fetcher: f }),
  );
  assert.equal(record.status, 'read');
  assert.equal(record.seed, 7);
  assert.equal(record.spans, 2);
  assert.equal(record.detections, 1);
  assert.match(evidence!, /issue_refund/);
  assert.equal(describeObserve(record), 'Diagnosed from neatlogs trace abc123 (2 spans, 1 detections; failing trial seed 7 from the BEFORE scorecard).');
});

test('observeFailure: re-runs a failing seed traced when no sample trial failed', async () => {
  const f = scripted([{ status: 200, body: PHASE }]);
  const reran: number[] = [];
  const { record } = await withKey('k', () =>
    observeFailure({
      fault: 'timeout-after-commit',
      candidates: [{ seed: 7, source: 'before' }],
      rerun: async (seed) => (reran.push(seed), 'abc123'),
      waitMs: 1000,
      pollMs: 1,
      fetcher: f,
    }),
  );
  assert.deepEqual(reran, [7]);
  assert.equal(record.source, 'rerun');
  assert.equal(record.status, 'read');
});

test('observeFailure: no key or wait 0 means unavailable, without re-running anything', async () => {
  const rerun = async () => assert.fail('must not re-run');
  for (const [key, waitMs, reason] of [[undefined, 20_000, /NEATLOGS_API_KEY not set/], ['k', 0, /disabled/]] as const) {
    const { record } = await withKey(key, () => observeFailure({ fault: 'x', candidates: [{ seed: 1, source: 'before' }], rerun, waitMs }));
    assert.equal(record.status, 'unavailable');
    assert.match(describeObserve(record), reason);
  }
});

test('observeFailure: a pending trace is re-checked once later, not waited on again', async () => {
  const f = scripted([{ status: 202, body: { finalizationStatus: 'pending', spans: [] } }]);
  const cache = new Map();
  const opts = { candidates: [{ seed: 7, traceId: 'abc123', source: 'before' as const }], waitMs: 40, pollMs: 5, fetcher: f, cache };
  const first = await withKey('k', () => observeFailure({ fault: 'a', ...opts }));
  const callsAfterFirst = f.calls.length;
  const second = await withKey('k', () => observeFailure({ fault: 'b', ...opts }));
  assert.equal(first.record.status, 'pending');
  assert.equal(second.record.status, 'pending');
  assert.equal(f.calls.length - callsAfterFirst, 1);
  assert.match(describeObserve(first.record), /not finalized in time.*used local evidence/);
});

test("observeFailure: the previous run's trace gets one check; if it isn't there, this run's trace gets the wait", async () => {
  // old trace: dead-lettered (409). this run's trace: pending once, then finalized.
  const byId: Record<string, { status: number; body?: unknown }[]> = {
    old: [{ status: 409, body: { finalizationStatus: 'dlq' } }],
    abc123: [{ status: 202, body: { finalizationStatus: 'pending', spans: [] } }, { status: 200, body: PHASE }],
  };
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    const id = url.split('/').pop()!;
    calls.push(id);
    const list = byId[id];
    const r = list[Math.min(calls.filter((c) => c === id).length - 1, list.length - 1)];
    return { status: r.status, json: async () => r.body ?? {} };
  };
  const { record } = await withKey('k', () =>
    observeFailure({
      fault: 'timeout-after-commit',
      candidates: [
        { seed: 7, traceId: 'old', source: 'previous' },
        { seed: 7, traceId: 'abc123', source: 'before' },
      ],
      waitMs: 1000,
      pollMs: 1,
      fetcher,
    }),
  );
  assert.deepEqual(calls, ['old', 'abc123', 'abc123']);
  assert.equal(record.status, 'read');
  assert.equal(record.source, 'before');
});

test('observeFailure: a finalized previous-run trace is used without waiting', async () => {
  const f = scripted([{ status: 200, body: PHASE }]);
  const { record } = await withKey('k', () =>
    observeFailure({ fault: 'timeout-after-commit', candidates: [{ seed: 7, traceId: 'abc123', source: 'previous' }, { seed: 7, traceId: 'new', source: 'before' }], waitMs: 1000, fetcher: f }),
  );
  assert.equal(f.calls.length, 1);
  assert.match(describeObserve(record), /from the previous run's BEFORE scorecard \(same code, same seed\)/);
});

test('recheckPending: a trace that finalized after Blue ran is recorded as a late read', async () => {
  const f = scripted([{ status: 200, body: PHASE }]);
  const r = { fault: 'timeout-after-commit', traceId: 'abc123', seed: 7, source: 'before' as const, status: 'pending' as const, spans: 0, detections: 0, waitedMs: 20_000 };
  const records: ObserveRecord[] = [r, { ...r, fault: 'x', status: 'unavailable', traceId: undefined }];
  assert.equal(await withKey('k', () => recheckPending(records, { fetcher: f })), 1);
  assert.equal(records[0].status, 'read');
  assert.equal(records[0].spans, 2);
  assert.match(describeObserve(records[0]), /finalized only after Blue ran \(2 spans, 1 detections.*Blue used local evidence/);
  assert.equal(f.calls.length, 1);
});

test("previousFailures: uses the last run's traced failures only when the target code is unchanged", () => {
  const state = mkdtempSync(join(tmpdir(), 'bulwark-prev-'));
  try {
    const files = { 'tools.ts': 'a', 'agent.ts': 'b' };
    const hash = hashFiles(files);
    assert.equal(hash, hashFiles({ 'agent.ts': 'b', 'tools.ts': 'a' }));
    assert.notEqual(hash, hashFiles({ ...files, 'tools.ts': 'changed' }));
    assert.deepEqual(previousFailures(state, hash), {}); // no previous run
    const run = join(state, 'runs', 'r1');
    mkdirSync(run, { recursive: true });
    const before = { 'timeout-after-commit': { examples: [{ rule: 'r', seed: 7, traceId: 'abc123' }, { rule: 's', seed: 9 }] } };
    writeFileSync(join(run, 'summary.json'), JSON.stringify({ targetHash: hash, before }));
    writeFileSync(join(state, 'latest.json'), JSON.stringify({ dir: run }));
    assert.deepEqual(previousFailures(state, hash), { 'timeout-after-commit': [{ seed: 7, traceId: 'abc123' }] });
    assert.deepEqual(previousFailures(state, hashFiles({ ...files, 'tools.ts': 'changed' })), {});
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

// ── Entire Graph ──────────────────────────────────────────

const IMPACT = {
  focus: { name: 'createTools', kind: 'function', file_path: 'targets/refundbot/tools.ts', start_line: 76 },
  callers: {
    entries: [
      { endpoint: { name: 'runRefundBot', kind: 'function', file_path: 'targets/refundbot/agent.ts' }, call_site: { file_path: 'targets/refundbot/agent.ts', line: 54 } },
      { endpoint: { name: 'PR.md', kind: 'file', file_path: 'docs/evidence/PR.md' } },
    ],
  },
  callees: { entries: [] },
};
const SEARCH = {
  results: [
    { file_path: 'bulwark/blue/playbook.ts', start_line: 75, end_line: 79, score: 30, snippet: 'playbook' },
    { file_path: 'targets/refundbot/tools.ts', start_line: 51, end_line: 59, symbol_name: 'withTimeout', score: 24.4, snippet: 'function withTimeout() {}' },
    { file_path: 'targets/refundbot/payments.ts', start_line: 55, end_line: 60, symbol_name: 'createRefund', score: 20, snippet: 'createRefund() {}' },
  ],
};

function fakeEntire(): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((args: string[]) => {
    calls.push(args);
    if (args[0] === 'version') return { status: 0, stdout: 'v0.4.0', stderr: '' };
    if (args[0] === 'impact') return { status: 0, stdout: JSON.stringify(IMPACT), stderr: '' };
    if (args[0] === 'search') return { status: 0, stdout: JSON.stringify(SEARCH), stderr: '' };
    return { status: 1, stdout: '', stderr: 'unknown' };
  }) as unknown as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}

test('graph impact keeps code callers only; attachBlast queries each line once', () => {
  const run = fakeEntire();
  const graph = new EntireGraph('.', run);
  const findings = [
    { file: 'tools.ts', line: 87 },
    { file: 'tools.ts', line: 87 },
    { file: 'agent.ts', line: 56 },
  ] as { file: string; line: number; blast?: { focus: never; callers: never[] } }[];
  assert.equal(attachBlast(findings, graph, 'targets/refundbot'), 3);
  const impacts = run.calls.filter((a) => a[0] === 'impact').map((a) => a[2]);
  assert.deepEqual(impacts, ['targets/refundbot/tools.ts:87', 'targets/refundbot/agent.ts:56']);
  const b = findings[0].blast!;
  assert.equal(describeBlast(b), 'createTools (function, targets/refundbot/tools.ts:76) ← 1 caller: runRefundBot (targets/refundbot/agent.ts:54)');
});

test('graph search keeps only hits inside the target', () => {
  const s = new EntireGraph('.', fakeEntire()).search('refund retried twice', 3, 'targets/refundbot')!;
  assert.doesNotMatch(s, /playbook/);
  assert.match(s, /^1\. targets\/refundbot\/tools\.ts:51-59 withTimeout \(score 24\.4\)\nfunction withTimeout/);
  assert.match(s, /2\. targets\/refundbot\/payments\.ts:55-60 createRefund/);
});

test('graph degrades: plugin missing, failing command, or BULWARK_ENTIRE_GRAPH=0', () => {
  const missing: Runner = () => ({ status: null, stdout: '', stderr: 'ENOENT' });
  assert.equal(graphFor('.', missing), undefined);
  const g = new EntireGraph('.', missing);
  assert.equal(g.impact('targets/refundbot/tools.ts', 87), null);
  assert.equal(g.search('anything'), null);
  const findings = [{ file: 'tools.ts', line: 87 }];
  assert.equal(attachBlast(findings, undefined, 'targets/refundbot'), 0);

  process.env.BULWARK_ENTIRE_GRAPH = '0';
  try {
    const run = fakeEntire();
    assert.equal(graphFor('.', run), undefined);
    assert.equal(run.calls.length, 0);
  } finally {
    delete process.env.BULWARK_ENTIRE_GRAPH;
  }
  assert.ok(graphFor('.', fakeEntire()));
});

test('Blue prompt carries the neatlogs and Entire Graph sections only when present', () => {
  const before = { passed: 1, trials: 2, violations: {}, examples: [], outcomes: {} } as unknown as ExperimentResult;
  const ctx: FixContext = { fault: getFault('timeout-after-commit'), findings: [], files: { 'tools.ts': 'x' }, before, failed: [], rules: [], preferred: [] };
  assert.doesNotMatch(buildFixPrompt(ctx), /neatlogs recorded|Entire Graph/);
  const p = buildFixPrompt({ ...ctx, neatlogsEvidence: 'neatlogs trace abc123', graphHints: '1. targets/refundbot/tools.ts:51-59 withTimeout' });
  assert.match(p, /## What neatlogs recorded for a failing trial\nneatlogs trace abc123/);
  assert.match(p, /## Where Entire Graph says to look\n.*\n1\. targets\/refundbot\/tools\.ts:51-59/);
});
