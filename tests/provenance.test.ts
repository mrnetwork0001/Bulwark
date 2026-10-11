import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  attachProvenance,
  checkpointRef,
  describeProvenance,
  findTranscriptWrites,
  parseBlamePorcelain,
  parseCheckpointTrailer,
  parseEntireWhy,
  parseSessionMetadata,
  promptHeadline,
  summarizeProvenance,
  traceLine,
  type Runner,
  type RunResult,
} from '../bulwark/provenance/entire';
import type { Finding } from '../bulwark/red/analyze';
import { postmortem, prBody, type FaultRecord } from '../bulwark/report/reports';

// Fixtures below are trimmed copies of real output from this repo (Entire CLI 0.11.4).
const LINE = "            transport('refunds.create', { orderId: input.orderId, amount: input.amount }),";
const SHA = 'cf0ceacfd5acea2271f21550aedd8d593e02c6f5';
const PARENT_DATE = '2026-10-10T08:00:00+00:00';
const BLAME = [
  `${SHA} 87 87 1`,
  'author mrnetwork0001',
  'author-mail <emma40mike@gmail.com>',
  'author-time 1791624018',
  'author-tz +0200',
  'summary RefundBot target, chaos fault catalog, plain-English invariants, and honest scorecard',
  'filename targets/refundbot/tools.ts',
  `\t${LINE}`,
  '',
].join('\n');
const CP = '01M4MGGKEQXJR07RTC3SAJQ3P8';
const WHY_AI = JSON.stringify({
  file: 'docs/FEATURES.md',
  line: {
    line_number: 68,
    authorship: 'ai',
    commit_sha: 'e44db55035b826903241b22d91fc864479255dc3',
    author: 'mrnetwork0001',
    author_time: '2026-10-11T03:36:11Z',
    checkpoint_id: CP,
    session_id: '8cdad8b4-3584-46b2-b505-0bcea4d9fb5b',
    agent: 'Claude Code',
    model: 'claude-opus-5-5',
    prompt: 'lets build all. of these and be sure it works:\n\n<pasted_content id="e961">\nlots\n</pasted_content id="e961">\n\ndeploy multiple agents to take up these tasks',
  },
  checkpoints: {},
});
const WHY_HUMAN = JSON.stringify({ file: 'targets/refundbot/tools.ts', line: { line_number: 87, authorship: 'human', commit_sha: SHA, author: 'mrnetwork0001', author_time: '2026-10-10T09:20:18Z' } });
const SESSION_META = (id: string, created: string, start?: number) =>
  JSON.stringify({ checkpoint_id: id, session_id: 'sess-1', agent: 'Claude Code', model: 'claude-opus-5-5', created_at: created, checkpoint_transcript_start: start, strategy: 'import' });
const write = (ts: string, path: string, content: string, name = 'Write') =>
  JSON.stringify({ timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name, input: { file_path: path, content } }] } });
const TRANSCRIPT = [
  JSON.stringify({ timestamp: '2026-10-10T09:14:22Z', message: { role: 'user', content: 'start building something for this app' } }),
  write('2026-10-10T09:17:08Z', '/Users/x/Bulwark/targets/refundbot/tools.ts', `function f() {\n${LINE}\n}`),
  JSON.stringify({ timestamp: '2026-10-10T10:37:42Z', message: { role: 'user', content: 'launch the localhost' } }),
  // Written after the commit: must not count.
  write('2026-10-10T10:40:00Z', '/Users/x/Bulwark/targets/refundbot/tools.ts', LINE),
].join('\n');

/** A fake shell: maps "cmd arg arg" to output. Unknown commands fail. */
function fakeRunner(table: Record<string, string | { missing: true } | { fail: string }>): Runner & { calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (cmd, args): RunResult => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    const hit = table[key] ?? (cmd === 'entire' ? table['entire *'] : undefined);
    if (hit === undefined) return { ok: false, stdout: '', stderr: `unexpected: ${key}` };
    if (typeof hit === 'string') return { ok: true, stdout: hit, stderr: '' };
    if ('missing' in hit) return { ok: false, stdout: '', stderr: 'spawn ENOENT', missing: true };
    return { ok: false, stdout: '', stderr: hit.fail };
  };
  return Object.assign(run, { calls });
}

const GIT_BASE = {
  'git rev-parse --show-toplevel': '/repo\n',
  'git blame --porcelain -L 87,87 -- targets/refundbot/tools.ts': BLAME,
  [`git log -1 --format=%aI ${SHA}^`]: `${PARENT_DATE}\n`,
};
const opts = (run: Runner) => ({ run, cwd: '/repo', entireBin: 'entire' });

test('parsers: blame porcelain, checkpoint trailer, shard ref, session metadata', () => {
  const b = parseBlamePorcelain(BLAME)!;
  assert.equal(b.commit, SHA);
  assert.equal(b.author, 'mrnetwork0001');
  assert.equal(b.date, '2026-10-10T09:20:18.000Z');
  assert.match(b.subject, /^RefundBot target/);
  assert.equal(b.content, LINE);
  assert.equal(parseBlamePorcelain('fatal: no such path'), undefined);

  assert.equal(parseCheckpointTrailer(`Enable Entire\n\nEntire-Checkpoint: ${CP}\n`), CP);
  assert.equal(parseCheckpointTrailer('No trailer here\n\nCo-Authored-By: someone'), undefined);
  assert.equal(checkpointRef(CP), `refs/entire/checkpoints/P8/${CP}`);

  const m = parseSessionMetadata(SESSION_META('01ABC', '2026-10-10T09:14:22Z', 146))!;
  assert.deepEqual([m.checkpointId, m.sessionId, m.agent, m.transcriptStart], ['01ABC', 'sess-1', 'Claude Code', 146]);
  assert.equal(parseSessionMetadata('not json'), undefined);
});

test('parsers: entire why JSON, with and without a checkpoint', () => {
  const ai = parseEntireWhy(WHY_AI)!;
  assert.equal(ai.checkpointId, CP);
  assert.equal(ai.agent, 'Claude Code');
  const human = parseEntireWhy(WHY_HUMAN)!;
  assert.equal(human.checkpointId, undefined);
  assert.equal(human.commit, SHA);
  assert.equal(parseEntireWhy('{"oops":1}'), undefined);
  assert.equal(parseEntireWhy('garbage'), undefined);
});

test('transcript writes: exact line text, file suffix, Write/Edit/MultiEdit', () => {
  const edit = JSON.stringify({ timestamp: 't2', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/targets/refundbot/tools.ts', old_string: 'x', new_string: `  ${LINE.trim()}` } }] } });
  const multi = JSON.stringify({ timestamp: 't3', message: { content: [{ type: 'tool_use', name: 'MultiEdit', input: { file_path: '/a/targets/refundbot/tools.ts', edits: [{ new_string: LINE }] } }] } });
  const other = write('t4', '/a/targets/refundbot/agent.ts', LINE);
  const partial = write('t5', '/a/targets/refundbot/tools.ts', `${LINE} // changed`);
  const hits = findTranscriptWrites([TRANSCRIPT, edit, multi, other, partial].join('\n'), 'targets/refundbot/tools.ts', LINE);
  assert.deepEqual(hits.map((h) => h.tool), ['Write', 'Write', 'Edit', 'MultiEdit']);
  assert.deepEqual(findTranscriptWrites(TRANSCRIPT, 'targets/refundbot/tools.ts', '});'), [], 'too generic to attribute');
});

test('prompt headline drops pasted blocks and truncates', () => {
  assert.equal(promptHeadline(JSON.parse(WHY_AI).line.prompt, 200), 'lets build all. of these and be sure it works: [pasted text] deploy multiple agents to take up these tasks');
  assert.equal(promptHeadline('x'.repeat(200), 20)!.length, 20);
  assert.equal(promptHeadline(undefined), undefined);
});

test('entire why with a checkpoint is used as-is', () => {
  const run = fakeRunner({
    'git rev-parse --show-toplevel': '/repo\n',
    'entire why docs/FEATURES.md:68 --json': WHY_AI,
    'git log -1 --format=%s e44db55035b826903241b22d91fc864479255dc3': 'Enable Entire for Claude Code\n',
  });
  const p = traceLine('docs/FEATURES.md', 68, opts(run));
  assert.equal(p.source, 'entire');
  assert.equal(p.match, 'checkpoint');
  assert.equal(p.checkpointId, CP);
  assert.equal(p.sessionId, '8cdad8b4-3584-46b2-b505-0bcea4d9fb5b');
  assert.equal(p.subject, 'Enable Entire for Claude Code');
  assert.ok(!run.calls.some((c) => c.startsWith('git blame')), 'no blame needed');
  assert.match(describeProvenance(p), /introduced in `e44db55`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all/);
});

test('without the Entire CLI, the commit trailer and checkpoint ref give the same answer', () => {
  const ref = checkpointRef(CP);
  const run = fakeRunner({
    ...GIT_BASE,
    'entire *': { missing: true },
    [`git log -1 --format=%B ${SHA}`]: `Subject\n\nEntire-Checkpoint: ${CP}\n`,
    [`git show ${ref}:0/metadata.json`]: SESSION_META(CP, '2026-10-10T09:14:22Z', 0),
    [`git show ${ref}:0/prompt.txt`]: 'start building something for this app\n',
  });
  const p = traceLine('targets/refundbot/tools.ts', 87, opts(run));
  assert.equal(p.source, 'entire');
  assert.equal(p.match, 'checkpoint');
  assert.equal(p.checkpointId, CP);
  assert.equal(p.sessionId, 'sess-1');
  assert.equal(p.prompt, 'start building something for this app');
  assert.equal(p.commit, SHA);
});

test('a trailer whose checkpoint ref is not fetched still names the checkpoint, and says why the session is missing', () => {
  const run = fakeRunner({ ...GIT_BASE, 'entire *': { missing: true }, [`git log -1 --format=%B ${SHA}`]: `S\n\nEntire-Checkpoint: ${CP}\n` });
  const p = traceLine('targets/refundbot/tools.ts', 87, opts(run));
  assert.equal(p.checkpointId, CP);
  assert.equal(p.sessionId, undefined);
  assert.match(p.note!, /not in this clone/);
});

test('no trailer: an imported session transcript that wrote the exact line before the commit is matched', () => {
  const ref = 'refs/entire/checkpoints/AA/01CPAA';
  const ref2 = 'refs/entire/checkpoints/BB/01CPBB';
  const run = fakeRunner({
    ...GIT_BASE,
    'entire why targets/refundbot/tools.ts:87 --json': WHY_HUMAN,
    [`git log -1 --format=%B ${SHA}`]: 'RefundBot target\n',
    'git for-each-ref --format=%(refname) refs/entire/checkpoints/': `${ref}\n${ref2}\n`,
    [`git show ${ref}:0/metadata.json`]: SESSION_META('01CPAA', '2026-10-10T09:14:22Z', 0),
    [`git show ${ref}:0/prompt.txt`]: 'start building something for this app',
    [`git show ${ref2}:0/metadata.json`]: SESSION_META('01CPBB', '2026-10-10T10:37:42Z', 2),
    [`git show ${ref2}:0/prompt.txt`]: 'launch the localhost',
    [`git show ${ref2}:0/full.jsonl`]: TRANSCRIPT,
  });
  const p = traceLine('targets/refundbot/tools.ts', 87, opts(run));
  assert.equal(p.source, 'entire');
  assert.equal(p.match, 'transcript');
  assert.equal(p.checkpointId, '01CPAA', 'the checkpoint whose scope holds the write, not the later one');
  assert.equal(p.prompt, 'start building something for this app');
  assert.equal(p.writtenAt, '2026-10-10T09:17:08Z');
  assert.equal(p.commit, SHA);
  assert.match(p.note!, /predates Entire's commit hooks/);
  assert.match(describeProvenance(p), /matched in the imported transcript/);
});

test('no trailer and no matching transcript: plain git blame, with the reason', () => {
  const run = fakeRunner({
    ...GIT_BASE,
    'entire *': { missing: true },
    [`git log -1 --format=%B ${SHA}`]: 'RefundBot target\n',
    'git for-each-ref --format=%(refname) refs/entire/checkpoints/': '',
  });
  const p = traceLine('targets/refundbot/tools.ts', 87, opts(run));
  assert.equal(p.source, 'git');
  assert.equal(p.author, 'mrnetwork0001');
  assert.equal(p.checkpointId, undefined);
  assert.match(p.note!, /no Entire-Checkpoint trailer.*Entire CLI not installed/);
  assert.match(describeProvenance(p), /^introduced in `cf0ceac` "RefundBot target.*no Entire session linked/);
});

test('degrades without crashing: not a repo, uncommitted line, entire failing, runner throwing', () => {
  const notRepo = fakeRunner({ 'git rev-parse --show-toplevel': { fail: 'fatal: not a git repository' } });
  assert.equal(traceLine('x.ts', 1, opts(notRepo)).source, 'unavailable');

  const uncommitted = fakeRunner({
    'git rev-parse --show-toplevel': '/repo',
    'entire *': { fail: 'not enabled' },
    'git blame --porcelain -L 3,3 -- x.ts': `${'0'.repeat(40)} 3 3 1\nauthor Not Committed Yet\n\tnew line\n`,
  });
  const u = traceLine('x.ts', 3, opts(uncommitted));
  assert.equal(u.source, 'unavailable');
  assert.match(u.note!, /not committed/);

  const finding = { file: 'tools.ts', line: 87, why: 'w' } as Finding;
  const boom: Runner = () => {
    throw new Error('kaboom');
  };
  assert.deepEqual(attachProvenance([finding], 'targets/refundbot', { run: boom }), []);
  assert.equal(finding.provenance?.source, 'unavailable');
  assert.match(finding.provenance!.note!, /kaboom/);
});

test('postmortem and PR body show provenance', () => {
  const provenance = {
    file: 'targets/refundbot/tools.ts',
    line: 87,
    source: 'entire' as const,
    match: 'checkpoint' as const,
    commit: SHA,
    date: '2026-10-10T09:20:18Z',
    checkpointId: CP,
    sessionId: '8cdad8b4-3584-46b2-b505-0bcea4d9fb5b',
    agent: 'Claude Code',
    prompt: 'start building something for this app',
  };
  const finding: Finding = { kind: 'commit-timeout', severity: 'high', file: 'tools.ts', line: 87, why: 'retries without an idempotency key', faults: ['timeout-after-commit'], provenance };
  const rec: FaultRecord = { fault: 'timeout-after-commit', title: 't', hypothesis: 'h', status: 'unfixed', findings: [finding], attempts: [] };
  assert.match(postmortem(rec, 'run-1'), /Provenance: introduced in `cf0ceac`, 2026-10-10 by Claude Code session `8cdad8b4`, prompt "start building something for this app"/);
  const result = { fault: 'none', passed: 1, trials: 1, ci95: [1, 1] } as never;
  const pr = prBody({ target: 'RefundBot', runId: 'r', records: [rec], before: { none: result }, after: { none: result }, diff: '', traces: 'local', residual: [], provenance: [provenance] });
  assert.match(pr, /### Provenance\n- `targets\/refundbot\/tools.ts:87`: introduced in `cf0ceac`/);
  assert.equal(summarizeProvenance([provenance, { ...provenance, line: 101 }]).length, 1, 'same origin → one line');
});

// Against the real Entire checkpoint ref in this repo, when the clone has it
// (refs/entire/* are local unless pushed, so CI clones skip this).
const REAL_REF = checkpointRef(CP);
const hasRealRef = spawnSync('git', ['rev-parse', '--verify', '-q', REAL_REF], { encoding: 'utf8' }).status === 0;
test('real checkpoint ref: e44db55 trailer resolves to its Entire session', { skip: !hasRealRef && 'no refs/entire checkpoints in this clone' }, () => {
  // A line e44db55 added, found by text so edits elsewhere in the file don't move it.
  const line = readFileSync('docs/FEATURES.md', 'utf8').split('\n').indexOf('## Tier D: new ideas (added Oct 11)') + 1;
  assert.ok(line > 0);
  const p = traceLine('docs/FEATURES.md', line, { transcripts: false });
  assert.equal(p.source, 'entire');
  assert.equal(p.checkpointId, CP);
  assert.equal(p.sessionId, '8cdad8b4-3584-46b2-b505-0bcea4d9fb5b');
  assert.equal(p.agent, 'Claude Code');
  assert.match(p.prompt ?? '', /^lets build all/);
});
