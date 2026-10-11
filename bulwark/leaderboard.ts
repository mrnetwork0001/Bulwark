// npm run leaderboard -- [--models claude-sonnet-5,deepseek-v4-flash,glm-5.3-flash]
//                        [--faults timeout-after-commit,prompt-injection] [--trials 3]
//                        [--seed 42] [--deadline 60000] [--max-steps 13] [--baseline]
//                        [--keep-latency-rule] [--out docs/evidence]
//
// Runs the attack suite against RefundBot with its brain swapped to each model
// (any model the LLM provider serves over the Anthropic Messages API), then ranks
// models by resilience, dollars at risk and LLM cost per 1,000 tickets.
// Real money: every trial makes several model calls. Keep --trials small.

import './env';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { target as refundbot } from '../targets/refundbot/bulwark.target';
import { ClaudeBrain } from '../targets/refundbot/brains';
import { getFault, type Fault } from './chaos/faults';
import { CostMeter, recordLlmCall, summarizeCalls, usd } from './cost/meter';
import { loadPriceBook } from './cost/pricing';
import { llmLabel, llmProvider } from './llm';
import { rankModels, type ModelEntry } from './ranking';
import { combineRisk, money } from './risk';
import { runExperiment, type ExperimentResult } from './scorecard';
import { percentile, wilson } from './stats';
import type { BulwarkTarget } from './target';
import { initTracing, shutdownTracing } from './tracing';

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);

/** One cheap call: does this model answer with a tool call through the Messages API? */
async function probe(model: string): Promise<{ ok: true } | { ok: false; status: ModelEntry['status']; error: string }> {
  const { ticket } = refundbot.fixtures();
  try {
    const brain = new ClaudeBrain({ model, onUsage: (u) => recordLlmCall({ role: 'agent', ...u }) });
    const d = await brain.decide({ ticket, history: [] });
    if (d.type === 'tool') return { ok: true };
    return { ok: false, status: 'no-tool-use', error: `answered in text instead of calling a tool: "${d.reply.slice(0, 80)}"` };
  } catch (err) {
    return { ok: false, status: 'error', error: errMsg(err) };
  }
}

function emptyEntry(model: string, status: ModelEntry['status'], error: string): ModelEntry {
  return { model, status, error, trials: 0, passed: 0, passRate: 0, ci95: [0, 1], dollarsAtRisk1k: 0, llmUsd: 0, llmCostPerTrial: 0, llmCostPer1k: 0, p95Ms: 0, calls: 0, apiErrors: 0, perFault: [] };
}

async function main() {
  const { values } = parseArgs({
    options: {
      models: { type: 'string', default: 'claude-sonnet-5,deepseek-v4-flash,glm-5.3-flash' },
      faults: { type: 'string', default: 'timeout-after-commit,prompt-injection' },
      trials: { type: 'string', default: '3' },
      seed: { type: 'string', default: '42' },
      deadline: { type: 'string', default: '60000' },
      'max-steps': { type: 'string', default: '13' },
      baseline: { type: 'boolean', default: false },
      'keep-latency-rule': { type: 'boolean', default: false },
      out: { type: 'string', default: 'docs/evidence' },
      /** Re-render leaderboard.md from an existing leaderboard.json without calling any model. */
      'render-only': { type: 'boolean', default: false },
    },
  });
  if (values['render-only']) {
    const { entries, ...meta } = JSON.parse(readFileSync(join(values.out!, 'leaderboard.json'), 'utf8'));
    writeFileSync(join(values.out!, 'leaderboard.md'), renderMd(meta, entries));
    return console.log(`Re-rendered ${values.out}/leaderboard.md`);
  }
  if (!llmProvider()) throw new Error('the leaderboard needs ZG_ROUTER_API_KEY or ANTHROPIC_API_KEY');
  const models = values.models!.split(',').map((m) => m.trim()).filter(Boolean);
  const faults: (Fault | undefined)[] = [...(values.baseline ? [undefined] : []), ...values.faults!.split(',').map((f) => getFault(f.trim()))];
  const trials = Number(values.trials);

  // Real model calls take seconds each, so a 5-second wall-clock rule would rank
  // network latency, not resilience. It is relaxed unless asked for; p95 latency
  // is still reported per model.
  const latencyRule = /finishes within/i;
  const relaxed = values['keep-latency-rule'] ? [] : refundbot.rules.filter((r) => latencyRule.test(r));
  const target: BulwarkTarget = { ...refundbot, rules: refundbot.rules.filter((r) => !relaxed.includes(r)) };
  const opts = { trials, seed: Number(values.seed), brain: 'claude' as const, deadlineMs: Number(values.deadline), maxSteps: Number(values['max-steps']), traceSample: 1 };

  await initTracing('bulwark-leaderboard');
  const book = await loadPriceBook({ provider: llmProvider() });
  console.log(`Bulwark model leaderboard → ${target.name} via ${llmLabel()} | ${models.length} models × ${faults.length} experiments × ${trials} trials | prices: 0G ${book.zgSource}\n`);

  const entries: ModelEntry[] = [];
  let spend = 0;
  for (const model of models) {
    const meter = new CostMeter();
    process.stdout.write(`  ${model.padEnd(22)} probing tool use… `);
    const entry = await meter.run(async (): Promise<ModelEntry> => {
      const p = await probe(model);
      if (!p.ok) return emptyEntry(model, p.status, p.error);
      const probeCalls = meter.calls.length;
      const results: ExperimentResult[] = [];
      const errors: string[] = [];
      const durations: number[] = [];
      for (const fault of faults) {
        process.stdout.write(`${fault?.id ?? 'baseline'}… `);
        try {
          results.push(
            await runExperiment(target, fault, {
              ...opts,
              model,
              onTrial: ({ obs }) => {
                durations.push(obs.durationMs);
                if (obs.error) errors.push(obs.error);
              },
            }),
          );
        } catch (err) {
          errors.push(errMsg(err));
        }
      }
      const suiteCalls = meter.calls.slice(probeCalls);
      const llmUsd = summarizeCalls(suiteCalls, book.priceFor, { wallMs: 0, trials: 0, computeUsdPerHour: 0 }).llmUsd;
      const ran = results.reduce((s, r) => s + r.trials, 0);
      const passed = results.reduce((s, r) => s + r.passed, 0);
      const apiErrors = suiteCalls.filter((c) => c.error).length;
      // Every trial crashed on a failing model call: the model, not the agent, is broken.
      const allCrashedOnApi = ran > 0 && results.every((r) => r.outcomes.crashed === r.trials) && apiErrors >= ran;
      if (!ran || allCrashedOnApi) return { ...emptyEntry(model, 'error', errors[0] ?? 'no trials ran'), calls: suiteCalls.length, apiErrors, llmUsd };
      return {
        model,
        status: 'ok',
        trials: ran,
        passed,
        passRate: passed / ran,
        ci95: wilson(passed, ran),
        dollarsAtRisk1k: combineRisk(results.map((r) => r.dollarsAtRisk)).per1kTickets,
        llmUsd,
        llmCostPerTrial: llmUsd / ran,
        llmCostPer1k: (llmUsd / ran) * 1000,
        p95Ms: percentile(durations, 95),
        calls: suiteCalls.length,
        apiErrors,
        perFault: results.map((r) => ({
          fault: r.fault,
          passed: r.passed,
          trials: r.trials,
          dollarsAtRisk1k: r.dollarsAtRisk.per1kTickets,
          brokenRules: Object.entries(r.violations).filter(([, n]) => n > 0).map(([rule, n]) => `${n}× ${rule}`),
        })),
        ...(errors.length ? { error: `${errors.length} trial errors, e.g. ${errors[0]}` } : {}),
      };
    });
    const total = meter.summarize(book.priceFor).llmUsd;
    spend += total;
    console.log(entry.status === 'ok' ? `${entry.passed}/${entry.trials} passed, ${usd(total)}` : `${entry.status.toUpperCase()}: ${entry.error}`);
    entries.push(entry);
  }

  const ranked = rankModels(entries);
  const meta = {
    date: new Date().toISOString(),
    target: target.name,
    provider: llmLabel(),
    faults: faults.map((f) => f?.id ?? 'baseline'),
    trialsPerFault: trials,
    seed: opts.seed,
    deadlineMs: opts.deadlineMs,
    maxSteps: opts.maxSteps,
    rules: target.rules,
    relaxedRules: relaxed,
    risk: { lostTicketUsd: target.risk?.lostTicketUsd, escalationUsd: target.risk?.escalationUsd },
    prices: `0G router /v1/models (${book.zgSource})`,
    totalSpendUsd: spend,
  };
  mkdirSync(values.out!, { recursive: true });
  writeFileSync(join(values.out!, 'leaderboard.json'), JSON.stringify({ ...meta, entries: ranked }, null, 2));
  writeFileSync(join(values.out!, 'leaderboard.md'), renderMd(meta, ranked));
  console.log('\n' + renderConsole(ranked));
  console.log(`\nTotal spend ${usd(spend)}. Wrote ${values.out}/leaderboard.md and leaderboard.json`);
  await shutdownTracing();
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "1 model API error (429 rate_limit_error)": provider failures crash the trial, since RefundBot has no fallback model. */
function notes(e: ModelEntry): string {
  if (!e.apiErrors) return '';
  const m = e.error?.match(/(\d{3}) \{"type":"error","error":\{"type":"(\w+)"/);
  return `${e.apiErrors} model API error${e.apiErrors > 1 ? 's' : ''}${m ? ` (${m[1]} ${m[2]})` : ''}, counted as a crashed run`;
}

function renderConsole(ranked: ModelEntry[]): string {
  const rows = ranked.map((e) =>
    e.status === 'ok'
      ? `${String(e.rank).padStart(2)}. ${e.model.padEnd(22)} ${`${e.passed}/${e.trials}`.padStart(6)}  ${`${pct(e.ci95[0])}–${pct(e.ci95[1])}`.padEnd(10)} ${money(e.dollarsAtRisk1k).padStart(11)} ${usd(e.llmCostPer1k).padStart(9)}`
      : ` -. ${e.model.padEnd(22)} ${e.status}: ${e.error}`,
  );
  return [`    ${'model'.padEnd(22)} ${'pass'.padStart(6)}  ${'95% CI'.padEnd(10)} ${'$risk/1k'.padStart(11)} ${'LLM $/1k'.padStart(9)}`, ...rows].join('\n');
}

function renderMd(meta: Record<string, unknown> & { faults: string[]; relaxedRules: string[]; risk: Record<string, unknown> }, ranked: ModelEntry[]): string {
  const lines = [
    '# Model resilience leaderboard: RefundBot',
    '',
    `Generated by \`npm run leaderboard\` on ${String(meta.date).slice(0, 10)} via ${meta.provider}. RefundBot's brain was swapped to each model; the agent code, tools and faults were identical.`,
    '',
    `**Faults**: ${meta.faults.join(', ')} · **Trials per fault**: ${meta.trialsPerFault} · **Seed**: ${meta.seed} · **Deadline**: ${Number(meta.deadlineMs) / 1000}s · **Step cap**: ${meta.maxSteps} · **Spend**: ${usd(Number(meta.totalSpendUsd))}`,
    '',
    '| Rank | Model | Pass | 95% CI | $ at risk / 1k tickets | LLM cost / 1k tickets | p95 run time | Notes |',
    '|---|---|---|---|---|---|---|---|',
    ...ranked.map((e) =>
      e.status === 'ok'
        ? `| ${e.rank} | \`${e.model}\` | ${e.passed}/${e.trials} | ${pct(e.ci95[0])}–${pct(e.ci95[1])} | ${money(e.dollarsAtRisk1k)} | ${usd(e.llmCostPer1k)} | ${(e.p95Ms / 1000).toFixed(1)}s | ${notes(e)} |`
        : `| — | \`${e.model}\` | — | — | — | — | — | ${e.status}: ${e.error?.replace(/\|/g, '\\|')} |`,
    ),
    '',
    '## Per fault',
    '',
    '| Model | Fault | Pass | $ at risk / 1k | Broken rules |',
    '|---|---|---|---|---|',
    ...ranked.flatMap((e) => e.perFault.map((f) => `| \`${e.model}\` | ${f.fault} | ${f.passed}/${f.trials} | ${money(f.dollarsAtRisk1k)} | ${f.brokenRules.join('<br>') || '—'} |`)),
    '',
    '## How to read this',
    '',
    '- **Ranking**: models that ran beat models that errored; then the Wilson 95% lower bound of the pass rate (so a small lucky sample is not over-rewarded); then fewer dollars at risk; then lower LLM cost.',
    `- **Dollars at risk** = over-refunds from the payments ledger (measured) + $${meta.risk.lostTicketUsd} per ticket without a reply + $${meta.risk.escalationUsd} per crashed/hung/runaway run (assumptions on the target).`,
    "- **Model API errors** (rate limits, outages) that survive the SDK's own retries crash the run, because RefundBot has no fallback model. That is a real resilience gap, so it counts against the model as served.",
    '- **Same seeds for every model**: faults fire on the same trials, so a failure caused by the tool code (e.g. the blind refund retry under timeout-after-commit) shows up identically across models.',
    '- **LLM cost / 1k tickets** = measured tokens × 0G list price, divided by trials, × 1,000. The tool-use probe call is excluded.',
    ...(meta.relaxedRules.length
      ? [`- **Relaxed rule**: "${meta.relaxedRules.map((r) => r.replace(/\.$/, '')).join('", "')}". Real model calls take seconds each, so this rule would rank network latency rather than resilience; p95 run time is shown instead. Use \`--keep-latency-rule\` to enforce it.`]
      : []),
    `- **Small samples**: ${meta.trialsPerFault} trials per fault gives wide confidence intervals. Treat close ranks as ties; rerun with more \`--trials\` before drawing conclusions.`,
    '',
  ];
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
