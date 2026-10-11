// npm run provenance -- <file>:<line> [<file>:<line> ...] [--json]
// npm run provenance -- --target targets/refundbot [--json]
//
// Traces lines of code back to the AI coding session, prompt and Entire
// checkpoint that introduced them. With --target, traces every weak link Red's
// analyzer finds in that target.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeTarget } from '../red/analyze';
import { loadTarget } from '../target';
import { describeProvenance, promptHeadline, traceLine, type Provenance } from './entire';

function print(p: Provenance, label?: string) {
  console.log(`\n${p.file}:${p.line}${label ? `  (${label})` : ''}`);
  console.log(`  source     ${p.source}${p.match ? ` (${p.match})` : ''}`);
  if (p.commit) console.log(`  commit     ${p.commit.slice(0, 7)} ${p.subject ?? ''}`);
  if (p.author) console.log(`  author     ${p.author}, ${p.date}`);
  if (p.checkpointId) console.log(`  checkpoint ${p.checkpointId}`);
  if (p.sessionId) console.log(`  session    ${p.sessionId} (${[p.agent, p.model].filter(Boolean).join(', ')})`);
  if (p.prompt) console.log(`  prompt     "${promptHeadline(p.prompt, 120)}"`);
  if (p.task) console.log(`  task       ${p.task}`);
  if (p.writtenAt) console.log(`  written    ${p.writtenAt}`);
  if (p.note) console.log(`  note       ${p.note}`);
  console.log(`  → ${describeProvenance(p)}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, target: { type: 'string' } },
  });

  const jobs: { file: string; line: number; label?: string }[] = [];
  if (values.target) {
    const target = await loadTarget(values.target);
    for (const f of analyzeTarget(values.target, target)) jobs.push({ file: join(values.target, f.file), line: f.line, label: f.why });
  }
  for (const arg of positionals) {
    const m = arg.match(/^(.+):(\d+)$/);
    if (!m) throw new Error(`expected <file>:<line>, got "${arg}"`);
    jobs.push({ file: m[1], line: Number(m[2]) });
  }
  if (!jobs.length) throw new Error('usage: npm run provenance -- <file>:<line> | --target <dir>');

  const cache = new Map<string, Provenance>();
  const results = jobs.map((j) => {
    const key = `${j.file}:${j.line}`;
    if (!cache.has(key)) cache.set(key, traceLine(j.file, j.line));
    return { ...j, provenance: cache.get(key)! };
  });
  if (values.json) console.log(JSON.stringify(results.map((r) => ({ ...r.provenance, finding: r.label })), null, 2));
  else results.forEach((r) => print(r.provenance, r.label));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
