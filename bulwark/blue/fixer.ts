// Blue agent: proposes a patch for one fault. It never decides whether its own
// patch works. That is the Judge's job.

import type Anthropic from '@anthropic-ai/sdk';
import { trace } from 'neatlogs';
import type { Fault } from '../chaos/faults';
import { recordLlmCall, usageFromAnthropic } from '../cost/meter';
import { createLlmClient, defaultModel, llmProvider } from '../llm';
import type { Finding } from '../red/analyze';
import type { ExperimentResult } from '../scorecard';
import type { Files } from '../workspace';
import { applyStrategy, playbookFor } from './playbook';

export interface FailedAttempt {
  strategy: string;
  author: string;
  rationale: string;
  reasons: string[];
}

export interface FixContext {
  /** Target name, so the playbook offers that target's strategies (RefundBot's when omitted). */
  target?: string;
  fault: Fault;
  findings: Finding[];
  files: Files;
  before: ExperimentResult;
  failed: FailedAttempt[];
  /** Business rules and exactly how the Judge checks each one. */
  rules: { rule: string; how: string }[];
  /** Strategy ids in the order memory suggests trying them (best first). */
  preferred: string[];
  /** What neatlogs recorded for a failing trial (bulwark/observe), when the trace was read back in time. */
  neatlogsEvidence?: string;
  /** Fix-site candidates from Entire Graph search over the original target (bulwark/red/graph). */
  graphHints?: string;
}

export interface Proposal {
  strategy: string;
  title: string;
  rationale: string;
  files: Files;
  author: string;
}

export interface Fixer {
  name: string;
  propose(ctx: FixContext): Promise<Proposal | null>;
}

export class PlaybookFixer implements Fixer {
  name = 'playbook';

  async propose(ctx: FixContext): Promise<Proposal | null> {
    const tried = new Set(ctx.failed.map((f) => f.strategy));
    const rank = (id: string) => {
      const i = ctx.preferred.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const strategies = (playbookFor(ctx.target)[ctx.fault.kind] ?? [])
      .map((s, order) => ({ s, order }))
      .sort((a, b) => rank(a.s.id) - rank(b.s.id) || a.order - b.order)
      .map((x) => x.s);

    for (const s of strategies) {
      if (tried.has(s.id)) continue;
      const files = applyStrategy(s, ctx.files);
      if (files) return { strategy: s.id, title: s.title, rationale: s.rationale, files, author: this.name };
    }
    return null;
  }
}

const FIXER_SYSTEM = `You are the Blue agent in Bulwark, a chaos-engineering system for AI agents.
A target agent failed under an injected fault. Write the smallest correct patch that makes it survive this
fault while keeping every business rule. You may only edit the files you are given. Return complete file
contents through the submit_fix tool. A separate Judge will re-run the attack with fresh seeds; patches that
merely hide the failure, special-case the test, or break other behaviour will be rejected.`;

const SUBMIT_FIX = {
  name: 'submit_fix',
  description: 'Submit a patch as complete replacement contents for one or more files.',
  input_schema: {
    type: 'object' as const,
    properties: {
      strategy: { type: 'string', description: 'short kebab-case name, e.g. idempotency-key' },
      title: { type: 'string' },
      rationale: { type: 'string', description: 'root cause and why this fix addresses it' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
    required: ['strategy', 'title', 'rationale', 'files'],
  },
};

/** The prompt ClaudeFixer sends: fault, rules, evidence (local + neatlogs), static and graph hints, rejected attempts, files. */
export function buildFixPrompt(ctx: FixContext): string {
  return [
    `## Fault: ${ctx.fault.id}`,
    `${ctx.fault.title}. Hypothesis: ${ctx.fault.hypothesis}`,
    `## Business rules and exactly how the Judge checks them`,
    ...ctx.rules.map((r) => `- "${r.rule}": ${r.how}`),
    `Trials run against a sandbox. Side effects (refunds, emails, API calls, …) are read from the sandbox ledger, not from what the agent says it did.`,
    `## Evidence (${ctx.before.passed}/${ctx.before.trials} trials passed)`,
    ...Object.entries(ctx.before.violations)
      .filter(([, n]) => n > 0)
      .map(([rule, n]) => `- ${n}× broke "${rule}"`),
    ...ctx.before.examples.map((e) => `- example: ${e.rule} → ${e.detail ?? ''}`),
    `Outcomes: ${JSON.stringify(ctx.before.outcomes)}`,
    `## Static analysis findings`,
    ...ctx.findings.map((f) => `- ${f.file}:${f.line} ${f.why}`),
    ...(ctx.neatlogsEvidence ? ['## What neatlogs recorded for a failing trial', ctx.neatlogsEvidence] : []),
    ...(ctx.graphHints
      ? ['## Where Entire Graph says to look', 'Ranked by Entire Graph search for the fault hypothesis (paths are from the repo root; edit the matching file you are given).', ctx.graphHints]
      : []),
    ...(ctx.failed.length
      ? ['## Previous attempts the Judge rejected', ...ctx.failed.map((f) => `- ${f.strategy}: ${f.rationale}\n  rejected because: ${f.reasons.join('; ')}`)]
      : []),
    `## Files you may edit`,
    ...Object.entries(ctx.files).map(([path, src]) => `### ${path}\n\`\`\`ts\n${src}\n\`\`\``),
  ].join('\n');
}

export class ClaudeFixer implements Fixer {
  name: string;
  private client: Anthropic;

  constructor(private model = defaultModel('fixer')) {
    this.name = model;
    this.client = createLlmClient();
  }

  async propose(ctx: FixContext): Promise<Proposal | null> {
    return trace({ name: 'blue.llm-propose', kind: 'AGENT', attributes: { fault: ctx.fault.id, model: this.model } }, async () => {
      const prompt = buildFixPrompt(ctx);

      const start = performance.now();
      let res: Anthropic.Message;
      try {
        res = await this.client.messages.create({
          model: this.model,
          max_tokens: 16000,
          system: FIXER_SYSTEM,
          tools: [SUBMIT_FIX],
          // submit_fix is the only tool, so "any" forces it too; unlike a named tool choice it is
          // accepted by non-Claude models on the 0G Router (e.g. deepseek-v4-flash, which thinks by default).
          tool_choice: { type: 'any' },
          // Claude's default; models that think by default can otherwise spend the whole budget thinking.
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: prompt }],
        }, { timeout: 240_000 });
      } catch (err) {
        recordLlmCall({ role: 'fixer', model: this.model, inputTokens: 0, outputTokens: 0, ms: performance.now() - start, error: true });
        throw err;
      }
      recordLlmCall({ role: 'fixer', model: this.model, ...usageFromAnthropic(res.usage), ms: performance.now() - start });
      const call = res.content.find((b) => b.type === 'tool_use');
      if (!call || call.type !== 'tool_use') return null;
      const input = call.input as { strategy: string; title: string; rationale: string; files: { path: string; content: string }[] };
      const files = { ...ctx.files };
      for (const f of input.files ?? []) {
        if (f.path in ctx.files) files[f.path] = f.content;
      }
      return { strategy: input.strategy, title: input.title, rationale: input.rationale, files, author: this.name };
    });
  }
}

/** One of Bulwark's own dependencies failed and how Bulwark carried on (a `self-fault` loop event). */
export interface SelfFaultReport {
  seam: string;
  fault: string;
  recovered: boolean;
  how: string;
}

export interface FixerOptions {
  /** The LLM fixer AutoFixer tries first (default: ClaudeFixer when a key is configured). */
  llm?: Fixer;
  /** How long one LLM proposal may take before AutoFixer gives up on it and falls back. */
  llmDeadlineMs?: number;
  /** Called when an LLM call fails or returns an unusable proposal, with what Blue did instead. */
  onSelfFault?: (f: SelfFaultReport) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a proposal can't be judged (malformed or empty), or undefined when it is usable. */
export function proposalProblem(p: unknown, files: Files): string | undefined {
  if (!isRecord(p)) return 'proposal is not an object';
  if (typeof p.strategy !== 'string' || !p.strategy.trim()) return 'proposal has no strategy name';
  if (!isRecord(p.files)) return 'proposal has no files';
  for (const [path, content] of Object.entries(p.files)) {
    if (!(path in files)) return `proposal edits ${path}, which is not an editable file`;
    if (typeof content !== 'string' || !content.trim()) return `proposal's ${path} is empty or not text`;
  }
  if (!Object.entries(p.files).some(([path, content]) => files[path] !== content)) return 'proposal changes nothing';
  return undefined;
}

/** Rejects after `ms`, so a hung LLM call can't stall the loop (the SDK's own default is 10 minutes, with retries). */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const errText = (err: unknown) => {
  const status = isRecord(err) && typeof err.status === 'number' ? `${err.status} ` : '';
  return `${status}${err instanceof Error ? err.message.split('\n')[0] : String(err)}`.slice(0, 200);
};

/** LLM first when a key is configured; the playbook takes over if it gives up, fails, or proposes something unusable. */
export class AutoFixer implements Fixer {
  name: string;
  private llm?: Fixer;
  private playbook = new PlaybookFixer();
  private deadlineMs: number;
  private onSelfFault?: (f: SelfFaultReport) => void;

  constructor(opts: FixerOptions = {}) {
    this.llm = opts.llm ?? (llmProvider() ? new ClaudeFixer() : undefined);
    this.deadlineMs = opts.llmDeadlineMs ?? 300_000;
    this.onSelfFault = opts.onSelfFault;
    this.name = this.llm ? `${this.llm.name}+playbook` : 'playbook';
  }

  async propose(ctx: FixContext): Promise<Proposal | null> {
    const problems: { seam: string; fault: string }[] = [];
    const tryLlm = async (): Promise<Proposal | null> => {
      if (!this.llm) return null;
      let p: Proposal | null;
      try {
        p = await withDeadline(this.llm.propose(ctx), this.deadlineMs, 'LLM fixer');
      } catch (err) {
        problems.push({ seam: 'blue-llm', fault: errText(err) });
        return null;
      }
      if (!p) return null; // the LLM gave up: not a fault
      const bad = proposalProblem(p, ctx.files);
      if (bad) {
        problems.push({ seam: 'blue-proposal', fault: bad });
        return null;
      }
      return { ...p, title: typeof p.title === 'string' ? p.title : p.strategy, rationale: typeof p.rationale === 'string' ? p.rationale : '' };
    };
    // The LLM gets two tries per fault, then the playbook. The playbook's
    // transforms target known code, so if earlier LLM fixes reshaped that code
    // and nothing applies, the LLM keeps going with the Judge's feedback.
    let p: Proposal | null = null;
    if (this.llm && ctx.failed.filter((f) => f.author === this.llm!.name).length < 2) p = await tryLlm();
    if (!p) p = (await this.playbook.propose(ctx)) ?? (await tryLlm());
    for (const pr of problems) {
      this.onSelfFault?.({ ...pr, recovered: true, how: p ? `fell back: ${p.author} proposed "${p.strategy}" instead` : 'no usable proposal from the LLM or the playbook; the loop moves on' });
    }
    return p;
  }
}

/**
 * Asks a fixer for a proposal without letting its failure end the run (e.g. `--fixer claude` hitting a 429).
 * A throw becomes "no proposal", reported as a self-fault.
 */
export async function proposeSafely(fixer: Fixer, ctx: FixContext, onSelfFault?: (f: SelfFaultReport) => void): Promise<Proposal | null> {
  try {
    const p = await fixer.propose(ctx);
    if (p && proposalProblem(p, ctx.files)) {
      onSelfFault?.({ seam: 'blue-proposal', fault: proposalProblem(p, ctx.files)!, recovered: true, how: 'discarded before the Judge; treated as no proposal' });
      return null;
    }
    return p;
  } catch (err) {
    onSelfFault?.({ seam: 'blue-llm', fault: errText(err), recovered: true, how: `${fixer.name} failed; treated as no proposal and the loop moves on` });
    return null;
  }
}

export function createFixer(kind: 'auto' | 'playbook' | 'claude', opts: FixerOptions = {}): Fixer {
  if (kind === 'playbook') return new PlaybookFixer();
  if (kind === 'claude') {
    if (!llmProvider()) throw new Error('--fixer claude needs ZG_ROUTER_API_KEY or ANTHROPIC_API_KEY');
    return new ClaudeFixer();
  }
  return new AutoFixer(opts);
}
