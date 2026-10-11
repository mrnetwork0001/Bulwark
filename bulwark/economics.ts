// npm run economics -- [--runs 10] [--state-dir .bulwark] [--out docs/business]
//                      [--leaderboard docs/evidence/leaderboard.json] [--real-trials-per-run 140]
//                      [--market docs/business/market-data.json]
//
// Reads the latest loop runs (.bulwark/runs/*/summary.json), measures what they
// actually cost, and writes unit-economics.md + unit-economics.csv for the
// cfo.ai business plan. Measured numbers and assumptions are labelled separately.
// If `npm run market` has cached real Crustdata counts, a market section and a
// Year 1-3 revenue scenario are added.

import './env';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PLANS, measure, scenarios, type RunRecord, type Scenario } from './cost/economics';
import { DEFAULT_COMPUTE_USD_PER_HOUR, usd, type CostSummary } from './cost/meter';
import { combineRisk, money, type DollarsAtRisk } from './risk';
import type { ExperimentResult } from './scorecard';
import { derive, loadMarketData, marketCsvRows, marketSectionMd } from './market';

interface LeaderboardEntry {
  model: string;
  status: string;
  llmCostPerTrial: number;
  rank?: number;
}

function riskOf(results: Record<string, ExperimentResult> | undefined): number | undefined {
  const parts = Object.values(results ?? {})
    .filter((r) => r.fault !== 'baseline' && r.dollarsAtRisk)
    .map((r) => r.dollarsAtRisk as DollarsAtRisk);
  return parts.length ? combineRisk(parts).per1kTickets : undefined;
}

function loadRuns(stateDir: string, limit: number): RunRecord[] {
  const root = join(stateDir, 'runs');
  if (!existsSync(root)) return [];
  const runs: RunRecord[] = [];
  for (const id of readdirSync(root).sort().reverse()) {
    const file = join(root, id, 'summary.json');
    if (!existsSync(file)) continue;
    const s = JSON.parse(readFileSync(file, 'utf8')) as {
      runId: string;
      fixer: string;
      fixed: string[];
      cost?: CostSummary;
      before?: Record<string, ExperimentResult>;
      after?: Record<string, ExperimentResult>;
    };
    if (!s.cost) continue; // runs from before cost tracking existed
    runs.push({ runId: s.runId, fixer: s.fixer, fixed: s.fixed.length, trials: s.cost.trials, cost: s.cost, riskBefore1k: riskOf(s.before), riskAfter1k: riskOf(s.after) });
    if (runs.length >= limit) break;
  }
  return runs;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : Math.abs(x) >= 100 ? x.toFixed(2) : x.toPrecision(4));
/** Margins always get one decimal: 98.5% and 97.3% must not both read "99%"/"97%". */
const margin = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '10' },
      'state-dir': { type: 'string', default: '.bulwark' },
      out: { type: 'string', default: 'docs/business' },
      leaderboard: { type: 'string', default: 'docs/evidence/leaderboard.json' },
      'real-trials-per-run': { type: 'string', default: '140' },
      market: { type: 'string', default: 'docs/business/market-data.json' },
    },
  });
  const runs = loadRuns(values['state-dir']!, Number(values.runs));
  if (!runs.length) throw new Error(`no runs with cost data in ${values['state-dir']}/runs. Run \`npm run fix\` first.`);
  const m = measure(runs);

  // A real-LLM target: per-trial cost measured by the leaderboard (top-ranked model that ran).
  let real: { perTrialUsd: number; trialsPerRun: number; model: string } | undefined;
  let realRange: { model: string; perTrialUsd: number }[] = [];
  if (existsSync(values.leaderboard!)) {
    const lb = JSON.parse(readFileSync(values.leaderboard!, 'utf8')) as { entries: LeaderboardEntry[] };
    // Conservative: price the suite at the most expensive model that ran, so the
    // margin holds whichever model a customer's agent uses.
    const ok = lb.entries.filter((e) => e.status === 'ok' && e.llmCostPerTrial > 0).sort((a, b) => b.llmCostPerTrial - a.llmCostPerTrial);
    if (ok.length) {
      real = { perTrialUsd: ok[0].llmCostPerTrial, trialsPerRun: Number(values['real-trials-per-run']), model: ok[0].model };
      realRange = ok.map((e) => ({ model: e.model, perTrialUsd: e.llmCostPerTrial }));
    }
  }
  const plans = scenarios(m, DEFAULT_PLANS, real);
  const computeRate = runs[0].cost.assumptions.computeUsdPerHour ?? DEFAULT_COMPUTE_USD_PER_HOUR;

  const marketData = loadMarketData(values.market!);
  const market = marketData && derive(marketData, DEFAULT_PLANS);
  const marketMd = market ? marketSectionMd(market, marketData) : [];
  const marketCsv = market ? marketCsvRows(market).map((r) => r.join(',')).join('\n') + '\n' : '';

  mkdirSync(values.out!, { recursive: true });
  writeFileSync(join(values.out!, 'unit-economics.md'), renderMd(runs, m, plans, real, computeRate, realRange, marketMd));
  writeFileSync(join(values.out!, 'unit-economics.csv'), renderCsv(m, plans, real, computeRate) + marketCsv);
  console.log(market ? `Market (Crustdata, ${marketData.ranAt.slice(0, 10)}): SAM ${market.sam.companies} companies, Year 3 ARR $${Math.round(market.years[2].arrUsd)}` : `No Crustdata market data at ${values.market} (run \`npm run market\`); market section skipped.`);
  console.log(`Measured ${m.runs} runs: ${usd(m.perRunUsd)}/run (LLM ${pct(m.llmShare)}, compute ${pct(m.computeShare)}), ${m.perFixedFaultUsd === null ? 'no faults fixed' : `${usd(m.perFixedFaultUsd)}/fault fixed`}, ${usd(m.perTrialUsd)}/trial`);
  for (const p of plans) console.log(`  ${p.name.padEnd(10)} $${p.priceUsd}/agent/mo  COGS ${usd(p.cogsSimulated)} → margin ${margin(p.marginSimulated)}${p.marginRealLlm !== undefined ? ` (real-LLM target: ${usd(p.cogsRealLlm!)} → ${margin(p.marginRealLlm)})` : ''}`);
  console.log(`Wrote ${values.out}/unit-economics.md and .csv`);
}

function renderMd(
  runs: RunRecord[],
  m: Measured,
  plans: Scenario[],
  real: { perTrialUsd: number; trialsPerRun: number; model: string } | undefined,
  computeRate: number,
  realRange: { model: string; perTrialUsd: number }[],
  marketMd: string[] = [],
): string {
  const lines = [
    '# Bulwark unit economics',
    '',
    `Generated by \`npm run economics\` on ${new Date().toISOString().slice(0, 10)} from the ${m.runs} most recent Bulwark loop runs (${m.llmRuns} of them made LLM calls). ` +
      'Every number in **Measured** comes from `summary.json` of a real run. Every number in **Assumptions** is a choice, and is labelled as one.',
    '',
    '## Measured (from real runs)',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Cost per loop run | ${usd(m.perRunUsd)} |`,
    `| of which LLM (tokens, priced) | ${usd(m.perRunLlmUsd)} (${pct(m.llmShare)}) |`,
    `| of which compute (wall-clock × rate) | ${usd(m.perRunComputeUsd)} (${pct(m.computeShare)}) |`,
    `| Cost per fault fixed | ${m.perFixedFaultUsd === null ? 'n/a (none fixed)' : usd(m.perFixedFaultUsd)} (${m.faultsFixed} faults fixed in total) |`,
    `| Cost per trial | ${usd(m.perTrialUsd)} |`,
    `| Trials per loop run | ${Math.round(m.trialsPerRun)} |`,
    `| Wall-clock per loop run | ${Math.round(m.avgWallSec)}s |`,
    ...(m.riskRemoved1k !== null ? [`| Dollars at risk removed per run (per 1k tickets) | ${money(m.riskRemoved1k)} |`] : []),
    ...realRange.map((r) => `| LLM cost per trial, real-model target \`${r.model}\` (from the leaderboard) | ${usd(r.perTrialUsd)} |`),
    '',
    '### Runs',
    '',
    '| Run | Fixer | Trials | Faults fixed | LLM calls | LLM | Compute | Total | $ at risk / 1k: before → after |',
    '|---|---|---|---|---|---|---|---|---|',
    ...runs.map(
      (r) =>
        `| ${r.runId} | ${r.fixer} | ${r.trials} | ${r.fixed} | ${r.cost.calls} | ${usd(r.cost.llmUsd)} | ${usd(r.cost.computeUsd)} | ${usd(r.cost.totalUsd)} | ${r.riskBefore1k !== undefined ? `${money(r.riskBefore1k)} → ${money(r.riskAfter1k ?? 0)}` : '—'} |`,
    ),
    '',
    '### LLM spend by model',
    '',
    '| Role | Model | Calls | Input tokens | Output tokens | Cost | Price source |',
    '|---|---|---|---|---|---|---|',
    ...byModel(runs).map((x) => `| ${x.role} | ${x.model} | ${x.calls} | ${x.inputTokens} | ${x.outputTokens} | ${usd(x.usd)} | ${x.priceSource} |`),
    '',
    '## Assumptions (not measured)',
    '',
    `- **Compute rate**: $${computeRate}/hour, a 2 vCPU / 4 GB on-demand cloud VM running the loop (override with \`BULWARK_COMPUTE_USD_PER_HOUR\`).`,
    '- **LLM prices**: 0G Compute Router list prices from its public `/v1/models` endpoint (USD per token), Anthropic first-party list prices for direct calls. No volume discounts.',
    '- **Simulated target brain**: unless noted, trials run RefundBot on the deterministic simulated brain, so trials cost compute only. The real-LLM column below prices the same suite with a real model behind the agent.',
    ...(real
      ? [
          `- **Real-LLM suite size**: ${real.trialsPerRun} real-model trials per run (one Red scorecard: baseline + 6 faults × 20 trials). The Judge's thousands of trials stay simulated.`,
          `- **Real-LLM model**: priced at the most expensive model on the leaderboard (\`${real.model}\`, ${usd(real.perTrialUsd)}/trial), so the margin is a floor. Cheaper models raise it.`,
        ]
      : []),
    '- **Plans, prices and run cadence** below are proposals for the business plan, not market data.',
    '- **Not included**: hosting the dashboard, storage, support, sales, payment fees, neatlogs/Entire subscriptions.',
    '',
    '## Pricing scenarios (assumed prices × measured costs)',
    '',
    `| Plan | Price / agent / month | Loop runs / month | COGS (simulated target) | Gross margin |${real ? ` COGS (real-LLM target, ${real.model}) | Gross margin |` : ''}`,
    `|---|---|---|---|---|${real ? '---|---|' : ''}`,
    ...plans.map(
      (p) =>
        `| ${p.name} | $${p.priceUsd} | ${p.runsPerMonth} (${p.cadence}) | ${usd(p.cogsSimulated)} | ${margin(p.marginSimulated)} |${real ? ` ${usd(p.cogsRealLlm!)} | ${margin(p.marginRealLlm!)} |` : ''}`,
    ),
    '',
    '_COGS = runs per month × measured cost per run' + (real ? ' (+ runs × real-LLM trials per run × measured real-LLM cost per trial)' : '') + '. Gross margin = (price − COGS) / price._',
    '',
    ...marketMd,
    '## Reproduce',
    '',
    '```bash',
    'npm run fix -- --fixer auto          # one loop run (LLM fixer if a key is set), writes .bulwark/runs/<id>/summary.json',
    'npm run leaderboard                  # optional: measures real-LLM cost per trial',
    'npm run market                       # optional: Crustdata market sizing (cached in market-data.json)',
    'npm run economics                    # rewrites this file and unit-economics.csv',
    '```',
    '',
  ];
  return lines.join('\n');
}

type Measured = ReturnType<typeof measure>;

function byModel(runs: RunRecord[]) {
  const map = new Map<string, CostSummary['byModel'][number]>();
  for (const r of runs)
    for (const x of r.cost.byModel) {
      const k = `${x.role}:${x.model}`;
      const cur = map.get(k);
      if (!cur) map.set(k, { ...x });
      else {
        cur.calls += x.calls;
        cur.errors += x.errors;
        cur.inputTokens += x.inputTokens;
        cur.outputTokens += x.outputTokens;
        cur.usd += x.usd;
      }
    }
  return [...map.values()].sort((a, b) => b.usd - a.usd);
}

function renderCsv(m: Measured, plans: Scenario[], real: { perTrialUsd: number; trialsPerRun: number; model: string } | undefined, computeRate: number): string {
  const rows: (string | number)[][] = [['section', 'metric', 'value', 'unit', 'basis']];
  const add = (section: string, metric: string, value: number | null, unit: string, basis: 'measured' | 'assumed' | 'derived') =>
    rows.push([section, metric, value === null ? '' : fmt(value), unit, basis]);
  add('measured', 'runs', m.runs, 'count', 'measured');
  add('measured', 'cost_per_run', m.perRunUsd, 'USD', 'measured');
  add('measured', 'llm_cost_per_run', m.perRunLlmUsd, 'USD', 'measured');
  add('measured', 'compute_cost_per_run', m.perRunComputeUsd, 'USD', 'measured');
  add('measured', 'llm_share', m.llmShare, 'fraction', 'measured');
  add('measured', 'compute_share', m.computeShare, 'fraction', 'measured');
  add('measured', 'cost_per_fault_fixed', m.perFixedFaultUsd, 'USD', 'measured');
  add('measured', 'cost_per_trial', m.perTrialUsd, 'USD', 'measured');
  add('measured', 'trials_per_run', m.trialsPerRun, 'count', 'measured');
  add('measured', 'wall_clock_per_run', m.avgWallSec, 'seconds', 'measured');
  if (m.riskRemoved1k !== null) add('measured', 'dollars_at_risk_removed_per_1k_tickets', m.riskRemoved1k, 'USD', 'measured');
  if (real) add('measured', `real_llm_cost_per_trial_${real.model}`, real.perTrialUsd, 'USD', 'measured');
  add('assumption', 'compute_rate', computeRate, 'USD/hour', 'assumed');
  if (real) add('assumption', 'real_llm_trials_per_run', real.trialsPerRun, 'count', 'assumed');
  for (const p of plans) {
    const s = `scenario_${p.name.toLowerCase()}`;
    add(s, 'price_per_agent_month', p.priceUsd, 'USD', 'assumed');
    add(s, 'runs_per_month', p.runsPerMonth, 'count', 'assumed');
    add(s, 'cogs_simulated_target', p.cogsSimulated, 'USD', 'derived');
    add(s, 'gross_margin_simulated_target', p.marginSimulated, 'fraction', 'derived');
    if (p.cogsRealLlm !== undefined) {
      add(s, 'cogs_real_llm_target', p.cogsRealLlm, 'USD', 'derived');
      add(s, 'gross_margin_real_llm_target', p.marginRealLlm!, 'fraction', 'derived');
    }
  }
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
