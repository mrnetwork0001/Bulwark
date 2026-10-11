// The Bulwark loop: Red analyzes and attacks, Blue proposes fixes, the Judge
// verifies each one on fresh seeds, the Guard proves the regression test, and
// rejected fixes are rolled back to the last checkpoint. Every step is emitted
// as an event (for the CLI and the live dashboard) and traced to neatlogs.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { flush, trace } from 'neatlogs';
import { createFixer, proposeSafely, type FailedAttempt, type Fixer, type SelfFaultReport } from '../blue/fixer';
import { prepareRules, type RuleReport } from '../rules/compiler';
import { flushWithin, SelfFaults } from '../selfchaos/faults';
import { faultsFor, getFault, type Fault } from '../chaos/faults';
import { CheckpointStore } from '../checkpoints';
import { CostMeter, type CostSummary } from '../cost/meter';
import { loadPriceBook } from '../cost/pricing';
import { mutationCheck, withSpec, type ChaosSpec } from '../guard';
import { judge, runAll, type Regression, type Verdict, type VerdictStatus } from '../judge/judge';
import type { Overhead, OverheadBudgets } from '../judge/overhead';
import { planSlo, type SloPlan, type SloResult, type SloSpec } from '../judge/slo';
import { createEntrant, proposeAll, rankContenders, tournamentName, type Entry, type TournamentResult } from '../judge/tournament';
import { StrategyMemory } from '../memory';
import { compileRules } from '../invariants';
import { attachProvenance, type Provenance } from '../provenance/entire';
import { llmProvider } from '../llm';
import { runTrial } from '../harness';
import { observeFailure, recheckPending, type ObserveCandidate, type ObserveRecord } from '../observe/evidence';
import type { ReadResult } from '../observe/neatlogs';
import { analyzeTarget, type Finding } from '../red/analyze';
import { attachBlast, graphFor } from '../red/graph';
import { badgeSvg, overallPassRate, postmortem, prBody, type FaultRecord } from '../report/reports';
import { renderMarkdown, type ExperimentResult } from '../scorecard';
import { loadTarget, type BrainMode, type BulwarkTarget } from '../target';
import { diffFiles, diffStats, readFiles, Workspace, type Files } from '../workspace';

export interface LoopOptions {
  targetDir: string;
  faults: string[] | 'all';
  fixer: 'auto' | 'playbook' | 'claude';
  redTrials: number;
  judgeTrials: number;
  seed: number;
  maxAttempts: number;
  memory: boolean;
  brain: BrainMode;
  deadlineMs: number;
  maxSteps: number;
  stateDir: string;
  /** Reliability targets; the Judge runs exactly enough after-fix trials to demonstrate each one. */
  slo?: SloSpec;
  /** Overhead budgets for fixes (overhead is always measured and reported). */
  budgets?: OverheadBudgets;
  /** Fix tournament entrants (models, `playbook`, `playbook-strong`); replaces the single fixer. */
  tournament?: string[];
  /** How long Blue waits for a failing trial's neatlogs trace to finalize before falling back to local evidence (0 = don't read). */
  readbackWaitMs?: number;
  /** Self-chaos: faults injected into Bulwark's own dependencies (see bulwark/selfchaos). Default: BULWARK_SELF_FAULTS. */
  selfFaults?: SelfFaults;
}

export const DEFAULT_LOOP: Omit<LoopOptions, 'targetDir'> = {
  faults: 'all',
  fixer: 'auto',
  redTrials: 20,
  judgeTrials: 40,
  seed: 42,
  maxAttempts: 4,
  memory: true,
  brain: 'simulated',
  deadlineMs: 5000,
  maxSteps: 50,
  stateDir: '.bulwark',
  readbackWaitMs: Number(process.env.BULWARK_NEATLOGS_WAIT_MS ?? 20_000),
};

export type LoopEvent =
  | { type: 'run-start'; runId: string; target: string; fixer: string; faults: string[]; redTrials: number; judgeTrials: number }
  | { type: 'analyze'; findings: Finding[]; provenance?: Provenance[] }
  | { type: 'scorecard'; phase: 'before' | 'after'; results: ExperimentResult[]; overall: number; ws?: string }
  | { type: 'fault-start'; fault: string; title: string; hypothesis: string }
  | { type: 'fault-skip'; fault: string; reason: string }
  | ({ type: 'observe' } & ObserveRecord)
  | { type: 'checkpoint'; action: 'save' | 'restore'; id: string; label: string }
  | { type: 'slo-plan'; plans: SloPlan[]; confidence: number; method: string }
  | { type: 'attempt'; fault: string; n: number; strategy: string; title: string; rationale: string; author: string; diff: string; added: number; removed: number; round?: number }
  | { type: 'verdict'; fault: string; n: number; status: VerdictStatus; reasons: string[]; pValue: number; afterPassed: number; trials: number; regressions: Regression[]; slo?: SloResult; overhead?: Overhead; author?: string; round?: number }
  | ({ type: 'tournament' } & TournamentResult)
  | { type: 'mutation'; fault: string; ok: boolean; unfixedPassed: number; fixedPassed: number; trials: number }
  | { type: 'fault-done'; fault: string; status: FaultRecord['status']; attempts: number }
  | { type: 'residual'; findings: Finding[] }
  | { type: 'log'; message: string }
  /** How each business rule is checked: target check, pattern, or LLM-compiled DSL. */
  | { type: 'rules'; rules: RuleReport[] }
  /** One of Bulwark's own dependencies failed (Blue's LLM, a checkpoint, a workspace, neatlogs, a trial worker) and how it recovered. */
  | ({ type: 'self-fault' } & SelfFaultReport)
  | { type: 'run-done'; summary: LoopSummary };

export interface LoopSummary {
  runId: string;
  dir: string;
  target: string;
  fixer: string;
  overallBefore: number;
  overallAfter: number;
  fixed: string[];
  unfixed: string[];
  skipped: string[];
  attempts: number;
  rollbacks: number;
  /** Weak links the analyzer still sees in the final code. Reported, never hidden. */
  residual: Finding[];
  artifacts: { patch: string; pr: string; badge: string; postmortems: string[] };
  finalFiles: Files;
  targetRel: string;
  /** What this run spent: LLM tokens (priced) plus compute time. */
  cost?: CostSummary;
}

export async function runLoop(input: Partial<LoopOptions> & { targetDir: string }, emit: (e: LoopEvent) => void): Promise<LoopSummary> {
  const o: LoopOptions = { ...DEFAULT_LOOP, ...input };
  const sf = o.selfFaults ?? SelfFaults.fromEnv();
  const selfFault = (f: SelfFaultReport) => emit({ type: 'self-fault', ...f });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(o.stateDir, 'runs', runId);
  const ws = new Workspace(join(dir, 'ws'), o.targetDir);
  const checkpoints = new CheckpointStore(join(dir, 'checkpoints'));
  const memory = new StrategyMemory(join(o.stateDir, 'memory.json'));
  // A tournament replaces the single fixer with several entrants; validate them up front.
  const entrants: Fixer[] | undefined = o.tournament?.map(createEntrant);
  const fixer: Fixer = entrants
    ? { name: tournamentName(o.tournament!), propose: async () => null }
    : createFixer(o.fixer, { onSelfFault: selfFault, ...(sf ? { llm: sf.llm(), llmDeadlineMs: sf.llmDeadlineMs } : {}) });
  const targetRel = relative(process.cwd(), resolve(o.targetDir));

  // Each phase is its own root trace, grouped into one neatlogs session per run,
  // so "before" and "after" are separate traces you can open and compare.
  const phase = <T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>) =>
    trace({ name, kind: 'WORKFLOW', sessionId: `bulwark-${runId}`, sessionFeatureName: 'bulwark-loop', attributes: { runId, target: targetRel, fixer: fixer.name, ...attributes } }, fn);

  // Every LLM call and trial inside this run is counted on its own meter.
  const meter = new CostMeter();
  return meter.run(async () => {
    const original = await loadTarget(o.targetDir);
    const originalFiles = readFiles(o.targetDir, original.editableFiles);
    const scope: Fault[] = o.faults === 'all' ? faultsFor(original) : o.faults.map((id) => getFault(id, original));
    // Rules nothing else compiles go to the LLM rule compiler (cached; a no-op without a key).
    const ruleReport = await prepareRules(original).catch((err) => {
      emit({ type: 'log', message: `LLM rule compiler unavailable: ${err instanceof Error ? err.message : err}` });
      return undefined;
    });
    if (ruleReport) emit({ type: 'rules', rules: ruleReport });
    const rules = compileRules(original.rules, original.checks, { target: original.name }).compiled.map(({ rule, how }) => ({ rule, how }));
    const sloPlans = planSlo(o.slo, scope.map((f) => f.id));
    emit({ type: 'run-start', runId, target: original.name, fixer: fixer.name, faults: scope.map((f) => f.id), redTrials: o.redTrials, judgeTrials: o.judgeTrials });
    if (o.slo && sloPlans.length) emit({ type: 'slo-plan', plans: sloPlans, confidence: o.slo.confidence, method: sloPlans[0].method });

    // Red: find weak links, then measure the damage.
    const findings = await phase('1 red: analyze code', {}, async () => analyzeTarget(o.targetDir, original));
    // Provenance: which commit, and which Entire session and prompt, introduced each weak link.
    const provenance = attachProvenance(findings, o.targetDir);
    // Entire Graph: blast radius per weak link, and (below) fix-site search per fault. Queries run
    // against the original target in the repo: the loop's patched copies live in
    // .bulwark/runs/<id>/ws/, which is gitignored and outside the tree the graph indexes.
    const graph = targetRel.startsWith('..') ? undefined : graphFor(process.cwd());
    const blasts = attachBlast(findings, graph, targetRel);
    emit({ type: 'analyze', findings, provenance });
    emit({
      type: 'log',
      message: graph
        ? `Entire Graph: blast radius for ${blasts}/${findings.length} weak links`
        : `Entire Graph ${process.env.BULWARK_ENTIRE_GRAPH === '0' ? 'switched off (BULWARK_ENTIRE_GRAPH=0)' : 'not available (needs the `entire graph` plugin)'}; using static analysis only`,
    });

    const redOpts = { trials: o.redTrials, seed: o.seed, brain: o.brain, deadlineMs: o.deadlineMs, maxSteps: o.maxSteps, onSelfFault: selfFault, ...(sf ? { beforeTrial: sf.beforeTrial } : {}) };
    const before = await phase('2 red: attack scorecard BEFORE', { phase: 'before', trials: o.redTrials, seed: o.seed }, () => runAll(original, redOpts));
    emit({ type: 'scorecard', phase: 'before', results: Object.values(before), overall: overallPassRate(before) });

    // The Judge uses its own seeds, so a fix can't be tuned to the trials Red happened to run.
    const judgeOpts = { ...redOpts, trials: o.judgeTrials, seed: o.seed + 1_000_003 };
    emit({ type: 'log', message: `Judge measuring the unpatched code on fresh seeds (${o.judgeTrials} trials per fault)` });
    let baseFiles = originalFiles;
    let baseDir = o.targetDir;
    let baseTarget: BulwarkTarget = original;
    let baseResults = await phase('judge: measure unpatched code', { trials: o.judgeTrials }, () => runAll(original, judgeOpts));

    const highRisk = (f: Fault) => findings.some((x) => x.faults.includes(f.id) && x.severity === 'high');
    const ordered = [...scope].sort((a, b) => Number(highRisk(b)) - Number(highRisk(a)));
    const records: FaultRecord[] = [];
    let attempts = 0;
    let rollbacks = 0;
    const readbackWaitMs = Number.isFinite(o.readbackWaitMs) ? Math.max(0, o.readbackWaitMs!) : 20_000;
    const readCache = new Map<string, ReadResult>();
    const targetHash = hashFiles(originalFiles);
    const previous = previousFailures(o.stateDir, targetHash);

    for (const fault of ordered) {
      emit({ type: 'fault-start', fault: fault.id, title: fault.title, hypothesis: fault.hypothesis });
      const rec: FaultRecord = {
        fault: fault.id,
        title: fault.title,
        hypothesis: fault.hypothesis,
        status: 'unfixed',
        findings: findings.filter((f) => f.faults.includes(fault.id)),
        attempts: [],
      };
      records.push(rec);

      const skip =
        before[fault.id].passed === before[fault.id].trials
          ? 'already resilient: every trial passed'
          : baseResults[fault.id].passed === baseResults[fault.id].trials
            ? 'already resilient after earlier fixes in this run'
            : undefined;
      if (skip) {
        rec.status = 'skipped';
        rec.skipReason = skip;
        emit({ type: 'fault-skip', fault: fault.id, reason: skip });
        emit({ type: 'fault-done', fault: fault.id, status: rec.status, attempts: 0 });
        continue;
      }

      rec.before = baseResults[fault.id];

      // Observe: read a failing trial back from neatlogs. Oldest trace first: the previous run's on
      // the same code (minutes old), then this run's BEFORE scorecard (it ran earliest), then the
      // Judge's baseline; if no sampled trial failed, one failing seed is replayed traced.
      const candidates: ObserveCandidate[] = [
        ...(previous[fault.id] ?? []).map((e) => ({ seed: e.seed, traceId: e.traceId, source: 'previous' as const })),
        ...before[fault.id].examples.map((e) => ({ seed: e.seed, traceId: e.traceId, source: 'before' as const })),
        ...baseResults[fault.id].examples.map((e) => ({ seed: e.seed, traceId: e.traceId, source: 'judge' as const })),
      ];
      const down = sf?.neatlogs(); // self-chaos: neatlogs export and read-back are down for this fault
      let flushed = true;
      const observed = await observeFailure({
        fault: fault.id,
        candidates,
        waitMs: down ? Math.max(readbackWaitMs, 1000) : readbackWaitMs,
        cache: readCache,
        ...(down ? { apiKey: down.apiKey, fetcher: down.fetcher, pollMs: 250 } : {}),
        rerun: async (seed) => {
          const obs = await phase(`observe: replay failing ${fault.id} trial (seed ${seed})`, { fault: fault.id, seed }, () =>
            runTrial({ target: original, fault, seed, brain: o.brain, deadlineMs: o.deadlineMs, maxSteps: o.maxSteps, traced: true }),
          );
          // A hung exporter must not stall the loop: give it a bounded wait.
          flushed = await flushWithin(down?.flush ?? flush, 10_000);
          return obs.traceId ?? down?.traceId;
        },
      }).catch((err): Awaited<ReturnType<typeof observeFailure>> => {
        selfFault({ seam: 'neatlogs', fault: `observe step threw: ${err instanceof Error ? err.message : err}`, recovered: true, how: 'Blue used local evidence' });
        return { record: { fault: fault.id, status: 'unavailable', spans: 0, detections: 0, waitedMs: 0, reason: 'observe step failed' } };
      });
      if (down) {
        const r = observed.record;
        selfFault({
          seam: 'neatlogs',
          fault: down.fault,
          recovered: r.status !== 'read',
          how: `${flushed ? '' : 'trace export timed out (bounded wait, not a hang); '}read-back ${r.status}${r.reason ? ` (${r.reason})` : ''} after ${r.waitedMs}ms; Blue used local evidence`,
        });
      } else if (!flushed) {
        selfFault({ seam: 'neatlogs', fault: 'trace export did not finish within 10s', recovered: true, how: 'continued without waiting; Blue used local evidence' });
      }
      rec.observe = observed.record;
      emit({ type: 'observe', ...observed.record });
      // Entire Graph fix-site search for this fault, limited to the target's own files.
      const graphHints = graph?.search(fault.hypothesis, 3, targetRel) ?? undefined;

      const failed: FailedAttempt[] = [];
      const slo = sloPlans.find((p) => p.fault === fault.id);
      for (let round = 1; round <= o.maxAttempts; round++) {
        const cp = checkpoints.save(`before ${fault.id} ${entrants ? 'round' : 'attempt'} ${round}`, baseFiles, { fault: fault.id, attempt: round });
        emit({ type: 'checkpoint', action: 'save', id: cp.id, label: cp.label });

        const ctx = { target: original.name, fault, findings: rec.findings, files: baseFiles, before: baseResults[fault.id], failed, rules, preferred: o.memory ? memory.ranked(fault.kind) : [], neatlogsEvidence: observed.evidence, graphHints };
        const entries: Entry[] = await phase(`3 blue: propose fix for ${fault.id} #${round}`, { fault: fault.id, attempt: round, ...(entrants ? { tournament: true } : {}) }, async () =>
          entrants ? proposeAll(entrants, ctx) : [{ entrant: fixer.name, proposal: await proposeSafely(fixer, ctx, selfFault) }],
        );
        if (!entries.some((e) => e.proposal)) {
          emit({ type: 'log', message: `Blue has no further strategies for ${fault.id}${entrants ? ` (${entries.map((e) => `${e.entrant}: ${e.error}`).join('; ')})` : ''}` });
          break;
        }

        // The Judge verifies every candidate one at a time, so latency measurements don't compete for the CPU.
        const candidates: { entry: Entry; v?: Verdict; diffSize: number; n?: number }[] = [];
        for (const entry of entries) {
          const proposal = entry.proposal;
          if (!proposal) {
            candidates.push({ entry, diffSize: 0 });
            continue;
          }
          attempts++;
          const n = rec.attempts.length + 1;
          const diff = diffFiles(baseFiles, proposal.files, `${targetRel}/`);
          const stats = diffStats(diff);
          emit({ type: 'attempt', fault: fault.id, n, strategy: proposal.strategy, title: proposal.title, rationale: proposal.rationale, author: proposal.author, diff, ...stats, ...(entrants ? { round } : {}) });

          const candidateDir = ws.materialize(`${fault.id}-a${n}`, proposal.files);
          const broken = sf?.workspace(candidateDir, Object.keys(proposal.files).filter((p) => proposal.files[p] !== baseFiles[p]));
          const v = await phase(`4 judge: verify ${fault.id} #${n}`, { fault: fault.id, attempt: n, strategy: proposal.strategy }, () =>
            judge({ fault, candidate: () => loadTarget(candidateDir), baseResults, opts: judgeOpts, slo, budgets: o.budgets }),
          );
          if (v.reasons[0]?.startsWith('patched code failed to load')) {
            selfFault({ seam: 'workspace', fault: broken ? `${broken} injected into the patch` : v.reasons[0], recovered: v.status === 'rejected', how: 'the Judge rejected the attempt without running it; rolled back to the checkpoint' });
          }
          emit({
            type: 'verdict', fault: fault.id, n, status: v.status, reasons: v.reasons, pValue: v.pValue, afterPassed: v.after.passed, trials: v.after.trials, regressions: v.regressions,
            ...(v.slo ? { slo: v.slo } : {}), ...(v.overhead ? { overhead: v.overhead } : {}), ...(entrants ? { author: proposal.author, round } : {}),
          });
          rec.attempts.push({
            n,
            strategy: proposal.strategy,
            title: proposal.title,
            rationale: proposal.rationale,
            author: proposal.author,
            diff,
            checkpoint: cp.id,
            verdict: { status: v.status, reasons: v.reasons, pValue: v.pValue, afterPassed: v.after.passed, trials: v.after.trials, ...(v.slo ? { slo: v.slo } : {}), ...(v.overhead ? { overhead: v.overhead } : {}) },
          });
          memory.record(fault.kind, proposal.strategy, v.status === 'fixed');
          candidates.push({ entry, v, diffSize: stats.added + stats.removed, n });
        }

        let chosen = candidates.find((c) => c.v?.status === 'fixed');
        if (entrants) {
          const { ranking, winner } = rankContenders(
            candidates.map((c) => ({
              entrant: c.entry.entrant,
              status: c.v?.status ?? 'no-proposal',
              strategy: c.entry.proposal?.strategy,
              title: c.entry.proposal?.title,
              ...(c.v?.slo ? { sloDemonstrated: c.v.slo.demonstrated } : {}),
              ...(c.v?.overhead ? { overhead: c.v.overhead } : {}),
              diffSize: c.diffSize,
              summary: c.v?.reasons[0] ?? c.entry.error,
            })),
          );
          const t: TournamentResult = { fault: fault.id, round, entrants: entries.map((e) => e.entrant), ranking, ...(winner ? { winner } : {}) };
          (rec.tournament ??= []).push(t);
          for (const r of ranking) {
            const c = candidates.find((x) => x.entry.entrant === r.entrant);
            const a = c?.n !== undefined ? rec.attempts.find((x) => x.n === c.n) : undefined;
            if (a) a.tournament = { round, rank: r.rank, outcome: r.outcome, reason: r.reason };
          }
          emit({ type: 'tournament', ...t });
          chosen = winner ? candidates.find((c) => c.entry.entrant === winner) : undefined;
        }

        if (chosen?.v && chosen.entry.proposal) {
          const proposal = chosen.entry.proposal;
          const v = chosen.v;
          // Guard: ship a regression test and prove it fails without the fix.
          const spec: ChaosSpec = { fault: fault.id, trials: o.judgeTrials, seed: o.seed + 2_000_003, strategy: proposal.strategy, createdBy: 'bulwark' };
          const fixedFiles = withSpec(proposal.files, spec);
          const fixedDir = ws.materialize(`${fault.id}-accepted`, fixedFiles);
          const fixedTarget = await loadTarget(fixedDir);
          const m = await phase(`5 guard: prove regression test for ${fault.id}`, { fault: fault.id }, () =>
            mutationCheck(spec, baseTarget, fixedTarget, judgeOpts),
          );
          rec.mutation = { ok: m.ok, unfixedPassed: m.unfixed.passed, fixedPassed: m.fixed.passed, trials: spec.trials };
          emit({ type: 'mutation', fault: fault.id, ...rec.mutation });

          baseFiles = fixedFiles;
          baseDir = fixedDir;
          baseTarget = fixedTarget;
          baseResults = v.results;
          rec.status = 'fixed';
          break;
        }

        for (const c of candidates) {
          if (c.entry.proposal && c.v) failed.push({ strategy: c.entry.proposal.strategy, author: c.entry.proposal.author, rationale: c.entry.proposal.rationale, reasons: c.v.reasons });
        }
        const damaged = sf?.checkpoint(checkpoints.pathOf(cp.id));
        const restored = checkpoints.restoreVerified(cp.id);
        if (restored.issue) selfFault({ seam: 'checkpoint', fault: `${cp.id}: ${restored.issue}${damaged ? ' (injected)' : ''}`, recovered: true, how: 'restored the verified in-memory copy of the checkpoint' });
        baseFiles = restored.files;
        rollbacks++;
        emit({ type: 'checkpoint', action: 'restore', id: cp.id, label: cp.label });
      }
      emit({ type: 'fault-done', fault: fault.id, status: rec.status, attempts: rec.attempts.length });
    }

    // Red re-runs its original attack, same seeds, against the final code.
    const after = await phase('6 red: attack scorecard AFTER', { phase: 'after', trials: o.redTrials, seed: o.seed }, () => runAll(baseTarget, redOpts));
    // ws: the workspace holding the final code, so the dashboard can replay "after" trials against it.
    emit({ type: 'scorecard', phase: 'after', results: Object.values(after), overall: overallPassRate(after), ...(baseDir !== o.targetDir ? { ws: basename(baseDir) } : {}) });
    const residual = analyzeTarget(baseDir, baseTarget);
    emit({ type: 'residual', findings: residual });
    // One last look at neatlogs traces that weren't finalized when Blue needed them, for the postmortems.
    const late = await recheckPending(records.map((r) => r.observe), { cache: readCache });
    if (records.some((r) => r.observe?.traceId)) {
      const read = records.filter((r) => r.observe?.status === 'read').length;
      emit({ type: 'log', message: `neatlogs read-back: ${read}/${records.filter((r) => r.observe).length} failing-trial traces read${late ? ` (${late} only at the end of the run)` : ''}` });
    }

    const book = await loadPriceBook({ provider: llmProvider(), cachePath: join(o.stateDir, 'pricing-0g.json') });
    const cost = meter.summarize(book.priceFor, `0G router prices (${book.zgSource}); Anthropic-direct static table`);

    // Artifacts.
    mkdirSync(dir, { recursive: true });
    const patch = diffFiles(originalFiles, baseFiles, `${targetRel}/`);
    const traces = process.env.NEATLOGS_API_KEY ? 'exported to neatlogs (workflow "bulwark")' : 'local only (set NEATLOGS_API_KEY to export)';
    const artifacts = {
      patch: join(dir, 'fix.patch'),
      pr: join(dir, 'PR.md'),
      badge: join(dir, 'badge.svg'),
      postmortems: records.map((r) => join(dir, `postmortem-${r.fault}.md`)),
    };
    writeFileSync(artifacts.patch, patch);
    writeFileSync(artifacts.pr, prBody({ target: original.name, runId, records, before, after, diff: patch, traces, residual, provenance, cost }));
    writeFileSync(artifacts.badge, badgeSvg(overallPassRate(after)));
    records.forEach((r, i) => writeFileSync(artifacts.postmortems[i], postmortem(r, runId)));
    const meta = { run: runId, trials: o.redTrials, seed: o.seed };
    writeFileSync(join(dir, 'scorecard-before.md'), renderMarkdown(original, Object.values(before), meta));
    writeFileSync(join(dir, 'scorecard-after.md'), renderMarkdown(original, Object.values(after), meta));
    copyFileSync(artifacts.badge, join(o.stateDir, 'badge.svg'));
    if (o.memory) memory.save();

    const summary: LoopSummary = {
      runId,
      dir,
      target: original.name,
      fixer: fixer.name,
      overallBefore: overallPassRate(before),
      overallAfter: overallPassRate(after),
      fixed: records.filter((r) => r.status === 'fixed').map((r) => r.fault),
      unfixed: records.filter((r) => r.status === 'unfixed').map((r) => r.fault),
      skipped: records.filter((r) => r.status === 'skipped').map((r) => r.fault),
      attempts,
      rollbacks,
      residual,
      artifacts,
      finalFiles: baseFiles,
      targetRel,
      cost,
    };
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ...summary, targetHash, records, before, after }, null, 2));
    writeFileSync(join(o.stateDir, 'latest.json'), JSON.stringify({ runId, dir }, null, 2));
    emit({ type: 'run-done', summary });
    return summary;
  });
}

/** Content hash of the target's editable files, so a later run knows whether a past trace shows the same code. */
export function hashFiles(files: Files): string {
  const h = createHash('sha256');
  for (const path of Object.keys(files).sort()) h.update(`${path}\0${files[path]}\0`);
  return h.digest('hex').slice(0, 16);
}

/** The previous run's traced failing trials per fault, when it attacked exactly this code. */
export function previousFailures(stateDir: string, targetHash: string): Record<string, { seed: number; traceId: string }[]> {
  try {
    const { dir } = JSON.parse(readFileSync(join(stateDir, 'latest.json'), 'utf8')) as { dir: string };
    const prev = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { targetHash?: string; before?: Record<string, ExperimentResult> };
    if (prev.targetHash !== targetHash || !prev.before) return {};
    return Object.fromEntries(
      Object.entries(prev.before).map(([fault, r]) => [fault, r.examples.flatMap((e) => (e.traceId ? [{ seed: e.seed, traceId: e.traceId }] : []))]),
    );
  } catch {
    return {};
  }
}

function git(args: string[], cwd?: string): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/** Commits the verified fixes to a new branch via a throwaway worktree; the current checkout is untouched. */
export function applyAsBranch(summary: LoopSummary, stateDir = '.bulwark'): string {
  const branch = `bulwark/fix-${summary.runId}`;
  const wt = resolve(stateDir, 'worktrees', summary.runId);
  git(['worktree', 'add', '-q', '-b', branch, wt, 'HEAD']);
  try {
    for (const [path, content] of Object.entries(summary.finalFiles)) {
      const dest = join(wt, summary.targetRel, path);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, content);
    }
    git(['add', '-A'], wt);
    git(['commit', '-q', '-m', `Bulwark: verified resilience fixes for ${summary.target}\n\nFixed: ${summary.fixed.join(', ') || 'none'}\nRun: ${summary.runId}`], wt);
  } finally {
    git(['worktree', 'remove', '--force', wt]);
  }
  return branch;
}

/** Pushes the branch and opens a PR with the Bulwark report as its body. */
export function openPullRequest(branch: string, summary: LoopSummary): string {
  git(['push', '-u', 'origin', branch]);
  const res = spawnSync('gh', ['pr', 'create', '--head', branch, '--title', `Bulwark: resilience fixes for ${summary.target}`, '--body-file', summary.artifacts.pr], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`gh pr create failed: ${res.stderr.trim()}`);
  return res.stdout.trim();
}
