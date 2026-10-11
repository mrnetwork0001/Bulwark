// CI gate (#14), ChatOps (#15) and run notifications (#19). Nothing here runs a
// chaos experiment or touches the network: fetch is always mocked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badgeLine, buildBaseline, compareToBaseline, COMMENT_MARKER, parseBaseline, renderComment } from '../bulwark/ci/baseline';
import { commandArgv, helpText, isAllowedAuthor, parseCommand, safeFixBranch, type ChatContext } from '../bulwark/chatops';
import { faultsFor } from '../bulwark/chaos/faults';
import { artifactsUrl, buildNotice, discordPayload, notifyRunDone, slackPayload, type NotifySummaryInput } from '../bulwark/notify';
import type { ExperimentResult } from '../bulwark/scorecard';

const result = (fault: string, passed: number, trials = 20, extra: Partial<ExperimentResult> = {}): ExperimentResult => ({
  fault,
  title: fault,
  hypothesis: '',
  trials,
  passed,
  passRate: passed / trials,
  ci95: [0, 1],
  outcomes: { completed: passed, crashed: trials - passed, hung: 0, runaway: 0 } as ExperimentResult['outcomes'],
  violations: {},
  p95Ms: 10,
  examples: [],
  perTrial: [],
  ...extra,
});

// ---------- #14 baseline comparison ----------

const base = buildBaseline('refundbot', [result('baseline', 20), result('rate-limit', 10), result('stuck-pending', 12)], { trials: 20, seed: 42 }, new Date('2026-10-11T00:00:00Z'));
const opts = { trials: 20, seed: 42 };

test('baseline: records per-fault pass counts and the overall rate', () => {
  assert.equal(base.overall, 0.7);
  assert.deepEqual(base.faults['rate-limit'], { passed: 10, trials: 20 });
  assert.deepEqual(parseBaseline(JSON.parse(JSON.stringify(base))), base);
  assert.throws(() => parseBaseline({ target: 'x' }), /malformed/);
  assert.throws(() => parseBaseline({ ...base, faults: { a: { passed: 30, trials: 20 } } }), /malformed baseline entry/);
});

test('baseline: same results pass, an improvement passes and is flagged', () => {
  const same = compareToBaseline('refundbot', [result('baseline', 20), result('rate-limit', 10), result('stuck-pending', 12)], base, opts);
  assert.ok(same.ok);
  assert.equal(same.overall, same.baselineOverall);
  const better = compareToBaseline('refundbot', [result('baseline', 20), result('rate-limit', 20), result('stuck-pending', 12)], base, opts);
  assert.ok(better.ok);
  assert.equal(better.faults.find((f) => f.fault === 'rate-limit')!.status, 'improved');
  assert.ok(better.overall > better.baselineOverall!);
});

test('baseline: losing a single trial on any fault fails the check, unless within tolerance', () => {
  const worse = [result('baseline', 20), result('rate-limit', 20), result('stuck-pending', 11)];
  const cmp = compareToBaseline('refundbot', worse, base, opts);
  assert.equal(cmp.ok, false);
  assert.equal(cmp.faults.find((f) => f.fault === 'stuck-pending')!.status, 'regressed');
  assert.match(cmp.failures[0], /stuck-pending: 11\/20 passed, baseline 12\/20/);
  // Overall went up (rate-limit improved), but a per-fault regression still fails.
  assert.ok(cmp.overall > cmp.baselineOverall!);
  assert.ok(compareToBaseline('refundbot', worse, base, { ...opts, tolerance: 1 }).ok);
});

test('baseline: a new fault is reported but never fails; a removed fault fails', () => {
  const added = compareToBaseline('refundbot', [result('baseline', 20), result('rate-limit', 10), result('stuck-pending', 12), result('clock-skew', 3)], base, opts);
  assert.ok(added.ok);
  assert.equal(added.faults.find((f) => f.fault === 'clock-skew')!.status, 'new');
  assert.equal(added.overall, added.baselineOverall, 'new faults do not move the overall');
  const removed = compareToBaseline('refundbot', [result('baseline', 20), result('rate-limit', 10)], base, opts);
  assert.equal(removed.ok, false);
  assert.match(removed.failures.join(), /stuck-pending: in the baseline but no longer attacked/);
});

test('baseline: different trials or seed fail as a mismatch; a missing baseline is reported, not failed', () => {
  const r = [result('baseline', 10, 10), result('rate-limit', 5, 10), result('stuck-pending', 6, 10)];
  const mm = compareToBaseline('refundbot', r, base, { trials: 10, seed: 42 });
  assert.equal(mm.ok, false);
  assert.match(mm.mismatch!, /20 trials, seed 42/);
  const none = compareToBaseline('refundbot', r, undefined, { trials: 10, seed: 42 });
  assert.ok(none.ok && none.missingBaseline);
});

test('baseline: the sticky comment has its marker, a badge line and the verdict', () => {
  const results = [result('baseline', 20), result('rate-limit', 9), result('stuck-pending', 12)];
  const md = renderComment([{ cmp: compareToBaseline('refundbot', results, base, opts), results }], { trials: 20, seed: 42, runUrl: 'https://github.com/o/r/actions/runs/1' });
  assert.ok(md.startsWith(COMMENT_MARKER));
  assert.match(md, /❌ Resilience dropped below the committed baseline/);
  assert.match(md, /\| rate-limit \| 9\/20 \| 10\/20 \|/);
  assert.match(md, /🔻 regressed/);
  assert.match(md, /img\.shields\.io\/badge\/refundbot%20resilience-68%25-red/);
  assert.equal(badgeLine('a-b', 0.96), '![a-b resilience](https://img.shields.io/badge/a--b%20resilience-96%25-brightgreen)');
  assert.match(renderComment([], { trials: 20, seed: 42 }), /No target under `targets\/` changed/);
});

// ---------- #15 ChatOps parsing ----------

const ctx: ChatContext = { targets: ['refundbot', 'researchbot'], faults: (t) => faultsFor(t).map((f) => f.id) };
const parsed = (body: string) => {
  const r = parseCommand(body, ctx);
  assert.ok(r && r.ok, `expected ok for ${JSON.stringify(body)}: ${r && !r.ok ? r.error : 'null'}`);
  return r.command;
};
const rejected = (body: string, re: RegExp) => {
  const r = parseCommand(body, ctx);
  assert.ok(r && !r.ok, `expected an error for ${JSON.stringify(body)}`);
  assert.match(r.error, re);
};

test('chatops: comments without a command are ignored; help is the default', () => {
  assert.equal(parseCommand('LGTM, ship it', ctx), null);
  assert.equal(parseCommand('see /bulwark docs', ctx), null, 'only a line that starts with /bulwark counts');
  assert.deepEqual(parsed('/bulwark'), { kind: 'help' });
  assert.deepEqual(parsed('Thanks!\n  /bulwark help  \nmore text'), { kind: 'help' });
  assert.match(helpText(ctx), /crustdata-429/);
});

test('chatops: attack takes an optional target and fault, validated against the allowlist and catalog', () => {
  assert.deepEqual(parsed('/bulwark attack'), { kind: 'attack', target: 'refundbot', fault: 'all' });
  assert.deepEqual(parsed('/bulwark attack researchbot'), { kind: 'attack', target: 'researchbot', fault: 'all' });
  assert.deepEqual(parsed('/bulwark attack rate-limit'), { kind: 'attack', target: 'refundbot', fault: 'rate-limit' });
  assert.deepEqual(parsed('/BULWARK ATTACK researchbot crustdata-429'), { kind: 'attack', target: 'researchbot', fault: 'crustdata-429' });
  rejected('/bulwark attack researchbot rate-limit', /unknown fault "rate-limit" for researchbot/);
  rejected('/bulwark attack evilbot rate-limit', /unknown target "evilbot"/);
  rejected('/bulwark attack ../../etc', /plain names/);
  rejected('/bulwark attack a b c', /usage/);
});

test('chatops: fix and replay', () => {
  assert.deepEqual(parsed('/bulwark fix'), { kind: 'fix', target: 'refundbot', pr: false });
  assert.deepEqual(parsed('/bulwark fix researchbot pr'), { kind: 'fix', target: 'researchbot', pr: true });
  assert.deepEqual(parsed('/bulwark fix pr'), { kind: 'fix', target: 'refundbot', pr: true });
  rejected('/bulwark fix evilbot', /unknown target/);
  rejected('/bulwark fix refundbot now', /usage/);
  assert.deepEqual(parsed('/bulwark replay timeout-after-commit 1234'), { kind: 'replay', target: 'refundbot', fault: 'timeout-after-commit', seed: 1234 });
  assert.deepEqual(parsed('/bulwark replay researchbot pagination-loop 7'), { kind: 'replay', target: 'researchbot', fault: 'pagination-loop', seed: 7 });
  rejected('/bulwark replay timeout-after-commit', /usage/);
  rejected('/bulwark replay timeout-after-commit 99999999999', /seed/);
  rejected('/bulwark replay timeout-after-commit 1e3', /seed/);
  rejected('/bulwark replay nope 1', /unknown fault/);
  rejected('/bulwark deploy prod', /unknown command/);
});

test('chatops: shell metacharacters and injection attempts never parse', () => {
  for (const evil of ['/bulwark attack refundbot;rm', '/bulwark attack $(id)', '/bulwark attack `id`', '/bulwark fix refundbot && curl x', '/bulwark replay a|b 1', "/bulwark attack 'x'", '/bulwark attack --target=/etc', `/bulwark attack ${'a'.repeat(300)}`]) {
    const r = parseCommand(evil, ctx);
    assert.ok(r && !r.ok, `should reject ${evil}`);
  }
});

test('chatops: argv arrays carry only validated values; fix never pushes on its own', () => {
  assert.deepEqual(commandArgv({ kind: 'attack', target: 'researchbot', fault: 'all' }), ['run', '--silent', 'chaos', '--', '--target', 'targets/researchbot', '--fault', 'all', '--trials', '20', '--seed', '42', '--brain', 'simulated']);
  const fix = commandArgv({ kind: 'fix', target: 'refundbot', pr: true })!;
  assert.ok(fix.includes('--apply') && !fix.includes('--pr'), 'the CLI commits locally; chatops pushes only a vetted bulwark/fix-* branch');
  assert.ok(fix.includes('playbook'));
  assert.deepEqual(commandArgv({ kind: 'replay', target: 'refundbot', fault: 'rate-limit', seed: 5 })!.slice(-1), ['--json']);
  assert.equal(commandArgv({ kind: 'help' }), null);
});

test('chatops: only collaborators; only bulwark/fix-* branches that are not the PR head or main', () => {
  assert.ok(isAllowedAuthor('OWNER') && isAllowedAuthor('MEMBER') && isAllowedAuthor('COLLABORATOR'));
  for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) assert.equal(isAllowedAuthor(a), false);
  assert.ok(safeFixBranch('bulwark/fix-2026-10-11T16-18-31-152Z', ['feature/x', 'main']));
  assert.equal(safeFixBranch('main', ['feature/x', 'main']), false);
  assert.equal(safeFixBranch('feature/x', ['feature/x', 'main']), false);
  assert.equal(safeFixBranch('bulwark/fix-1', ['bulwark/fix-1', 'main']), false, 'never the PR head, even if it looks like a fix branch');
  assert.equal(safeFixBranch('bulwark/fix-1;rm', []), false);
});

// ---------- #19 notifications ----------

const summary: NotifySummaryInput = {
  runId: '2026-10-11T16-18-31-152Z',
  dir: '/nonexistent',
  target: 'refundbot',
  fixer: 'playbook',
  overallBefore: 0.56,
  overallAfter: 1,
  fixed: ['timeout-after-commit', 'prompt-injection'],
  unfixed: [],
  skipped: ['rate-limit'],
  attempts: 8,
  rollbacks: 3,
  residual: [{ file: 'tools.ts', line: 126, why: 'search_policy passes raw text to the model' }],
};
const risk = (per1k: number) => ({ per1kTickets: per1k, totalUsd: per1k / 50, overRefundUsd: 0, lostTickets: 0, escalations: 0, trials: 20, costs: { lostTicketUsd: 20, escalationUsd: 15 } });
const scores = {
  before: { baseline: result('baseline', 20, 20, { dollarsAtRisk: risk(0) }), 'rate-limit': result('rate-limit', 10, 20, { dollarsAtRisk: risk(7500) }) },
  after: { baseline: result('baseline', 20, 20, { dollarsAtRisk: risk(0) }), 'rate-limit': result('rate-limit', 20, 20, { dollarsAtRisk: risk(0) }) },
};

test('notify: the notice carries resilience, fixes, risk, top remaining risk and the artifacts link', () => {
  const n = buildNotice(summary, scores, { BULWARK_ARTIFACTS_BASE_URL: 'https://bulwark.example/api/artifact?file=PR.md&run=' });
  assert.equal(n.before, 0.56);
  assert.deepEqual(n.risk, { before: 7500, after: 0 });
  assert.equal(n.topRisk, 'tools.ts:126 search_policy passes raw text to the model');
  assert.equal(n.artifactsUrl, 'https://bulwark.example/api/artifact?file=PR.md&run=2026-10-11T16-18-31-152Z');
  assert.equal(artifactsUrl('https://ci.example/runs/', 'r1'), 'https://ci.example/runs/r1/');
  assert.equal(artifactsUrl('javascript:alert(1)', 'r1'), undefined);
  // No risk model (e.g. ResearchBot): no dollars at all, never a made-up figure.
  assert.equal(buildNotice({ ...summary, residual: [], unfixed: ['x'] }, {}, {}).risk, undefined);
  assert.equal(buildNotice({ ...summary, residual: [], unfixed: ['x'] }, {}, {}).topRisk, 'x still breaks a rule (not fixed)');
});

test('notify: Slack Block Kit and Discord embed payloads', () => {
  const n = buildNotice(summary, scores, { BULWARK_ARTIFACTS_BASE_URL: 'https://ci.example/runs' });
  const slack = slackPayload(n) as any;
  assert.equal(slack.text, 'Bulwark: refundbot resilience 56% → 100% (fixed 2, unfixed 0)');
  assert.equal(slack.blocks[0].type, 'header');
  assert.ok(slack.blocks[1].fields.some((f: any) => f.text === '*$ at risk / 1k tickets*\n$7,500 → $0'));
  assert.ok(slack.blocks.some((b: any) => b.type === 'actions' && b.elements[0].url === 'https://ci.example/runs/2026-10-11T16-18-31-152Z/'));
  const discord = discordPayload(n) as any;
  assert.equal(discord.embeds[0].color, 0x1f9d55);
  assert.equal(discord.embeds[0].url, 'https://ci.example/runs/2026-10-11T16-18-31-152Z/');
  assert.ok(discord.embeds[0].fields.some((f: any) => f.name === 'Top remaining risk' && !f.inline));
  const long = discordPayload({ ...n, topRisk: 'x'.repeat(5000) }) as any;
  assert.ok(long.embeds[0].fields.every((f: any) => f.value.length <= 1024));
});

test('notify: posts to each configured webhook with a mocked fetch, and never throws', async () => {
  const calls: { url: string; body: any }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('ok', { status: url.includes('discord') ? 500 : 200 });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const env = { BULWARK_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/T/B/x', BULWARK_DISCORD_WEBHOOK_URL: 'https://discord.test/api/webhooks/1/x' };
  const r = await notifyRunDone(summary, { env, fetch: fakeFetch, scores, log: (m) => logs.push(m) });
  assert.deepEqual(r.sent, ['slack']);
  assert.deepEqual(r.failed, ['discord']);
  assert.equal(calls.length, 2);
  assert.ok(calls.find((c) => c.url.includes('slack'))!.body.blocks);
  assert.ok(calls.find((c) => c.url.includes('discord'))!.body.embeds);
  assert.ok(logs.some((l) => /discord webhook failed \(HTTP 500\)/.test(l)));
});

test('notify: nothing is sent without webhooks, on a dry run, or under node --test without an injected fetch', async () => {
  let called = 0;
  const fakeFetch = (async () => (called++, new Response('ok'))) as unknown as typeof fetch;
  const logs: string[] = [];
  await notifyRunDone(summary, { env: {}, fetch: fakeFetch, scores, log: (m) => logs.push(m) });
  await notifyRunDone(summary, { env: {}, fetch: fakeFetch, scores, force: true, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /--notify given but neither/.test(l)));
  const dry = await notifyRunDone(summary, { env: { BULWARK_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' }, fetch: fakeFetch, scores, dryRun: true, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => l.startsWith('notify (dry run): Slack payload')));
  assert.ok((dry.payloads.slack as any).blocks);
  await notifyRunDone(summary, { env: { BULWARK_SLACK_WEBHOOK_URL: 'http://insecure.test/x' }, fetch: fakeFetch, scores, log: () => {} });
  assert.equal(called, 0);
  // Real fetch is never used inside node --test.
  assert.ok(process.env.NODE_TEST_CONTEXT);
  const r = await notifyRunDone(summary, { env: { BULWARK_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' }, scores, log: (m) => logs.push(m) });
  assert.deepEqual(r.sent, []);
  assert.ok(logs.some((l) => /not sending during tests/.test(l)));
});
