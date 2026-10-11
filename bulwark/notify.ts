// Run-done notifications: when BULWARK_SLACK_WEBHOOK_URL and/or
// BULWARK_DISCORD_WEBHOOK_URL are set, a finished Bulwark loop posts a compact
// summary (Slack Block Kit / Discord embed): resilience before → after,
// fixed/unfixed, attempts/rollbacks, dollars at risk, the top remaining risk,
// and a link to the artifacts when BULWARK_ARTIFACTS_BASE_URL is set.
//
// A notification never fails a run: send errors are logged, not thrown. Under
// `node --test` nothing is sent unless a fetch is injected (tests mock it).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { combineRisk, money } from './risk';
import type { ExperimentResult } from './scorecard';

/** The parts of a LoopSummary a notification needs (structural, so tests can build one by hand). */
export interface NotifySummaryInput {
  runId: string;
  dir: string;
  target: string;
  fixer: string;
  overallBefore: number;
  overallAfter: number;
  fixed: string[];
  unfixed: string[];
  skipped: string[];
  attempts: number;
  rollbacks: number;
  residual: { file: string; line: number; why: string }[];
}

export interface RunNotice {
  target: string;
  runId: string;
  fixer: string;
  before: number;
  after: number;
  fixed: string[];
  unfixed: string[];
  skipped: string[];
  attempts: number;
  rollbacks: number;
  /** Dollars at risk per 1,000 tickets across the attack suite, before → after (targets with a risk model only). */
  risk?: { before: number; after: number };
  topRisk?: string;
  artifactsUrl?: string;
}

type Env = Record<string, string | undefined>;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function suiteRisk(results?: Record<string, ExperimentResult>): number | undefined {
  const parts = Object.values(results ?? {}).flatMap((r) => (r.fault !== 'baseline' && r.dollarsAtRisk ? [r.dollarsAtRisk] : []));
  return parts.length ? combineRisk(parts).per1kTickets : undefined;
}

/** `base` + run id: "…/api/artifact?file=PR.md&run=" gets the id appended; a path base gets "/<runId>/". */
export function artifactsUrl(base: string | undefined, runId: string): string | undefined {
  if (!base) return undefined;
  if (!/^https?:\/\//.test(base)) return undefined;
  return base.endsWith('=') ? base + encodeURIComponent(runId) : `${base.replace(/\/+$/, '')}/${encodeURIComponent(runId)}/`;
}

/** Builds the notice. `scores` are the before/after scorecards (read from the run's summary.json when omitted). */
export function buildNotice(s: NotifySummaryInput, scores?: { before?: Record<string, ExperimentResult>; after?: Record<string, ExperimentResult> }, env: Env = process.env): RunNotice {
  const sc = scores ?? readScores(s.dir);
  const rb = suiteRisk(sc.before);
  const ra = suiteRisk(sc.after);
  const top = s.residual[0];
  return {
    target: s.target,
    runId: s.runId,
    fixer: s.fixer,
    before: s.overallBefore,
    after: s.overallAfter,
    fixed: s.fixed,
    unfixed: s.unfixed,
    skipped: s.skipped,
    attempts: s.attempts,
    rollbacks: s.rollbacks,
    ...(rb !== undefined && ra !== undefined ? { risk: { before: rb, after: ra } } : {}),
    ...(top ? { topRisk: `${top.file}:${top.line} ${top.why}` } : s.unfixed.length ? { topRisk: `${s.unfixed[0]} still breaks a rule (not fixed)` } : {}),
    ...(artifactsUrl(env.BULWARK_ARTIFACTS_BASE_URL, s.runId) ? { artifactsUrl: artifactsUrl(env.BULWARK_ARTIFACTS_BASE_URL, s.runId) } : {}),
  };
}

function readScores(dir: string): { before?: Record<string, ExperimentResult>; after?: Record<string, ExperimentResult> } {
  const path = join(dir, 'summary.json');
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return { before: j.before, after: j.after };
  } catch {
    return {};
  }
}

const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
const headline = (n: RunNotice) => `Bulwark: ${n.target} resilience ${pct(n.before)} → ${pct(n.after)}`;

export function slackPayload(n: RunNotice): Record<string, unknown> {
  const fields = [
    `*Fixed (${n.fixed.length})*\n${list(n.fixed)}`,
    `*Unfixed (${n.unfixed.length})*\n${list(n.unfixed)}`,
    `*Attempts / rollbacks*\n${n.attempts} / ${n.rollbacks}`,
    `*Fixer*\n${n.fixer}`,
    ...(n.risk ? [`*$ at risk / 1k tickets*\n${money(n.risk.before)} → ${money(n.risk.after)}`] : []),
  ].map((text) => ({ type: 'mrkdwn', text: clip(text, 2000) }));
  return {
    text: `${headline(n)} (fixed ${n.fixed.length}, unfixed ${n.unfixed.length})`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: clip(`🛡️ ${headline(n)}`, 150), emoji: true } },
      { type: 'section', fields: fields.slice(0, 10) },
      ...(n.topRisk ? [{ type: 'section', text: { type: 'mrkdwn', text: clip(`*Top remaining risk*\n${n.topRisk}`, 3000) } }] : []),
      ...(n.artifactsUrl
        ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open artifacts' }, url: n.artifactsUrl }] }]
        : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `run ${n.runId}${n.skipped.length ? ` · skipped ${list(n.skipped)}` : ''}` }] },
    ],
  };
}

export function discordPayload(n: RunNotice): Record<string, unknown> {
  const color = n.after >= 0.95 ? 0x1f9d55 : n.after >= 0.8 ? 0xd97706 : 0xdc2626;
  const field = (name: string, value: string, inline = true) => ({ name, value: clip(value, 1024), inline });
  return {
    username: 'Bulwark',
    embeds: [
      {
        title: clip(`🛡️ ${headline(n)}`, 256),
        ...(n.artifactsUrl ? { url: n.artifactsUrl } : {}),
        color,
        fields: [
          field(`Fixed (${n.fixed.length})`, list(n.fixed)),
          field(`Unfixed (${n.unfixed.length})`, list(n.unfixed)),
          field('Attempts / rollbacks', `${n.attempts} / ${n.rollbacks}`),
          ...(n.risk ? [field('$ at risk / 1k tickets', `${money(n.risk.before)} → ${money(n.risk.after)}`)] : []),
          ...(n.topRisk ? [field('Top remaining risk', n.topRisk, false)] : []),
        ],
        footer: { text: `run ${n.runId} · fixer ${n.fixer}` },
      },
    ],
  };
}

export interface NotifyOptions {
  /** --notify: complain loudly when no webhook is configured instead of staying silent. */
  force?: boolean;
  /** --dry-run-notify: print both payloads, send nothing. */
  dryRun?: boolean;
  env?: Env;
  /** Injected in tests; the real fetch is never used under `node --test`. */
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  scores?: { before?: Record<string, ExperimentResult>; after?: Record<string, ExperimentResult> };
}

export interface NotifyResult {
  sent: string[];
  failed: string[];
  payloads: { slack: Record<string, unknown>; discord: Record<string, unknown> };
}

const validWebhook = (url: string | undefined) => !!url && /^https:\/\//.test(url);

/** Posts the run summary to every configured webhook. Never throws. */
export async function notifyRunDone(summary: NotifySummaryInput, opts: NotifyOptions = {}): Promise<NotifyResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  const notice = buildNotice(summary, opts.scores, env);
  const payloads = { slack: slackPayload(notice), discord: discordPayload(notice) };
  const result: NotifyResult = { sent: [], failed: [], payloads };
  if (opts.dryRun) {
    log(`notify (dry run): Slack payload\n${JSON.stringify(payloads.slack, null, 2)}`);
    log(`notify (dry run): Discord payload\n${JSON.stringify(payloads.discord, null, 2)}`);
    return result;
  }
  const hooks = (
    [
      ['slack', env.BULWARK_SLACK_WEBHOOK_URL, payloads.slack],
      ['discord', env.BULWARK_DISCORD_WEBHOOK_URL, payloads.discord],
    ] as const
  ).filter(([, url]) => validWebhook(url));
  if (!hooks.length) {
    if (opts.force) log('notify: --notify given but neither BULWARK_SLACK_WEBHOOK_URL nor BULWARK_DISCORD_WEBHOOK_URL is set (https:// URLs)');
    return result;
  }
  const doFetch = opts.fetch ?? (process.env.NODE_TEST_CONTEXT ? undefined : fetch);
  if (!doFetch) {
    log('notify: not sending during tests (inject a fetch)');
    return result;
  }
  await Promise.all(
    hooks.map(async ([name, url, body]) => {
      try {
        const res = await doFetch(url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        result.sent.push(name);
      } catch (err) {
        result.failed.push(name);
        log(`notify: ${name} webhook failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }),
  );
  if (result.sent.length) log(`notify: posted run summary to ${result.sent.join(' and ')}`);
  return result;
}
