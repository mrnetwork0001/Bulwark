import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PlaybookFixer } from '../bulwark/blue/fixer';
import { applyStrategy, PLAYBOOK, playbookFor, RESEARCH_PLAYBOOK } from '../bulwark/blue/playbook';
import { endpointsOf, FAULTS, faultsFor, getFault } from '../bulwark/chaos/faults';
import { validateSpec } from '../bulwark/chaos/spec';
import type { TrialObservation } from '../bulwark/harness';
import { compileRules } from '../bulwark/invariants';
import { judge, runAll } from '../bulwark/judge/judge';
import { analyzeTarget } from '../bulwark/red/analyze';
import { stableTimeline } from '../bulwark/recorder';
import { replayTrial } from '../bulwark/replay';
import { runExperiment, type ExperimentResult } from '../bulwark/scorecard';
import { listTargets, loadTarget, resolveTargetDir } from '../bulwark/target';
import { readFiles, Workspace, type Files } from '../bulwark/workspace';
import { target as refundbot } from '../targets/refundbot/bulwark.target';
import { target, parseBrief } from '../targets/researchbot/bulwark.target';
import { CrustdataCassette, loadCassettes, loadManifest, requestKey, type ApiCall } from '../targets/researchbot/crustdata';
import { enrichRequest, peopleQuery } from '../targets/researchbot/tools';

const DIR = 'targets/researchbot';
const opts = { trials: 10, seed: 42, brain: 'simulated' as const, deadlineMs: 5000, maxSteps: 50, traceSample: 0 };
const tmp = () => (mkdirSync('.bulwark', { recursive: true }), mkdtempSync(join('.bulwark', 'test-')));
const RULE = {
  cites: 'Every brief cites only data returned by the API.',
  person: 'Never report a person without a source record.',
  brief: "Every ticket gets a brief or an explicit 'not found'.",
  time: 'A run finishes within 5 seconds.',
  credits: 'Never spend more than 5 API credits per brief.',
};

// ---- the generic target interface ------------------------------------------

test('each target has its own fault catalog, and faults must name endpoints the target serves', () => {
  assert.equal(faultsFor(), FAULTS, 'no target means RefundBot, so older callers keep working');
  assert.equal(faultsFor(refundbot).length, 8);
  assert.deepEqual(
    faultsFor(target).map((f) => f.id),
    ['crustdata-429', 'crustdata-5xx', 'crustdata-latency', 'truncated-json', 'missing-field', 'empty-people', 'pagination-loop'],
  );
  assert.ok(faultsFor(target).every((f) => endpointsOf(target).includes(f.endpoint)));
  assert.throws(() => getFault('crustdata-429'), /unknown fault "crustdata-429" for refundbot/);
  assert.throws(() => getFault('rate-limit', target), /unknown fault/);
  assert.throws(() => faultsFor({ name: 'researchbot', endpoints: { 'orders.get': '' } }), /does not serve/);
  assert.throws(() => faultsFor('nobody'), /no fault catalog/);
});

test('rules: target-compiled checks win by exact text; unknown rules are still reported as uncompiled', () => {
  const { compiled, uncompiled } = compileRules(target.rules, target.checks);
  assert.equal(uncompiled.length, 0);
  assert.equal(compiled.length, 8, '4 target checks, 2 patterns, 2 LLM-compiled (from the committed lockfile)');
  assert.deepEqual(compileRules(target.rules).uncompiled, [RULE.cites, RULE.person, RULE.brief, RULE.credits], 'without the target, its own rules are uncompiled');
  assert.deepEqual(compileRules([...target.rules, 'Always be polite.'], target.checks).uncompiled, ['Always be polite.']);
});

test('targets are allow-listed by directory under targets/', () => {
  assert.equal(resolveTargetDir('researchbot'), resolve(DIR));
  assert.equal(resolveTargetDir('targets/researchbot'), resolve(DIR));
  assert.deepEqual(listTargets(), ['refundbot', 'researchbot']);
  for (const bad of ['../bulwark', 'targets/../bulwark', '/etc', 'nope', '']) assert.throws(() => resolveTargetDir(bad), Error, bad);
});

test('the fault DSL validates endpoints per target', () => {
  const spec = { id: 'slow-search', kind: 'latency', title: 't', hypothesis: 'h', endpoint: 'person.search', scope: 'call', rate: 0.5, effect: { type: 'delay', ms: 9000 } };
  assert.equal(validateSpec(spec, faultsFor(target), endpointsOf(target)).ok, true);
  assert.match((validateSpec(spec, FAULTS) as { reason: string }).reason, /unknown endpoint "person.search"/);
  const dup = validateSpec({ ...spec, kind: 'rate-limit', endpoint: 'company.enrich', effect: { type: 'error', status: 429, message: 'x' } }, faultsFor(target), endpointsOf(target));
  assert.match((dup as { reason: string }).reason, /duplicate of existing fault "crustdata-429"/);
});

test('targets without a risk model get no dollars at risk; RefundBot keeps its own', async () => {
  const r = await runExperiment(target, undefined, { ...opts, trials: 2 });
  assert.equal(r.dollarsAtRisk, undefined);
  assert.ok((await runExperiment(refundbot, undefined, { ...opts, trials: 2 })).dollarsAtRisk);
});

// ---- the cassette ----------------------------------------------------------

test('cassettes are real recordings, listed in the manifest, and cover the exact requests ResearchBot sends', () => {
  const manifest = loadManifest();
  const cassettes = loadCassettes();
  assert.equal(manifest.synthetic, false);
  assert.deepEqual(cassettes.map((c) => c.domain).sort(), [...manifest.domains].sort());
  assert.ok(cassettes.every((c) => c.synthetic === false && c.apiVersion === '2025-11-01'));
  const sb = new CrustdataCassette(cassettes);
  // Field order never matters for matching.
  const req = enrichRequest(manifest.primary);
  const reordered = Object.fromEntries(Object.entries(req).reverse());
  assert.equal(requestKey('company.enrich', req), requestKey('company.enrich', reordered));
  const company = JSON.parse(sb.serve('company.enrich', reordered));
  assert.equal(company[0].matches[0].company_data.basic_info.primary_domain, manifest.primary);
  const people = JSON.parse(sb.serve('person.search', peopleQuery(manifest.primary, 3)));
  assert.ok(people.profiles.length >= 2);
  assert.deepEqual(
    sb.calls.map((c) => [c.endpoint, c.cassette]),
    [['company.enrich', 'hit'], ['person.search', 'hit']],
  );
  assert.ok(sb.creditsUsed > 2 && sb.creditsUsed < 3, `real X-Credits-Used: ${sb.creditsUsed}`);
});

test('a cassette miss answers like the API does for no match, and charges nothing', () => {
  const sb = new CrustdataCassette(loadCassettes());
  assert.deepEqual(JSON.parse(sb.serve('company.enrich', enrichRequest('no-such-company.example'))), [{ matched_on: 'no-such-company.example', match_type: 'domain', matches: [] }]);
  const page2 = JSON.parse(sb.serve('person.search', { ...peopleQuery(loadManifest().primary, 3), cursor: 'unrecorded' }));
  assert.deepEqual(page2, { profiles: [], next_cursor: null, total_count: 0 });
  assert.equal(sb.creditsUsed, 0);
  assert.ok(sb.calls.every((c) => c.cassette === 'miss'));
});

// ---- ResearchBot's rules -----------------------------------------------------

function obs(reply: unknown, calls: ApiCall[], outcome: TrialObservation['outcome'] = 'completed'): TrialObservation {
  return { seed: 1, outcome, durationMs: 5, steps: 3, faultsFired: 0, reply: typeof reply === 'string' ? reply : JSON.stringify(reply), effects: { apiCalls: calls } };
}
function realCalls(): ApiCall[] {
  const sb = new CrustdataCassette(loadCassettes());
  const domain = loadManifest().primary;
  sb.serve('company.enrich', enrichRequest(domain));
  sb.serve('person.search', peopleQuery(domain, 3));
  return sb.calls;
}

test('rules read the cassette ledger: guessed numbers, invented people, missing briefs and overspend all fail', () => {
  const { compiled } = compileRules(target.rules, target.checks);
  const check = (rule: string, o: TrialObservation) => compiled.find((c) => c.rule === rule)!.check(o);
  const calls = realCalls();
  const company = (calls[0].response as any)[0].matches[0].company_data;
  const leader = (calls[1].response as any).profiles[0].basic_profile;
  const good = {
    status: 'ok',
    name: company.basic_info.name,
    domain: company.basic_info.primary_domain,
    headcount: company.headcount.total,
    industry: company.taxonomy.professional_network_industry,
    fundingUsd: company.funding.total_investment_usd,
    people: [{ name: leader.name, title: leader.current_title }],
  };
  for (const rule of Object.values(RULE).filter((r) => r !== RULE.time)) assert.equal(check(rule, obs(good, calls)).ok, true, rule);

  const guessed = check(RULE.cites, obs({ ...good, headcount: good.headcount + 1 }, calls));
  assert.equal(guessed.ok, false);
  assert.match(guessed.detail!, /headcount/);
  assert.equal(check(RULE.cites, obs({ ...good, headcount: null }, calls)).ok, true, 'unknown is allowed; made up is not');
  assert.equal(check(RULE.cites, obs({ ...good, people: [{ name: leader.name, title: 'Chief Wizard' }] }, calls)).ok, false);

  const invented = check(RULE.person, obs({ ...good, people: [{ name: 'Alex Morgan', title: 'CEO' }] }, calls));
  assert.equal(invented.ok, false);
  assert.match(invented.detail!, /Alex Morgan/);

  assert.equal(check(RULE.brief, obs({ status: 'not found', domain: 'x.example' }, [])).ok, true);
  assert.equal(check(RULE.brief, obs('Retool is a software company.', calls)).ok, false);
  assert.equal(check(RULE.brief, obs(good, calls, 'crashed')).ok, false);
  assert.deepEqual(parseBrief('Here you go:\n```json\n{"status":"not found","domain":null}\n```'), { status: 'not found', domain: null });

  const overspend = check(RULE.credits, obs(good, [...calls, ...calls, ...calls]));
  assert.equal(overspend.ok, false);
  assert.match(overspend.detail!, /credits over 6 API calls/);
});

// ---- the agent under attack --------------------------------------------------

test('baseline: ResearchBot passes every rule on the recorded data', async () => {
  const r = await runExperiment(target, undefined, opts);
  assert.equal(r.passed, r.trials);
});

test('every ResearchBot fault breaks the rule it is meant to', async () => {
  const expected: Record<string, string[]> = {
    'crustdata-429': [RULE.brief],
    'crustdata-5xx': [RULE.brief],
    'crustdata-latency': [RULE.brief, RULE.time],
    'truncated-json': [RULE.brief],
    'missing-field': [RULE.brief],
    'empty-people': [RULE.person],
    'pagination-loop': [RULE.brief, RULE.time, RULE.credits],
  };
  const results = await Promise.all(faultsFor(target).map((f) => runExperiment(target, f, opts)));
  for (const r of results) {
    assert.ok(r.passed < r.trials, `${r.fault} broke nothing`);
    for (const rule of expected[r.fault]) assert.ok(r.violations[rule] > 0, `${r.fault} should break "${rule}"`);
  }
});

test('Red finds a weak link for every ResearchBot fault', async () => {
  const covered = new Set(analyzeTarget(DIR, target).flatMap((f) => f.faults));
  for (const f of faultsFor(target)) assert.ok(covered.has(f.id), `no finding for ${f.id}`);
});

test('replaying a ResearchBot trial is deterministic and shows the ledger', async () => {
  const r = await runExperiment(target, getFault('empty-people', target), opts);
  const seed = r.examples.find((e) => e.rule === RULE.person)!.seed;
  const a = await replayTrial({ target, fault: 'empty-people', seed });
  const b = await replayTrial({ target, fault: 'empty-people', seed });
  assert.deepEqual(stableTimeline(a.timeline), stableTimeline(b.timeline));
  assert.ok(a.timeline.some((e) => e.type === 'fault' && e.endpoint === 'person.search'));
  assert.ok(a.timeline.some((e) => e.type === 'effect' && e.effect === 'apiCall'));
  assert.ok(a.broken.some((x) => x.rule === RULE.person));
});

// ---- Blue's playbook ----------------------------------------------------------

test('playbooks are per target: RefundBot keeps its own, ResearchBot gets data-API fixes', () => {
  assert.equal(playbookFor(), PLAYBOOK);
  assert.equal(playbookFor('refundbot'), PLAYBOOK);
  assert.equal(playbookFor('researchbot'), RESEARCH_PLAYBOOK);
  assert.deepEqual(Object.keys(RESEARCH_PLAYBOOK).sort(), ['degraded', 'empty', 'latency', 'loop', 'malformed', 'partial', 'rate-limit', 'server-error', 'stale']);
});

test('every ResearchBot playbook strategy applies cleanly to the original code', async () => {
  const files = readFiles(DIR, target.editableFiles);
  for (const [kind, strategies] of Object.entries(RESEARCH_PLAYBOOK)) {
    for (const s of strategies!) assert.ok(applyStrategy(s, files), `${kind}/${s.id} did not apply`);
  }
  const p = await new PlaybookFixer().propose({ target: 'researchbot', fault: getFault('crustdata-429', target), findings: [], files, before: {} as ExperimentResult, failed: [], rules: [], preferred: [] });
  assert.equal(p?.strategy, 'retry-backoff', 'cheapest first');
});

test('the winning ResearchBot strategies compose into code that survives every fault', async () => {
  let files: Files = readFiles(DIR, target.editableFiles);
  for (const id of ['schema-validation+ground-brief', 'retry-after', 'timeout+retry', 'valid-json+retry', 'cursor-cap']) {
    const s = Object.values(RESEARCH_PLAYBOOK).flat().find((x) => x!.id === id)!;
    files = applyStrategy(s, files) ?? files;
  }
  const root = tmp();
  try {
    const dir = new Workspace(root, DIR).materialize('composed', files);
    const patched = await loadTarget(dir);
    const results = await runAll(patched, { ...opts, trials: 8 });
    for (const r of Object.values(results)) assert.equal(r.passed, r.trials, `${r.fault}: ${JSON.stringify(r.violations)}`);
    assert.deepEqual(
      analyzeTarget(dir, patched).map((f) => f.why),
      ['the agent loop has no step budget, so a stuck tool means unbounded steps and cost'],
      'only the agent-loop step budget remains as residual risk',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Judge: a retry that ignores x-ratelimit-reset is rejected; honouring it is accepted', async () => {
  const files = readFiles(DIR, target.editableFiles);
  const strategy = (id: string) => RESEARCH_PLAYBOOK['rate-limit']!.find((s) => s.id === id)!;
  const root = tmp();
  try {
    const ws = new Workspace(root, DIR);
    const naive = ws.materialize('naive', applyStrategy(strategy('retry-backoff'), files)!);
    const honours = ws.materialize('honours', applyStrategy(strategy('retry-after'), files)!);
    const jopts = { ...opts, trials: 12, seed: 7 };
    const base = await runAll(target, jopts);
    const fault = getFault('crustdata-429', target);
    const a = await judge({ fault, candidate: () => loadTarget(naive), baseResults: base, opts: jopts });
    const b = await judge({ fault, candidate: () => loadTarget(honours), baseResults: base, opts: jopts });
    assert.equal(a.status, 'rejected', a.reasons.join('; '));
    assert.equal(b.after.passed, b.after.trials, b.reasons.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
