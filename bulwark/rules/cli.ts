// npm run rules -- [--target targets/refundbot] [--recompile] [--lock] [--model claude-sonnet-5]
//
// Shows how each of a target's plain-English rules is checked: by the target's
// own check, by Bulwark's pattern library, or by the LLM rule compiler (with the
// DSL and its self-test). With an LLM key, Claude compiles the rules nothing else
// can (cached in .bulwark/compiled-rules.json, so reruns are free). --lock writes
// the LLM-compiled checks to the target's committed lockfile, after re-running
// their self-test on fresh trials.

import '../env';
import { parseArgs } from 'node:util';
import { CostMeter, usd } from '../cost/meter';
import { loadPriceBook } from '../cost/pricing';
import { llmLabel, llmProvider } from '../llm';
import { loadTarget, resolveTargetDir } from '../target';
import { initTracing, shutdownTracing } from '../tracing';
import { describeRules, lockfilePath, lookupCompiled, prepareRules, recheck, sampleObservations, saveCompiled, type LlmCompiledRule } from './compiler';

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: 'targets/refundbot' },
      recompile: { type: 'boolean', default: false },
      lock: { type: 'boolean', default: false },
      model: { type: 'string' },
    },
  });
  const target = await loadTarget(resolveTargetDir(values.target));
  await initTracing('bulwark-rules');
  console.log(`Rules for ${target.name} (LLM: ${llmLabel()})\n`);

  const meter = new CostMeter();
  const reports = await meter.run(() =>
    prepareRules(target, {
      recompile: values.recompile,
      ...(values.model ? { model: values.model } : {}),
      onCompile: (o) => {
        o.attempts.forEach((a, i) => {
          const status = a.rejected ? `rejected: ${a.rejected.join('; ')}` : 'accepted';
          console.log(`  LLM compile "${o.rule}" attempt ${i + 1}: ${status}`);
        });
      },
    }),
  );
  console.log('\n' + describeRules(reports).join('\n') + '\n');

  const book = await loadPriceBook({ provider: llmProvider() });
  const cost = meter.summarize(book.priceFor, `0G router prices (${book.zgSource})`);
  console.log(`LLM cost ${usd(cost.llmUsd)} (${cost.calls} calls, ${cost.inputTokens + cost.outputTokens} tokens)`);

  if (values.lock) {
    const entries = reports.filter((r) => r.source === 'llm').map((r) => lookupCompiled(target.name, r.rule)!).filter(Boolean) as LlmCompiledRule[];
    const samples = await sampleObservations(target, { seed: 11 });
    const ok = entries.filter((e) => {
      const why = recheck(e, samples);
      if (why.length) console.log(`  not locked, fails its self-test on fresh trials: "${e.rule}": ${why.join('; ')}`);
      return why.length === 0;
    });
    saveCompiled(ok, lockfilePath(target.name));
    console.log(`Locked ${ok.length} LLM-compiled rules to ${lockfilePath(target.name)}`);
  }
  if (reports.some((r) => r.source === 'uncompiled')) process.exitCode = 1;
  await shutdownTracing();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
