// Fix tournament: several Blue fixers (different models, or the playbook) each
// propose a fix for the same fault from the same base code. The Judge verifies
// every candidate independently and picks one winner by, in order:
//   1. it works: verdict "fixed" and, when an SLO is set, the SLO demonstrated
//      (a fix within its overhead budgets beats one flagged "fixed with overhead")
//   2. lower overhead on the happy path: cost per run, then steps, then p50 latency
//   3. smaller diff
// Losers are recorded with the reason they lost, and never applied.

import { ClaudeFixer, PlaybookFixer, type FixContext, type Fixer, type Proposal } from '../blue/fixer';
import { playbookFor } from '../blue/playbook';
import { llmProvider } from '../llm';
import { DEFAULT_MIN_LATENCY_DELTA_MS, type Overhead } from './overhead';
import type { VerdictStatus } from './judge';

/** The playbook, but trying its most thorough strategy first instead of the cheapest. Offline, no LLM. */
export class StrongestFirstPlaybook implements Fixer {
  name = 'playbook-strong';
  private inner = new PlaybookFixer();

  async propose(ctx: FixContext): Promise<Proposal | null> {
    const reversed = (playbookFor(ctx.target)[ctx.fault.kind] ?? []).map((s) => s.id).reverse();
    const p = await this.inner.propose({ ...ctx, preferred: reversed });
    return p && { ...p, author: this.name };
  }
}

export const OFFLINE_ENTRANTS = ['playbook', 'playbook-strong'];

/** `playbook`, `playbook-strong`, or any model id served by the LLM provider (e.g. claude-sonnet-5). */
export function createEntrant(spec: string): Fixer {
  if (spec === 'playbook') return new PlaybookFixer();
  if (spec === 'playbook-strong') return new StrongestFirstPlaybook();
  if (!llmProvider()) throw new Error(`tournament entrant "${spec}" is a model and needs ZG_ROUTER_API_KEY or ANTHROPIC_API_KEY (offline entrants: ${OFFLINE_ENTRANTS.join(', ')})`);
  return new ClaudeFixer(spec);
}

export function parseTournament(arg: string): string[] {
  const entrants = arg.split(',').map((s) => s.trim()).filter(Boolean);
  if (entrants.length < 2) throw new Error('--tournament needs at least two entrants, e.g. playbook,claude-sonnet-5');
  if (new Set(entrants).size !== entrants.length) throw new Error('--tournament entrants must be distinct');
  return entrants;
}

export interface Entry {
  entrant: string;
  proposal: Proposal | null;
  /** Why the entrant produced nothing (an error, or no strategy left). */
  error?: string;
}

/** Every entrant proposes in parallel from the same context. One entrant failing never sinks the round. */
export async function proposeAll(entrants: Fixer[], ctx: FixContext): Promise<Entry[]> {
  return Promise.all(
    entrants.map(async (f): Promise<Entry> => {
      try {
        const proposal = await f.propose(ctx);
        return { entrant: f.name, proposal, ...(proposal ? {} : { error: 'returned no proposal' }) };
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return { entrant: f.name, proposal: null, error: msg.length > 160 ? `${msg.slice(0, 157)}...` : msg };
      }
    }),
  );
}

export interface Contender {
  entrant: string;
  status: VerdictStatus | 'no-proposal';
  strategy?: string;
  title?: string;
  /** undefined when no SLO was set for this fault. */
  sloDemonstrated?: boolean;
  overhead?: Overhead;
  /** Lines added + removed. */
  diffSize: number;
  /** First Judge reason, or the entrant's error. */
  summary?: string;
}

export interface RankedContender extends Contender {
  rank: number;
  outcome: 'winner' | 'loser' | 'no-winner';
  reason: string;
}

export interface TournamentResult {
  fault: string;
  round: number;
  entrants: string[];
  ranking: RankedContender[];
  winner?: string;
}

const works = (c: Contender) => c.status === 'fixed' && c.sloDemonstrated !== false;

function tier(c: Contender): number {
  if (works(c)) return c.overhead?.withinBudget === false ? 1 : 0;
  if (c.status === 'fixed') return 2; // fixed, but the SLO was not demonstrated
  if (c.status === 'inconclusive') return 3;
  if (c.status === 'rejected') return 4;
  return 5;
}

/** Compares overhead on the happy path. Negative = a is cheaper. Differences inside the noise tolerance are ties. */
export function compareOverheadOf(a?: Overhead, b?: Overhead): { cmp: number; why?: string } {
  if (!a || !b) return { cmp: 0 };
  const ac = a.after.costPerRunUsd;
  const bc = b.after.costPerRunUsd;
  if (ac !== undefined && bc !== undefined && Math.abs(ac - bc) > 0.1 * Math.max(ac, bc)) {
    return { cmp: ac - bc, why: `cost/run $${ac.toFixed(4)} vs $${bc.toFixed(4)}` };
  }
  const as = a.after.avgSteps;
  const bs = b.after.avgSteps;
  if (Math.abs(as - bs) > 0.25) return { cmp: as - bs, why: `avg steps ${as.toFixed(1)} vs ${bs.toFixed(1)}` };
  const al = a.after.p50Ms;
  const bl = b.after.p50Ms;
  if (Math.abs(al - bl) > Math.max(DEFAULT_MIN_LATENCY_DELTA_MS, 0.1 * Math.max(al, bl))) {
    return { cmp: al - bl, why: `p50 latency ${Math.round(al)}ms vs ${Math.round(bl)}ms` };
  }
  return { cmp: 0 };
}

const statusLabel = (c: Contender) =>
  c.status === 'no-proposal'
    ? `no proposal (${c.summary ?? 'nothing to offer'})`
    : c.status === 'fixed' && c.sloDemonstrated === false
      ? 'fixed, but the SLO was not demonstrated'
      : `${c.status}${c.summary ? `: ${c.summary}` : ''}`;

/** Orders contenders by the tournament rules and explains why each loser lost to the winner. */
export function rankContenders(contenders: Contender[]): { ranking: RankedContender[]; winner?: string } {
  const order = new Map(contenders.map((c, i) => [c, i]));
  const sorted = [...contenders].sort(
    (a, b) => tier(a) - tier(b) || compareOverheadOf(a.overhead, b.overhead).cmp || a.diffSize - b.diffSize || order.get(a)! - order.get(b)!,
  );
  const top = sorted[0];
  const winner = top && works(top) ? top : undefined;

  const ranking = sorted.map((c, i): RankedContender => {
    const rank = i + 1;
    if (!winner) return { ...c, rank, outcome: 'no-winner', reason: statusLabel(c) };
    if (c === winner) {
      const runnersUp = sorted.length - 1;
      return { ...c, rank, outcome: 'winner', reason: runnersUp ? `best of ${sorted.length}: ${c.overhead?.withinBudget === false ? 'fixed with overhead (no in-budget fix competed)' : 'fixed'}${c.sloDemonstrated ? ', SLO demonstrated' : ''}` : 'fixed' };
    }
    let reason: string;
    if (tier(c) !== tier(winner)) {
      reason = tier(c) === 1 ? 'fixed, but over the overhead budget' : statusLabel(c);
    } else {
      const o = compareOverheadOf(c.overhead, winner.overhead);
      if (o.cmp !== 0) reason = `also fixed, but higher overhead (${o.why})`;
      else if (c.diffSize !== winner.diffSize) reason = `also fixed with similar overhead, but a larger diff (${c.diffSize} vs ${winner.diffSize} lines changed)`;
      else if (c.strategy && c.strategy === winner.strategy) reason = 'proposed the same fix as the winner; entrant order broke the tie';
      else reason = 'tied with the winner on every criterion; entrant order broke the tie';
    }
    return { ...c, rank, outcome: 'loser', reason };
  });
  return { ranking, winner: winner?.entrant };
}

export const tournamentName = (entrants: string[]) => `tournament(${entrants.join(' vs ')})`;
