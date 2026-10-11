// Runs a Bulwark loop while Bulwark's own dependencies fail (see faults.ts), and
// scores how Bulwark coped: how many self-faults were injected, how many it
// recovered from (each one matched to the `self-fault` event its recovery code
// emitted), and whether the run still finished with the same result as a clean
// control run.

import type { SelfFaultReport } from '../blue/fixer';
import { runLoop, type LoopEvent, type LoopOptions, type LoopSummary } from '../loop/orchestrator';
import { SelfFaults, type Injection, type SelfFaultPlan, type SelfSeam } from './faults';

/**
 * The default attack on RefundBot's playbook loop. Opportunities (`@N`) are picked so the faults land on
 * the run's real seams: the first Blue LLM calls, the first rollbacks, the first Judge workspace,
 * the first observe step, and trials early in Red's BEFORE scorecard.
 */
export const DEFAULT_PLAN: SelfFaultPlan = {
  'blue-llm': ['429', '5xx', 'timeout'],
  'blue-proposal': ['malformed', 'empty'],
  checkpoint: ['corrupt', 'missing'],
  workspace: ['syntax-error@1'],
  neatlogs: ['down'],
  trial: ['throw@5', 'throw-twice@15'],
};

export interface SeamScore {
  seam: SelfSeam;
  injected: number;
  recovered: number;
  faults: string[];
  how: string[];
}

export interface SelfChaosResult {
  summary: LoopSummary;
  injected: Injection[];
  /** Planned faults whose seam never got that many opportunities in this run. */
  notInjected: { seam: SelfSeam; fault: string }[];
  events: SelfFaultReport[];
  seams: SeamScore[];
  totals: { injected: number; recovered: number };
  /** Self-faults Bulwark detected that were not injected (real robustness problems). */
  organic: SelfFaultReport[];
  control?: LoopSummary;
}

export async function runSelfChaos(
  input: Partial<LoopOptions> & { targetDir: string; plan?: SelfFaultPlan; control?: boolean; llmDeadlineMs?: number },
  emit: (e: LoopEvent) => void = () => {},
): Promise<SelfChaosResult> {
  const { plan = DEFAULT_PLAN, control, llmDeadlineMs, ...loop } = input;
  const sf = new SelfFaults(plan);
  if (llmDeadlineMs !== undefined) sf.llmDeadlineMs = llmDeadlineMs;
  const events: SelfFaultReport[] = [];
  const summary = await runLoop({ fixer: 'auto', ...loop, selfFaults: sf }, (e) => {
    if (e.type === 'self-fault') events.push({ seam: e.seam, fault: e.fault, recovered: e.recovered, how: e.how });
    emit(e);
  });

  // Match each injection to a recovery event at its seam, in order. Extra events at a seam are organic.
  const seams: SeamScore[] = [];
  const organic: SelfFaultReport[] = [];
  const bySeam = new Map<string, SelfFaultReport[]>();
  for (const e of events) bySeam.set(e.seam, [...(bySeam.get(e.seam) ?? []), e]);
  for (const seam of new Set([...sf.injected.map((i) => i.seam), ...Object.keys(plan)] as SelfSeam[])) {
    const inj = sf.injected.filter((i) => i.seam === seam);
    const evs = bySeam.get(seam) ?? [];
    const matched = evs.slice(0, inj.length);
    organic.push(...evs.slice(inj.length));
    seams.push({
      seam,
      injected: inj.length,
      recovered: Math.min(inj.length, matched.filter((e) => e.recovered).length),
      faults: inj.map((i) => `${i.fault} (opportunity ${i.at})`),
      how: matched.map((e) => `${e.fault} → ${e.how}`),
    });
  }
  for (const [seam, evs] of bySeam) if (!seams.some((s) => s.seam === seam)) organic.push(...evs);

  const controlSummary = control ? await runLoop({ fixer: 'auto', ...loop, selfFaults: new SelfFaults({}) }, () => {}) : undefined;
  return {
    summary,
    injected: sf.injected,
    notInjected: sf.pending(),
    events,
    seams,
    totals: { injected: sf.injected.length, recovered: seams.reduce((s, x) => s + x.recovered, 0) },
    organic,
    ...(controlSummary ? { control: controlSummary } : {}),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function renderSelfChaos(r: SelfChaosResult, meta: Record<string, unknown> = {}): string {
  const s = r.summary;
  const lines = [
    `# Bulwark self-chaos scorecard: ${s.target}`,
    '',
    Object.entries({ run: s.runId, fixer: s.fixer, ...meta })
      .map(([k, v]) => `**${k}**: ${v}`)
      .join(' · '),
    '',
    `**Self-faults injected ${r.totals.injected}, recovered ${r.totals.recovered}. The run still reached ${pct(s.overallBefore)} → ${pct(s.overallAfter)}` +
      (r.control ? ` (clean control run: ${pct(r.control.overallBefore)} → ${pct(r.control.overallAfter)}).**` : '.**'),
    '',
    `Fixed ${s.fixed.length} (${s.fixed.join(', ') || 'none'}), unfixed ${s.unfixed.length}${s.unfixed.length ? ` (${s.unfixed.join(', ')})` : ''}, skipped ${s.skipped.length}; ${s.attempts} attempts, ${s.rollbacks} rollbacks.` +
      (r.control ? ` Control: fixed ${r.control.fixed.length}, unfixed ${r.control.unfixed.length}, ${r.control.attempts} attempts.` : ''),
    '',
    '| Seam | Injected | Recovered | Faults | How Bulwark recovered |',
    '|---|---|---|---|---|',
    ...r.seams.map((x) => `| ${x.seam} | ${x.injected} | ${x.recovered} | ${x.faults.join('<br>') || '—'} | ${x.how.join('<br>').replace(/\|/g, '\\|') || '—'} |`),
  ];
  if (r.notInjected.length) lines.push('', `Planned but never reached (the seam had fewer opportunities): ${r.notInjected.map((x) => `${x.seam}=${x.fault}`).join(', ')}`);
  if (r.organic.length) {
    lines.push('', '## Self-faults Bulwark detected that were not injected', '');
    for (const e of r.organic) lines.push(`- ${e.seam}: ${e.fault} → ${e.recovered ? 'recovered' : 'NOT recovered'}: ${e.how}`);
  }
  return lines.join('\n') + '\n';
}
