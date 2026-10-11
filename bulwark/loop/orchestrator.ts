// The Bulwark loop: Red analyzes and attacks, Blue proposes fixes, the Judge
// verifies each one on fresh seeds, the Guard proves the regression test, and
// rejected fixes are rolled back to the last checkpoint. Every step is emitted
// as an event (for the CLI and the live dashboard) and traced to neatlogs.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { trace } from 'neatlogs';
import { createFixer, type FailedAttempt, type Fixer } from '../blue/fixer';
import { FAULTS, getFault, type Fault } from '../chaos/faults';
import { CheckpointStore } from '../checkpoints';
import { mutationCheck, withSpec, type ChaosSpec } from '../guard';
import { judge, runAll, type Regression, type Verdict, type VerdictStatus } from '../judge/judge';
import type { Overhead, OverheadBudgets } from '../judge/overhead';
import { planSlo, type SloPlan, type SloResult, type SloSpec } from '../judge/slo';
import { createEntrant, proposeAll, rankContenders, tournamentName, type Entry, type TournamentResult } from '../judge/tournament';
import { StrategyMemory } from '../memory';
import { compileRules } from '../invariants';
import { analyzeTarget, type Finding } from '../red/analyze';
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
};

export type LoopEvent =
  | { type: 'run-start'; runId: string; target: string; fixer: string; faults: string[]; redTrials: number; judgeTrials: number }
  | { type: 'analyze'; findings: Finding[] }
  | { type: 'scorecard'; phase: 'before' | 'after'; results: ExperimentResult[]; overall: number }
  | { type: 'fault-start'; fault: string; title: string; hypothesis: string }
  | { type: 'fault-skip'; fault: string; reason: string }
  | { type: 'checkpoint'; action: 'save' | 'restore'; id: string; label: string }
  | { type: 'slo-plan'; plans: SloPlan[]; confidence: number; method: string }
  | { type: 'attempt'; fault: string; n: number; strategy: string; title: string; rationale: string; author: string; diff: string; added: number; removed: number; round?: number }
  | { type: 'verdict'; fault: string; n: number; status: VerdictStatus; reasons: string[]; pValue: number; afterPassed: number; trials: number; regressions: Regression[]; slo?: SloResult; overhead?: Overhead; author?: string; round?: number }
  | ({ type: 'tournament' } & TournamentResult)
  | { type: 'mutation'; fault: string; ok: boolean; unfixedPassed: number; fixedPassed: number; trials: number }
  | { type: 'fault-done'; fault: string; status: FaultRecord['status']; attempts: number }
  | { type: 'residual'; findings: Finding[] }
  | { type: 'log'; message: string }
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
}

export async function runLoop(input: Partial<LoopOptions> & { targetDir: string }, emit: (e: LoopEvent) => void): Promise<LoopSummary> {
  const o: LoopOptions = { ...DEFAULT_LOOP, ...input };
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(o.stateDir, 'runs', runId);
  const ws = new Workspace(join(dir, 'ws'), o.targetDir);
  const checkpoints = new CheckpointStore(join(dir, 'checkpoints'));
  const memory = new StrategyMemory(join(o.stateDir, 'memory.json'));
  // A tournament replaces the single fixer with several entrants; validate them up front.
  const entrants: Fixer[] | undefined = o.tournament?.map(createEntrant);
  const fixer: Fixer = entrants ? { name: tournamentName(o.tournament!), propose: async () => null } : createFixer(o.fixer);
  const targetRel = relative(process.cwd(), resolve(o.targetDir));

  // Each phase is its own root trace, grouped into one neatlogs session per run,
  // so "before" and "after" are separate traces you can open and compare.
  const phase = <T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>) =>
    trace({ name, kind: 'WORKFLOW', sessionId: `bulwark-${runId}`, sessionFeatureName: 'bulwark-loop', attributes: { runId, target: targetRel, fixer: fixer.name, ...attributes } }, fn);

  return (async () => {
    const original = await loadTarget(o.targetDir);
    const originalFiles = readFiles(o.targetDir, original.editableFiles);
    const scope: Fault[] = o.faults === 'all' ? FAULTS : o.faults.map(getFault);
    const rules = compileRules(original.rules).compiled.map(({ rule, how }) => ({ rule, how }));
    const sloPlans = planSlo(o.slo, scope.map((f) => f.id));
    emit({ type: 'run-start', runId, target: original.name, fixer: fixer.name, faults: scope.map((f) => f.id), redTrials: o.redTrials, judgeTrials: o.judgeTrials });
    if (o.slo && sloPlans.length) emit({ type: 'slo-plan', plans: sloPlans, confidence: o.slo.confidence, method: sloPlans[0].method });

    // Red: find weak links, then measure the damage.
    const findings = await phase('1 red: analyze code', {}, async () => analyzeTarget(o.targetDir, original));
    emit({ type: 'analyze', findings });

    const redOpts = { trials: o.redTrials, seed: o.seed, brain: o.brain, deadlineMs: o.deadlineMs, maxSteps: o.maxSteps };
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
      const failed: FailedAttempt[] = [];
      const slo = sloPlans.find((p) => p.fault === fault.id);
      for (let round = 1; round <= o.maxAttempts; round++) {
        const cp = checkpoints.save(`before ${fault.id} ${entrants ? 'round' : 'attempt'} ${round}`, baseFiles, { fault: fault.id, attempt: round });
        emit({ type: 'checkpoint', action: 'save', id: cp.id, label: cp.label });

        const ctx = { fault, findings: rec.findings, files: baseFiles, before: baseResults[fault.id], failed, rules, preferred: o.memory ? memory.ranked(fault.kind) : [] };
        const entries: Entry[] = await phase(`3 blue: propose fix for ${fault.id} #${round}`, { fault: fault.id, attempt: round, ...(entrants ? { tournament: true } : {}) }, async () =>
          entrants ? proposeAll(entrants, ctx) : [{ entrant: fixer.name, proposal: await fixer.propose(ctx) }],
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
          const v = await phase(`4 judge: verify ${fault.id} #${n}`, { fault: fault.id, attempt: n, strategy: proposal.strategy }, () =>
            judge({ fault, candidate: () => loadTarget(candidateDir), baseResults, opts: judgeOpts, slo, budgets: o.budgets }),
          );
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
        baseFiles = checkpoints.restore(cp.id);
        rollbacks++;
        emit({ type: 'checkpoint', action: 'restore', id: cp.id, label: cp.label });
      }
      emit({ type: 'fault-done', fault: fault.id, status: rec.status, attempts: rec.attempts.length });
    }

    // Red re-runs its original attack, same seeds, against the final code.
    const after = await phase('6 red: attack scorecard AFTER', { phase: 'after', trials: o.redTrials, seed: o.seed }, () => runAll(baseTarget, redOpts));
    emit({ type: 'scorecard', phase: 'after', results: Object.values(after), overall: overallPassRate(after) });
    const residual = analyzeTarget(baseDir, baseTarget);
    emit({ type: 'residual', findings: residual });

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
    writeFileSync(artifacts.pr, prBody({ target: original.name, runId, records, before, after, diff: patch, traces, residual }));
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
    };
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ...summary, records, before, after }, null, 2));
    writeFileSync(join(o.stateDir, 'latest.json'), JSON.stringify({ runId, dir }, null, 2));
    emit({ type: 'run-done', summary });
    return summary;
  })();
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
