// Blue agent: proposes a patch for one fault. It never decides whether its own
// patch works. That is the Judge's job.

import type Anthropic from '@anthropic-ai/sdk';
import { trace } from 'neatlogs';
import type { Fault } from '../chaos/faults';
import { createLlmClient, defaultModel, llmProvider } from '../llm';
import type { Finding } from '../red/analyze';
import type { ExperimentResult } from '../scorecard';
import type { Files } from '../workspace';
import { applyStrategy, PLAYBOOK } from './playbook';

export interface FailedAttempt {
  strategy: string;
  author: string;
  rationale: string;
  reasons: string[];
}

export interface FixContext {
  fault: Fault;
  findings: Finding[];
  files: Files;
  before: ExperimentResult;
  failed: FailedAttempt[];
  /** Business rules and exactly how the Judge checks each one. */
  rules: { rule: string; how: string }[];
  /** Strategy ids in the order memory suggests trying them (best first). */
  preferred: string[];
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
    const strategies = (PLAYBOOK[ctx.fault.kind] ?? [])
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

export class ClaudeFixer implements Fixer {
  name: string;
  private client: Anthropic;

  constructor(private model = defaultModel('fixer')) {
    this.name = model;
    this.client = createLlmClient();
  }

  async propose(ctx: FixContext): Promise<Proposal | null> {
    return trace({ name: 'blue.llm-propose', kind: 'AGENT', attributes: { fault: ctx.fault.id, model: this.model } }, async () => {
      const prompt = [
        `## Fault: ${ctx.fault.id}`,
        `${ctx.fault.title}. Hypothesis: ${ctx.fault.hypothesis}`,
        `## Business rules and exactly how the Judge checks them`,
        ...ctx.rules.map((r) => `- "${r.rule}": ${r.how}`),
        `Trials run against a sandbox. Side effects (refunds, emails) are read from the sandbox ledger, not from what the agent says it did.`,
        `## Evidence (${ctx.before.passed}/${ctx.before.trials} trials passed)`,
        ...Object.entries(ctx.before.violations)
          .filter(([, n]) => n > 0)
          .map(([rule, n]) => `- ${n}× broke "${rule}"`),
        ...ctx.before.examples.map((e) => `- example: ${e.rule} → ${e.detail ?? ''}`),
        `Outcomes: ${JSON.stringify(ctx.before.outcomes)}`,
        `## Static analysis findings`,
        ...ctx.findings.map((f) => `- ${f.file}:${f.line} ${f.why}`),
        ...(ctx.failed.length
          ? ['## Previous attempts the Judge rejected', ...ctx.failed.map((f) => `- ${f.strategy}: ${f.rationale}\n  rejected because: ${f.reasons.join('; ')}`)]
          : []),
        `## Files you may edit`,
        ...Object.entries(ctx.files).map(([path, src]) => `### ${path}\n\`\`\`ts\n${src}\n\`\`\``),
      ].join('\n');

      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: FIXER_SYSTEM,
        tools: [SUBMIT_FIX],
        tool_choice: { type: 'tool', name: 'submit_fix' },
        messages: [{ role: 'user', content: prompt }],
      });
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

/** LLM first when a key is configured; the playbook takes over if it gives up. */
export class AutoFixer implements Fixer {
  name: string;
  private llm?: ClaudeFixer;
  private playbook = new PlaybookFixer();

  constructor() {
    if (llmProvider()) this.llm = new ClaudeFixer();
    this.name = this.llm ? `${this.llm.name}+playbook` : 'playbook';
  }

  async propose(ctx: FixContext): Promise<Proposal | null> {
    const tryLlm = async () => {
      try {
        return (await this.llm?.propose(ctx)) ?? null;
      } catch {
        return null;
      }
    };
    // The LLM gets two tries per fault, then the playbook. The playbook's
    // transforms target known code, so if earlier LLM fixes reshaped that code
    // and nothing applies, the LLM keeps going with the Judge's feedback.
    if (this.llm && ctx.failed.filter((f) => f.author === this.llm!.name).length < 2) {
      const p = await tryLlm();
      if (p) return p;
    }
    return (await this.playbook.propose(ctx)) ?? tryLlm();
  }
}

export function createFixer(kind: 'auto' | 'playbook' | 'claude'): Fixer {
  if (kind === 'playbook') return new PlaybookFixer();
  if (kind === 'claude') {
    if (!llmProvider()) throw new Error('--fixer claude needs ZG_ROUTER_API_KEY or ANTHROPIC_API_KEY');
    return new ClaudeFixer();
  }
  return new AutoFixer();
}
