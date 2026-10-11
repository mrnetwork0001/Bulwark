// npm run ci:scorecard -- [--target refundbot,researchbot|all] [--changed-from <git ref>] [--trials N] [--seed 42]
//                         [--tolerance 0] [--out .bulwark/ci] [--update-baseline] [--run-url <url>]
//
// The CI resilience gate. Runs the offline chaos scorecard (simulated brain, no
// keys) for each target, compares it with targets/<t>/resilience-baseline.json,
// writes scorecard.md (the sticky PR comment) + scorecard.json, and exits 1 when
// any target is less resilient than its committed baseline.
// --update-baseline rewrites the baseline from this run instead of comparing.

import '../env';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { faultsFor, type Fault } from '../chaos/faults';
import { renderMarkdown, runExperiment, type ExperimentResult } from '../scorecard';
import { listTargets, loadTarget, resolveTargetDir } from '../target';
import { initTracing, shutdownTracing } from '../tracing';
import { BASELINE_FILE, buildBaseline, compareToBaseline, parseBaseline, renderComment, type BaselineComparison, type ResilienceBaseline } from './baseline';

const DEFAULT_TRIALS = 20;
const DEFAULT_SEED = 42;

/** Targets touched since `ref`. A change to Bulwark's own engine or dependencies re-checks every target. */
function changedTargets(ref: string): string[] {
  if (!/^[\w./~^-]{1,200}$/.test(ref)) throw new Error('--changed-from must be a plain git ref or sha');
  const res = spawnSync('git', ['diff', '--name-only', `${ref}...HEAD`], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git diff failed: ${res.stderr.trim()}`);
  const files = res.stdout.split('\n').filter(Boolean);
  const known = listTargets();
  if (files.some((f) => f.startsWith('bulwark/') || f === 'package.json' || f === 'package-lock.json')) return known;
  return [...new Set(files.filter((f) => f.startsWith('targets/')).map((f) => f.split('/')[1]))].filter((t) => known.includes(t)).sort();
}

function readBaseline(dir: string): ResilienceBaseline | undefined {
  const path = join(dir, BASELINE_FILE);
  return existsSync(path) ? parseBaseline(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'changed-from': { type: 'string' },
      trials: { type: 'string' },
      seed: { type: 'string' },
      tolerance: { type: 'string', default: '0' },
      out: { type: 'string', default: join('.bulwark', 'ci') },
      'update-baseline': { type: 'boolean', default: false },
      'run-url': { type: 'string' },
    },
  });
  const names = values['changed-from']
    ? changedTargets(values['changed-from'])
    : !values.target || values.target === 'all'
      ? listTargets()
      : values.target.split(',').map((t) => t.trim()).filter(Boolean);
  const tolerance = Number(values.tolerance);
  if (!(tolerance >= 0)) throw new Error('--tolerance must be a non-negative number of trials');

  const exporting = await initTracing('bulwark-ci');
  console.log(`Bulwark CI scorecard → ${names.join(', ') || '(no changed targets)'} | neatlogs ${exporting ? 'exporting' : 'local only'}`);
  mkdirSync(values.out!, { recursive: true });

  const sections: { cmp: BaselineComparison; results: ExperimentResult[] }[] = [];
  let shown = { trials: Number(values.trials ?? DEFAULT_TRIALS), seed: Number(values.seed ?? DEFAULT_SEED) };
  for (const name of names) {
    const dir = resolveTargetDir(name); // allowlist: throws for anything not under targets/
    const target = await loadTarget(dir);
    const baseline = values['update-baseline'] ? undefined : readBaseline(dir);
    // Same settings as the baseline unless overridden, so the comparison is apples to apples.
    const trials = Number(values.trials ?? baseline?.trials ?? DEFAULT_TRIALS);
    const seed = Number(values.seed ?? baseline?.seed ?? DEFAULT_SEED);
    if (!Number.isInteger(trials) || trials < 1 || trials > 1000) throw new Error('--trials must be 1..1000');
    if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');
    shown = { trials, seed };

    const faults: (Fault | undefined)[] = [undefined, ...faultsFor(target)];
    const opts = { trials, seed, brain: 'simulated' as const, deadlineMs: 5000, maxSteps: 50, sessionId: `ci-${target.name}-${Date.now()}` };
    const results: ExperimentResult[] = [];
    for (const fault of faults) {
      const r = await runExperiment(target, fault, opts);
      console.log(`  ${target.name.padEnd(12)} ${(fault?.id ?? 'baseline').padEnd(22)} ${r.passed}/${r.trials}`);
      results.push(r);
    }
    writeFileSync(join(values.out!, `${target.name}.md`), renderMarkdown(target, results, { trials, seed, brain: 'simulated', date: new Date().toISOString() }));

    if (values['update-baseline']) {
      const b = buildBaseline(target.name, results, { trials, seed });
      writeFileSync(join(dir, BASELINE_FILE), JSON.stringify(b, null, 2) + '\n');
      console.log(`  ✎ wrote ${join('targets', name.replace(/^targets\//, ''), BASELINE_FILE)} (overall ${Math.round(b.overall * 100)}%)`);
    }
    const cmp = compareToBaseline(target.name, results, values['update-baseline'] ? readBaseline(dir) : baseline, { trials, seed, tolerance });
    sections.push({ cmp, results });
    console.log(`  ${cmp.ok ? '✓' : '✗'} ${target.name}: ${cmp.missingBaseline ? 'no baseline' : `${Math.round(cmp.overall * 100)}% vs baseline ${Math.round((cmp.baselineOverall ?? 0) * 100)}%`}${cmp.failures.length ? ` — ${cmp.failures.join('; ')}` : ''}`);
  }

  const ok = sections.every((s) => s.cmp.ok);
  const md = renderComment(sections, { ...shown, runUrl: values['run-url'] });
  writeFileSync(join(values.out!, 'scorecard.md'), md);
  writeFileSync(
    join(values.out!, 'scorecard.json'),
    JSON.stringify({ ok, date: new Date().toISOString(), targets: sections.map((s) => ({ ...s.cmp, results: s.results.map(({ perTrial, ...r }) => r) })) }, null, 2) + '\n',
  );
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(`\n${ok ? 'Resilience held' : 'RESILIENCE REGRESSED'} → ${join(values.out!, 'scorecard.md')}, scorecard.json`);
  await shutdownTracing();
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
