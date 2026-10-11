// Human-facing artifacts from a Bulwark run: a postmortem per fault, the PR
// description, and a resilience badge.

import type { MutationCheck } from '../guard';
import type { Verdict } from '../judge/judge';
import { describeOverhead } from '../judge/overhead';
import { describeSlo } from '../judge/slo';
import type { TournamentResult } from '../judge/tournament';
import type { Finding } from '../red/analyze';
import type { ExperimentResult } from '../scorecard';

export interface AttemptRecord {
  n: number;
  strategy: string;
  title: string;
  rationale: string;
  author: string;
  diff: string;
  checkpoint: string;
  verdict: Pick<Verdict, 'status' | 'reasons' | 'pValue' | 'slo' | 'overhead'> & { afterPassed: number; trials: number };
  /** Set when this attempt was one candidate in a fix tournament. */
  tournament?: { round: number; rank: number; outcome: 'winner' | 'loser' | 'no-winner'; reason: string };
}

/** The attempt that was applied: verdict fixed, and not a tournament loser. */
export const appliedAttempt = (rec: Pick<FaultRecord, 'attempts'>) =>
  rec.attempts.find((a) => a.verdict.status === 'fixed' && a.tournament?.outcome !== 'loser');

export interface FaultRecord {
  fault: string;
  title: string;
  hypothesis: string;
  status: 'fixed' | 'unfixed' | 'skipped';
  skipReason?: string;
  findings: Finding[];
  before?: ExperimentResult;
  attempts: AttemptRecord[];
  mutation?: Pick<MutationCheck, 'ok'> & { unfixedPassed: number; fixedPassed: number; trials: number };
  /** One entry per tournament round, when --tournament was used. */
  tournament?: TournamentResult[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const brokenRules = (r: ExperimentResult) =>
  Object.entries(r.violations)
    .filter(([, n]) => n > 0)
    .map(([rule, n]) => `${n}× ${rule}`)
    .join('; ') || 'none';

export function postmortem(rec: FaultRecord, runId: string): string {
  const winner = appliedAttempt(rec);
  const lines = [
    `# Postmortem: ${rec.fault}`,
    '',
    `**Run** ${runId} · **Status** ${rec.status === 'fixed' ? '✅ fixed and verified' : rec.status === 'skipped' ? `⏭ skipped (${rec.skipReason})` : '❌ not fixed'}`,
    '',
    '## Hypothesis',
    rec.hypothesis,
    '',
  ];
  if (rec.before) {
    lines.push(
      '## Blast radius (before)',
      `${rec.before.passed}/${rec.before.trials} trials passed (95% CI ${pct(rec.before.ci95[0])}–${pct(rec.before.ci95[1])}).`,
      `Outcomes: ${Object.entries(rec.before.outcomes).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}. Broken rules: ${brokenRules(rec.before).replace(/\.$/, '')}.`,
      ...rec.before.examples.map((e) => `- Replay: seed ${e.seed} → ${e.rule} (${e.detail ?? ''})`),
      '',
    );
  }
  if (rec.findings.length) {
    lines.push('## Weak links found in the code', ...rec.findings.map((f) => `- \`${f.file}:${f.line}\` ${f.why}`), '');
  }
  if (rec.attempts.length) {
    lines.push('## Attempts', '');
    for (const a of rec.attempts) {
      const icon = a.verdict.status === 'fixed' ? '✅' : a.verdict.status === 'inconclusive' ? '❔' : '❌';
      lines.push(
        `### ${icon} Attempt ${a.n}: ${a.title} (\`${a.strategy}\`, by ${a.author}${a.tournament ? `, tournament round ${a.tournament.round}` : ''})`,
        a.rationale,
        '',
        `Checkpoint before attempt: \`${a.checkpoint}\`. Judge: **${a.verdict.status}**. ${a.verdict.reasons.join('; ')}.`,
        ...(a.verdict.overhead ? [`Overhead: ${describeOverhead(a.verdict.overhead)}.`] : []),
        a.tournament
          ? a.tournament.outcome === 'winner'
            ? `🏆 Tournament winner: ${a.tournament.reason}.`
            : `Not applied (rank ${a.tournament.rank}): ${a.tournament.reason}.`
          : a.verdict.status === 'fixed'
            ? ''
            : `Rolled back to \`${a.checkpoint}\`.`,
        '',
      );
    }
  }
  if (rec.tournament?.length) {
    lines.push('## Fix tournament', '');
    for (const t of rec.tournament) {
      lines.push(
        `Round ${t.round}: ${t.entrants.join(' vs ')} → ${t.winner ? `**${t.winner}** wins` : 'no winner, all candidates rolled back'}`,
        '',
        '| Rank | Entrant | Strategy | Verdict | SLO | Happy-path overhead | Diff | Outcome |',
        '|---|---|---|---|---|---|---|---|',
        ...t.ranking.map(
          (c) =>
            `| ${c.rank} | ${c.entrant} | ${c.strategy ?? '—'} | ${c.status} | ${c.sloDemonstrated === undefined ? '—' : c.sloDemonstrated ? 'demonstrated' : 'not demonstrated'} | ${c.overhead ? `steps ${c.overhead.after.avgSteps.toFixed(1)}, p50 ${Math.round(c.overhead.after.p50Ms)}ms${c.overhead.after.costPerRunUsd !== undefined ? `, $${c.overhead.after.costPerRunUsd.toFixed(4)}/run` : ''}` : '—'} | ${c.diffSize} | ${c.outcome}: ${c.reason} |`,
        ),
        '',
      );
    }
  }
  if (winner) {
    lines.push('## Root cause and fix', winner.rationale, '', '```diff', winner.diff.trimEnd(), '```', '');
    if (winner.verdict.slo) lines.push('## Reliability target', `${describeSlo(winner.verdict.slo)}. Method: ${winner.verdict.slo.method}.`, '');
    if (winner.verdict.overhead) {
      const o = winner.verdict.overhead;
      lines.push(
        '## Overhead',
        `Compared with the unpatched code on the no-fault baseline (${o.after.runs} runs): ${describeOverhead(o)}.`,
        ...(o.underFault ? [`Under ${rec.fault} (informational, not budgeted): p50 ${Math.round(o.underFault.before.p50Ms)}→${Math.round(o.underFault.after.p50Ms)}ms, avg steps ${o.underFault.before.avgSteps.toFixed(1)}→${o.underFault.after.avgSteps.toFixed(1)}.`] : []),
        o.withinBudget ? '' : `⚠️ Fixed with overhead: ${o.exceeded.join('; ')}.`,
        '',
      );
    }
  }
  if (rec.mutation) {
    const m = rec.mutation;
    lines.push(
      '## Proof the regression test guards the fix',
      `With the fix removed: ${m.unfixedPassed}/${m.trials} passed. With the fix: ${m.fixedPassed}/${m.trials} passed. ${m.ok ? '✅ The test catches the bug.' : '❌ The test does not distinguish fixed from unfixed code.'}`,
      '',
    );
  }
  return lines.join('\n');
}

export function prBody(args: {
  target: string;
  runId: string;
  records: FaultRecord[];
  before: Record<string, ExperimentResult>;
  after: Record<string, ExperimentResult>;
  diff: string;
  traces: string;
  residual: Finding[];
}): string {
  const fixed = args.records.filter((r) => r.status === 'fixed');
  const rows = Object.keys(args.before).map((id) => {
    const b = args.before[id];
    const a = args.after[id];
    return `| ${id} | ${b.passed}/${b.trials} | ${a.passed}/${a.trials} | ${pct(a.ci95[0])}–${pct(a.ci95[1])} |`;
  });
  return [
    `## Bulwark: resilience fixes for ${args.target}`,
    '',
    `Bulwark attacked \`${args.target}\` with ${Object.keys(args.before).length - 1} faults, fixed ${fixed.length}, and verified each fix on fresh seeds with an independent Judge.`,
    '',
    '| Fault | Before | After | After 95% CI |',
    '|---|---|---|---|',
    ...rows,
    '',
    '### Fixes',
    ...fixed.map((r) => {
      const w = appliedAttempt(r)!;
      const tries = r.tournament?.length
        ? ` (tournament: ${w.author} beat ${r.tournament.at(-1)!.ranking.filter((c) => c.outcome === 'loser').map((c) => `${c.entrant}, ${c.reason}`).join('; ') || 'no other entrant'})`
        : r.attempts.length > 1
          ? ` (attempt ${w.n}; ${r.attempts.length - 1} rejected and rolled back first)`
          : '';
      const overhead = w.verdict.overhead ? ` Overhead: ${describeOverhead(w.verdict.overhead)}${w.verdict.overhead.withinBudget ? '' : ` ⚠️ fixed with overhead (${w.verdict.overhead.exceeded.join('; ')})`}.` : '';
      return `- **${r.fault}**: ${w.title}${tries}. ${w.verdict.reasons.join('; ')}.${overhead}`;
    }),
    ...args.records.filter((r) => r.status === 'skipped').map((r) => `- **${r.fault}**: no change needed (${r.skipReason})`),
    '',
    ...sloSection(args.records),
    '### Remaining risk',
    ...(args.residual.length
      ? args.residual.map((f) => `- \`${f.file}:${f.line}\` ${f.why}. Every attack now passes, but the weak link is still in the code.`)
      : ['- The analyzer finds no remaining weak links.']),
    '',
    '### Evidence',
    '- Each fix ships a chaos regression test in `chaos-tests/`, proven to fail without the fix and pass with it.',
    `- Postmortems: \`.bulwark/runs/${args.runId}/postmortem-*.md\``,
    `- Traces: ${args.traces}`,
    '',
    '<details><summary>Full diff</summary>',
    '',
    '```diff',
    args.diff.trimEnd(),
    '```',
    '</details>',
    '',
    '_A human reviews and merges. Bulwark never pushes to main._',
    '',
  ].join('\n');
}

function sloSection(records: FaultRecord[]): string[] {
  const rows = records.flatMap((r) => {
    const a = appliedAttempt(r) ?? r.attempts.at(-1);
    return a?.verdict.slo ? [`- **${r.fault}**: ${describeSlo(a.verdict.slo)}.`] : [];
  });
  if (!rows.length) return [];
  const method = records.flatMap((r) => r.attempts).find((a) => a.verdict.slo)!.verdict.slo!.method;
  return ['### Reliability targets (SLO)', ...rows, `_Method: ${method}. "Demonstrated" means every planned trial passed; nothing stronger is claimed._`, ''];
}

export function badgeSvg(passRate: number): string {
  const label = 'resilience';
  const value = `${Math.round(passRate * 100)}%`;
  const color = passRate >= 0.95 ? '#1f9d55' : passRate >= 0.8 ? '#d97706' : '#dc2626';
  const lw = 74;
  const vw = 46;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${label}: ${value}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${lw + vw}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${lw + vw}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${label}</text><text x="${lw + vw / 2}" y="14">${value}</text></g>
</svg>
`;
}

/** Overall resilience: share of trials across every fault that kept every rule. */
export function overallPassRate(results: Record<string, ExperimentResult>): number {
  const all = Object.values(results);
  const trials = all.reduce((s, r) => s + r.trials, 0);
  return trials ? all.reduce((s, r) => s + r.passed, 0) / trials : 0;
}
