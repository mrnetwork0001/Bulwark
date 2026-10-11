// npm run red:generate -- [--count 6] [--trials 20] [--seed 42] [--from specs.json]
//                         [--out .bulwark/generated-faults.json] [--evidence docs/evidence/generated-faults.json]
//
// Generative Red: the LLM invents new faults as DSL specs; Bulwark validates them,
// attacks the unpatched agent with each, and keeps only the ones that break a
// business rule. Use them with `npm run chaos -- --generated` or `npm run fix -- --generated`.
// --from skips the LLM and vets specs from a JSON file (an array, or {"faults": [...]}).

import './env';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { llmLabel, llmProvider } from './llm';
import { GENERATED_FAULTS_PATH, proposeFaultSpecs, saveReport, vetSpecs, type GenerationReport } from './red/generate';
import { loadTarget } from './target';
import { initTracing, shutdownTracing } from './tracing';

async function main() {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: '6' },
      trials: { type: 'string', default: '20' },
      seed: { type: 'string', default: '42' },
      from: { type: 'string' },
      out: { type: 'string', default: GENERATED_FAULTS_PATH },
      evidence: { type: 'string' },
      target: { type: 'string', default: 'targets/refundbot' },
    },
  });
  const dir = values.target!;
  const target = await loadTarget(dir);
  await initTracing('bulwark-red-generate');

  let specs: unknown[];
  let meta: Pick<GenerationReport, 'source' | 'model' | 'usage'>;
  if (values.from) {
    const raw = JSON.parse(readFileSync(values.from, 'utf8')) as unknown;
    specs = Array.isArray(raw) ? raw : ((raw as { faults?: unknown[] }).faults ?? []);
    meta = { source: values.from };
  } else {
    if (!llmProvider()) throw new Error('red:generate needs ZG_ROUTER_API_KEY or ANTHROPIC_API_KEY (or --from <specs.json>)');
    console.log(`RED reading ${target.name}'s tools and asking ${llmLabel()} for ${values.count} new faults…`);
    const p = await proposeFaultSpecs(target, dir, Number(values.count));
    specs = p.specs;
    meta = { source: `llm (${llmLabel()})`, model: p.model, usage: p.usage };
    console.log(`  ${p.model} proposed ${specs.length} specs (${p.usage.inputTokens} in / ${p.usage.outputTokens} out tokens)`);
  }

  const experiment = { trials: Number(values.trials), seed: Number(values.seed), brain: 'simulated' as const };
  console.log(`  validating, then attacking the unpatched agent (${experiment.trials} trials each)…\n`);
  const { accepted, rejected } = await vetSpecs(target, specs, { ...experiment, deadlineMs: 5000, maxSteps: 50 });

  for (const a of accepted) {
    const broke = Object.entries(a.evidence.violations).map(([rule, n]) => `${n}× ${rule}`).join('; ');
    console.log(`  ✓ ${a.spec.id} [${a.spec.kind}] ${a.spec.endpoint}/${a.spec.effect.type}: ${a.evidence.passed}/${a.evidence.trials} passed. ${broke}`);
  }
  for (const r of rejected) {
    const id = (r.spec as { id?: unknown })?.id ?? '(no id)';
    console.log(`  ✗ ${String(id)} rejected at ${r.stage}: ${r.reason}`);
  }

  const report: GenerationReport = { generatedAt: new Date().toISOString(), target: target.name, ...meta, experiment, accepted, rejected };
  saveReport(report, values.out);
  console.log(`\n${accepted.length} accepted, ${rejected.length} rejected → ${values.out}`);
  if (values.evidence) {
    saveReport(report, values.evidence);
    console.log(`Evidence copy → ${values.evidence}`);
  }
  console.log('Attack with them: npm run chaos -- --generated');
  await shutdownTracing();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
