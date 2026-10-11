// npm run replay-failures -- [--run <id> | --last N] [--state .bulwark]
//                            [--against-run <id> --against-ws <label>]   sweep a loop workspace instead of the current code
//                            [--trace-wait <s>] [--no-traces]           neatlogs read-back (needs NEATLOGS_API_KEY)
//                            [--into-specs] [--specs-dir <dir>]         still-failing incidents → chaos regression specs
//                            [--out <dir>] [--json]
//
// A regression sweep from real incidents: every distinct failing (fault, seed) Bulwark recorded in
// past runs, plus any failing trial it can read back from neatlogs traces, re-run against the current
// code. Reports which still fail and which are fixed.

import './env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  collectIncidents,
  incidentSpecs,
  loadRunSummaries,
  sweepIncidents,
  traceIncidents,
  traceRefs,
  writeIncidentSpecs,
  type Incident,
  type SweepResult,
  type TraceReadReport,
} from './incidents';

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      last: { type: 'string' },
      state: { type: 'string', default: '.bulwark' },
      'against-run': { type: 'string' },
      'against-ws': { type: 'string' },
      'trace-wait': { type: 'string', default: '0' },
      'no-traces': { type: 'boolean', default: false },
      'into-specs': { type: 'boolean', default: false },
      'specs-dir': { type: 'string', default: join('.bulwark', 'incident-specs') },
      concurrency: { type: 'string', default: '12' },
      out: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (values.run && values.last) throw new Error('use --run or --last, not both');
  const last = values.last ? Number(values.last) : undefined;
  if (last !== undefined && (!Number.isInteger(last) || last < 1)) throw new Error('--last must be a positive integer');
  if (!!values['against-run'] !== !!values['against-ws']) throw new Error('--against-run and --against-ws go together');
  const against = values['against-run'] ? { run: values['against-run']!, ws: values['against-ws']! } : undefined;
  const log = values.json ? () => {} : console.log;

  const summaries = loadRunSummaries(values.state!, { run: values.run, last });
  if (!summaries.length) throw new Error(`no runs with a summary.json under ${join(values.state!, 'runs')}`);
  const pool = new Map<string, Incident>();
  const fromRuns = collectIncidents(summaries, pool).length;
  log(`Incident replay over ${summaries.length} run${summaries.length > 1 ? 's' : ''} in ${values.state}/runs (${summaries[0].runId} … ${summaries.at(-1)!.runId})`);
  log(`  source 1, run summaries: ${fromRuns} distinct failing (target, fault, seed) incidents`);

  // Source 2: neatlogs traces, best effort.
  let reads: TraceReadReport[] = [];
  const refs = traceRefs(summaries);
  if (values['no-traces']) log('  source 2, neatlogs traces: skipped (--no-traces)');
  else if (!refs.length) log('  source 2, neatlogs traces: the runs recorded no trace ids (they ran without NEATLOGS_API_KEY)');
  else if (!process.env.NEATLOGS_API_KEY) log(`  source 2, neatlogs traces: ${refs.length} trace ids recorded, not read (NEATLOGS_API_KEY not set)`);
  else {
    const before = pool.size;
    ({ reads } = await traceIncidents(refs, { waitMs: Number(values['trace-wait']) * 1000, into: pool }));
    const byStatus: Record<string, number> = {};
    for (const r of reads) {
      const k = `${r.status}${r.http !== undefined ? ` (HTTP ${r.http}${r.stage ? `, ${r.stage}` : ''})` : ''}`;
      byStatus[k] = (byStatus[k] ?? 0) + 1;
    }
    const readable = reads.filter((r) => r.status === 'read');
    log(`  source 2, neatlogs traces: ${reads.length} trace ids recorded by these runs, ${readable.length} readable · ${Object.entries(byStatus).map(([k, n]) => `${n} ${k}`).join(' · ')}`);
    const patched = readable.filter((r) => r.originalCode === false);
    for (const r of readable) log(`    ${r.traceId}  "${r.phase ?? ''}"  ${r.trialSpans} trial spans → ${r.originalCode === false ? 'ran patched code, not used' : `${r.incidents} failing`}`);
    log(`    → ${readable.reduce((n, r) => n + r.trialSpans, 0)} bulwark.trial spans (${patched.length} trace${patched.length === 1 ? '' : 's'} from patched-code phases skipped), ${readable.reduce((n, r) => n + r.incidents, 0)} failing trials, ${pool.size - before} incidents not already known from the runs`);
  }

  const incidents = [...pool.values()].sort((a, b) => a.target.localeCompare(b.target) || a.fault.localeCompare(b.fault) || a.seed - b.seed);
  log(`\nRe-running ${incidents.length} incidents against ${against ? `.bulwark/runs/${against.run}/ws/${against.ws}` : 'the current code'}…`);
  const started = Date.now();
  const { results, code } = await sweepIncidents(incidents, { against, stateDir: values.state, concurrency: Number(values.concurrency) || 12 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  let specFiles: string[] = [];
  if (values['into-specs']) specFiles = writeIncidentSpecs(incidentSpecs(results), values['specs-dir']!);

  const report = renderReport({ summaries: summaries.map((s) => s.runId), results, reads, code, against, secs, specFiles, refs: refs.length });
  if (values.json) console.log(JSON.stringify({ runs: summaries.map((s) => s.runId), code, reads, results, specFiles }, null, 2));
  else console.log('\n' + report.text);
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'sweep.md'), report.markdown);
    writeFileSync(join(values.out, 'sweep.json'), JSON.stringify({ runs: summaries.map((s) => s.runId), code, reads, results }, null, 2) + '\n');
    log(`\nwrote ${join(values.out, 'sweep.md')} and sweep.json`);
  }
}

function renderReport(o: {
  summaries: string[];
  results: SweepResult[];
  reads: TraceReadReport[];
  code: Record<string, { source: string; hash: string }>;
  against?: { run: string; ws: string };
  secs: string;
  specFiles: string[];
  refs: number;
}) {
  const rows = new Map<string, { still: number; fixed: number; skipped: number; total: number }>();
  for (const r of o.results) {
    const k = `${r.incident.target} · ${r.incident.fault}`;
    const row = rows.get(k) ?? { still: 0, fixed: 0, skipped: 0, total: 0 };
    row.total++;
    if (r.status === 'still-fails') row.still++;
    else if (r.status === 'fixed') row.fixed++;
    else row.skipped++;
    rows.set(k, row);
  }
  const tot = { still: 0, fixed: 0, skipped: 0, total: 0 };
  for (const r of rows.values()) for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += r[k];

  const W = Math.max(28, ...[...rows.keys()].map((k) => k.length));
  const text: string[] = [];
  text.push(`${'target · fault'.padEnd(W)}  incidents  still fail  fixed  skipped`);
  for (const [k, r] of [...rows].sort()) text.push(`${k.padEnd(W)}  ${String(r.total).padStart(9)}  ${String(r.still).padStart(10)}  ${String(r.fixed).padStart(5)}  ${String(r.skipped).padStart(7)}`);
  text.push(`${'total'.padEnd(W)}  ${String(tot.total).padStart(9)}  ${String(tot.still).padStart(10)}  ${String(tot.fixed).padStart(5)}  ${String(tot.skipped).padStart(7)}`);
  text.push(`(${o.secs}s; code: ${Object.entries(o.code).map(([n, c]) => `${n} = ${c.source} @${c.hash}`).join(', ')})`);
  const same = o.results.filter((r) => r.sameCode !== undefined);
  if (same.length) text.push(`${same.filter((r) => r.sameCode).length}/${same.length} incidents with a recorded code hash were recorded on exactly this code.`);

  const examples = (status: SweepResult['status'], n = 3) => {
    const out: string[] = [];
    const seen = new Map<string, number>();
    for (const r of o.results) {
      if (r.status !== status) continue;
      const k = `${r.incident.target}|${r.incident.fault}`;
      if ((seen.get(k) ?? 0) >= n) continue;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      const what = status === 'still-fails' ? `${r.outcome}; ${r.broken[0].rule}${r.broken[0].detail ? ` (${r.broken[0].detail})` : ''}${r.broken.length > 1 ? ` +${r.broken.length - 1} more` : ''}` : status === 'fixed' ? `${r.outcome}, every rule held` : r.reason;
      out.push(`  ${r.incident.target} ${r.incident.fault} seed ${r.incident.seed}: ${what}  [seen in ${r.incident.seenIn.length} source${r.incident.seenIn.length > 1 ? 's' : ''}]`);
    }
    return out;
  };
  const still = examples('still-fails');
  if (still.length) text.push('', 'Still failing (up to 3 per fault):', ...still);
  const fixed = examples('fixed');
  if (fixed.length) text.push('', 'Fixed (up to 3 per fault):', ...fixed);
  const skipped = examples('skipped', 2);
  if (skipped.length) text.push('', 'Skipped:', ...skipped);
  if (o.specFiles.length) text.push('', `Wrote ${o.specFiles.length} chaos regression spec${o.specFiles.length > 1 ? 's' : ''} from still-failing incidents:`, ...o.specFiles.map((f) => `  ${f}`));
  const replay = o.results.find((r) => r.status === 'still-fails');
  if (replay) text.push('', `Replay one: npm run replay -- --target ${replay.incident.target} --fault ${replay.incident.fault} --seed ${replay.incident.seed}`);

  const md: string[] = [];
  md.push('# Incident replay: regression sweep from real failures', '');
  md.push(`Runs: ${o.summaries.length} (${o.summaries[0]} … ${o.summaries.at(-1)}). Code under test: ${o.against ? `\`.bulwark/runs/${o.against.run}/ws/${o.against.ws}\`` : 'the current target code'} (${Object.entries(o.code).map(([n, c]) => `${n} \`@${c.hash}\``).join(', ')}).`, '');
  md.push(`neatlogs traces: ${o.refs} trace ids recorded by these runs; ${o.reads.length} read attempted; ${o.reads.filter((r) => r.status === 'read').length} readable.`, '');
  if (o.reads.length) {
    md.push('| trace | runs | status | HTTP | stage / reason | trial spans | incidents |', '|---|---|---|---|---|---|---|');
    for (const r of o.reads) md.push(`| \`${r.traceId.slice(0, 12)}…\` | ${r.runs.length} | ${r.status} | ${r.http ?? ''} | ${r.stage ?? r.reason ?? ''} | ${r.trialSpans} | ${r.incidents} |`);
    md.push('');
  }
  md.push('| target · fault | incidents | still fail | fixed | skipped |', '|---|---|---|---|---|');
  for (const [k, r] of [...rows].sort()) md.push(`| ${k} | ${r.total} | ${r.still} | ${r.fixed} | ${r.skipped} |`);
  md.push(`| **total** | **${tot.total}** | **${tot.still}** | **${tot.fixed}** | **${tot.skipped}** |`, '');
  md.push('```', ...text.slice(text.findIndex((l) => l.startsWith('Still failing')) === -1 ? text.length : text.findIndex((l) => l.startsWith('Still failing'))), '```', '');
  return { text: text.join('\n'), markdown: md.join('\n') };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
