// Human-facing artifacts from a Bulwark run: a postmortem per fault, the PR
// description, and a resilience badge.

import type { MutationCheck } from '../guard';
import type { Verdict } from '../judge/judge';
import { describeProvenance, summarizeProvenance, type Provenance } from '../provenance/entire';
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
  verdict: Pick<Verdict, 'status' | 'reasons' | 'pValue'> & { afterPassed: number; trials: number };
}

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
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const brokenRules = (r: ExperimentResult) =>
  Object.entries(r.violations)
    .filter(([, n]) => n > 0)
    .map(([rule, n]) => `${n}× ${rule}`)
    .join('; ') || 'none';

export function postmortem(rec: FaultRecord, runId: string): string {
  const winner = rec.attempts.find((a) => a.verdict.status === 'fixed');
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
    lines.push(
      '## Weak links found in the code',
      ...rec.findings.map((f) => `- \`${f.file}:${f.line}\` ${f.why}${f.provenance ? `\n  - Provenance: ${describeProvenance(f.provenance)}` : ''}`),
      '',
    );
  }
  if (rec.attempts.length) {
    lines.push('## Attempts', '');
    for (const a of rec.attempts) {
      const icon = a.verdict.status === 'fixed' ? '✅' : a.verdict.status === 'inconclusive' ? '❔' : '❌';
      lines.push(
        `### ${icon} Attempt ${a.n}: ${a.title} (\`${a.strategy}\`, by ${a.author})`,
        a.rationale,
        '',
        `Checkpoint before attempt: \`${a.checkpoint}\`. Judge: **${a.verdict.status}**. ${a.verdict.reasons.join(' ')}`,
        a.verdict.status === 'fixed' ? '' : `Rolled back to \`${a.checkpoint}\`.`,
        '',
      );
    }
  }
  if (winner) {
    lines.push('## Root cause and fix', winner.rationale, '', '```diff', winner.diff.trimEnd(), '```', '');
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
  /** Where the weak links came from (bulwark/provenance). */
  provenance?: Provenance[];
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
      const w = r.attempts.find((a) => a.verdict.status === 'fixed')!;
      const tries = r.attempts.length > 1 ? ` (attempt ${w.n}; ${r.attempts.length - 1} rejected and rolled back first)` : '';
      return `- **${r.fault}**: ${w.title}${tries}. ${w.verdict.reasons.join(' ')}`;
    }),
    ...args.records.filter((r) => r.status === 'skipped').map((r) => `- **${r.fault}**: no change needed (${r.skipReason})`),
    '',
    '### Remaining risk',
    ...(args.residual.length
      ? args.residual.map((f) => `- \`${f.file}:${f.line}\` ${f.why}. Every attack now passes, but the weak link is still in the code.`)
      : ['- The analyzer finds no remaining weak links.']),
    '',
    ...(args.provenance?.length ? ['### Provenance', ...summarizeProvenance(args.provenance).map((l) => `- ${l}`), ''] : []),
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
