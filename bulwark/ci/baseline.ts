// CI resilience gate: an offline scorecard per target (simulated brain, fixed
// seed, no keys) compared against a committed baseline
// (targets/<t>/resilience-baseline.json). A change that makes the agent pass
// fewer trials under any fault than the baseline fails the check.
//
// Pure functions only (no I/O), so the comparison is unit-tested.

import type { ExperimentResult } from '../scorecard';
import { combineRisk, money } from '../risk';

export const BASELINE_FILE = 'resilience-baseline.json';
export const COMMENT_MARKER = '<!-- bulwark-ci-scorecard -->';

export interface ResilienceBaseline {
  target: string;
  trials: number;
  seed: number;
  brain: 'simulated';
  /** Share of all trials (baseline row included) that kept every rule. */
  overall: number;
  faults: Record<string, { passed: number; trials: number }>;
  updatedAt: string;
}

export type FaultStatus = 'same' | 'improved' | 'regressed' | 'new' | 'removed';

export interface FaultComparison {
  fault: string;
  status: FaultStatus;
  baseline?: { passed: number; trials: number };
  current?: { passed: number; trials: number };
}

export interface BaselineComparison {
  target: string;
  /** False when any fault the baseline knows lost trials (beyond the tolerance), or was removed. */
  ok: boolean;
  /** Overall resilience now / in the baseline, over the faults both know. */
  overall: number;
  baselineOverall?: number;
  faults: FaultComparison[];
  /** Short reasons the check failed (empty when ok). */
  failures: string[];
  /** True when there's no committed baseline yet: reported, never failed. */
  missingBaseline: boolean;
  /** Settings mismatch (trials/seed) makes the comparison meaningless; reported as a failure. */
  mismatch?: string;
}

export function buildBaseline(target: string, results: ExperimentResult[], opts: { trials: number; seed: number }, now = new Date()): ResilienceBaseline {
  const trials = results.reduce((s, r) => s + r.trials, 0);
  return {
    target,
    trials: opts.trials,
    seed: opts.seed,
    brain: 'simulated',
    overall: trials ? round4(results.reduce((s, r) => s + r.passed, 0) / trials) : 0,
    faults: Object.fromEntries(results.map((r) => [r.fault, { passed: r.passed, trials: r.trials }])),
    updatedAt: now.toISOString(),
  };
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Validates a parsed baseline file; throws with a clear message when it's malformed. */
export function parseBaseline(raw: unknown): ResilienceBaseline {
  const b = raw as ResilienceBaseline;
  if (!b || typeof b !== 'object' || typeof b.target !== 'string' || !Number.isInteger(b.trials) || !Number.isInteger(b.seed) || typeof b.faults !== 'object' || !b.faults) {
    throw new Error('malformed resilience baseline (expected target, trials, seed, faults)');
  }
  for (const [id, f] of Object.entries(b.faults)) {
    if (!Number.isInteger(f?.passed) || !Number.isInteger(f?.trials) || f.passed < 0 || f.passed > f.trials) throw new Error(`malformed baseline entry for ${id}`);
  }
  return b;
}

/**
 * Compares a fresh scorecard with the baseline. A fault regresses when it passes
 * more than `tolerance` fewer trials than the baseline. New faults (not in the
 * baseline yet) are reported but never fail; a fault that vanished fails, so
 * resilience can't be "improved" by deleting an attack.
 */
export function compareToBaseline(
  target: string,
  results: ExperimentResult[],
  baseline: ResilienceBaseline | undefined,
  opts: { trials: number; seed: number; tolerance?: number } = { trials: 0, seed: 0 },
): BaselineComparison {
  const tol = Math.max(0, opts.tolerance ?? 0);
  const current = new Map(results.map((r) => [r.fault, { passed: r.passed, trials: r.trials }]));
  if (!baseline) {
    const all = results.reduce((s, r) => s + r.trials, 0);
    return {
      target,
      ok: true,
      overall: all ? results.reduce((s, r) => s + r.passed, 0) / all : 0,
      faults: results.map((r) => ({ fault: r.fault, status: 'new', current: current.get(r.fault) })),
      failures: [],
      missingBaseline: true,
    };
  }
  const faults: FaultComparison[] = [];
  const failures: string[] = [];
  let mismatch: string | undefined;
  if (baseline.trials !== opts.trials || baseline.seed !== opts.seed) {
    mismatch = `baseline was recorded with ${baseline.trials} trials, seed ${baseline.seed}; this run used ${opts.trials} trials, seed ${opts.seed}`;
    failures.push(mismatch);
  }
  for (const [id, b] of Object.entries(baseline.faults)) {
    const c = current.get(id);
    if (!c) {
      faults.push({ fault: id, status: 'removed', baseline: b });
      failures.push(`${id}: in the baseline but no longer attacked`);
      continue;
    }
    const status: FaultStatus = c.passed < b.passed - tol ? 'regressed' : c.passed > b.passed ? 'improved' : 'same';
    if (status === 'regressed') failures.push(`${id}: ${c.passed}/${c.trials} passed, baseline ${b.passed}/${b.trials}`);
    faults.push({ fault: id, status, baseline: b, current: c });
  }
  for (const r of results) if (!(r.fault in baseline.faults)) faults.push({ fault: r.fault, status: 'new', current: current.get(r.fault) });

  // Overall over the faults both sides know, so a new fault doesn't move the needle by itself.
  const common = faults.filter((f) => f.baseline && f.current);
  const sum = (pick: (f: FaultComparison) => { passed: number; trials: number }) => {
    const t = common.reduce((s, f) => s + pick(f).trials, 0);
    return t ? common.reduce((s, f) => s + pick(f).passed, 0) / t : 0;
  };
  return {
    target,
    ok: failures.length === 0,
    overall: sum((f) => f.current!),
    baselineOverall: sum((f) => f.baseline!),
    faults,
    failures,
    missingBaseline: false,
    ...(mismatch ? { mismatch } : {}),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const badgeColor = (x: number) => (x >= 0.95 ? 'brightgreen' : x >= 0.8 ? 'orange' : 'red');

/** A shields.io badge line for the resilience score (rendered by GitHub, no secrets involved). */
export function badgeLine(target: string, overall: number): string {
  return `![${target} resilience](https://img.shields.io/badge/${encodeURIComponent(`${target} resilience`).replace(/-/g, '--')}-${encodeURIComponent(pct(overall))}-${badgeColor(overall)})`;
}

const ICON: Record<FaultStatus, string> = { same: '·', improved: '⬆️ improved', regressed: '🔻 regressed', new: '🆕 new', removed: '❌ removed' };

/** The markdown for one target: badge line, verdict, and the scorecard table with the baseline column. */
export function renderTargetMarkdown(cmp: BaselineComparison, results: ExperimentResult[]): string {
  const byId = new Map(results.map((r) => [r.fault, r]));
  const priced = results.some((r) => r.dollarsAtRisk);
  const verdict = cmp.missingBaseline
    ? `⚠️ No committed baseline yet. Run \`npm run ci:scorecard -- --target ${cmp.target} --update-baseline\` and commit \`targets/${cmp.target}/${BASELINE_FILE}\`.`
    : cmp.ok
      ? `✅ Resilience held: ${pct(cmp.overall)} vs baseline ${pct(cmp.baselineOverall ?? 0)}.`
      : `❌ Resilience dropped below the committed baseline: ${pct(cmp.overall)} vs ${pct(cmp.baselineOverall ?? 0)}.`;
  const lines = [
    `### ${cmp.target}`,
    '',
    `${badgeLine(cmp.target, cmp.overall)} ${verdict}`,
    '',
    `| Fault | Pass | Baseline | 95% CI | Crashed | Hung | Runaway |${priced ? ' $ at risk / 1k |' : ''} Change |`,
    `|---|---|---|---|---|---|---|${priced ? '---|' : ''}---|`,
  ];
  for (const f of cmp.faults) {
    const r = byId.get(f.fault);
    const b = f.baseline ? `${f.baseline.passed}/${f.baseline.trials}` : '—';
    if (!r) {
      lines.push(`| ${f.fault} | — | ${b} | — | — | — | — |${priced ? ' — |' : ''} ${ICON[f.status]} |`);
      continue;
    }
    const risk = r.dollarsAtRisk ? money(r.dollarsAtRisk.per1kTickets) : '—';
    lines.push(
      `| ${f.fault} | ${r.passed}/${r.trials} | ${b} | ${pct(r.ci95[0])}–${pct(r.ci95[1])} | ${r.outcomes.crashed} | ${r.outcomes.hung} | ${r.outcomes.runaway} |${priced ? ` ${risk} |` : ''} ${ICON[f.status]} |`,
    );
  }
  const attacked = results.filter((r) => r.fault !== 'baseline' && r.dollarsAtRisk).map((r) => r.dollarsAtRisk!);
  if (attacked.length) lines.push('', `Dollars at risk across the attack suite: **${money(combineRisk(attacked).per1kTickets)} per 1,000 tickets**.`);
  if (cmp.failures.length) lines.push('', '**Why the check failed**', ...cmp.failures.map((f) => `- ${f}`));
  return lines.join('\n');
}

/** The whole sticky PR comment: marker (so it can be found and updated), one section per target, footer. */
export function renderComment(sections: { cmp: BaselineComparison; results: ExperimentResult[] }[], meta: { trials: number; seed: number; runUrl?: string }): string {
  const ok = sections.every((s) => s.cmp.ok);
  return [
    COMMENT_MARKER,
    `## 🛡️ Bulwark chaos scorecard ${ok ? '✅' : '❌'}`,
    '',
    sections.length
      ? `Offline chaos run (simulated brain, ${meta.trials} trials per fault, seed ${meta.seed}, no API keys) compared against each target's committed \`${BASELINE_FILE}\`.`
      : 'No target under `targets/` changed in this PR, so no chaos scorecard was run.',
    '',
    ...sections.flatMap((s) => [renderTargetMarkdown(s.cmp, s.results), '']),
    `<sub>${meta.runUrl ? `[Workflow run and scorecard artifact](${meta.runUrl}) · ` : ''}Comment \`/bulwark help\` for ChatOps commands. To accept a new resilience level, run \`npm run ci:scorecard -- --target <name> --update-baseline\` and commit the baseline.</sub>`,
    '',
  ].join('\n');
}
