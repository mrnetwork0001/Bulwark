// LLM rule compiler: for business rules neither the target nor Bulwark's pattern
// library can compile, Claude writes a check in the rule DSL (bulwark/rules/dsl.ts).
// Every check is validated against the fields real trial observations hold,
// explained back in plain English, and self-tested before it is accepted:
//   - it must evaluate without error on real trials (baseline and faulted),
//   - it must not reject every fault-free baseline trial,
//   - it must reject the counterexample Claude gives with it (a partial observation
//     overlaid on a real passing trial), so a check that accepts everything is caught.
// Accepted checks are cached on disk, keyed by target and rule text, so reruns cost nothing.

import type Anthropic from '@anthropic-ai/sdk';
import { trace } from 'neatlogs';
import { faultsFor } from '../chaos/faults';
import { recordLlmCall, usageFromAnthropic } from '../cost/meter';
import { runTrial } from '../harness';
import { compileRules } from '../invariants';
import { createLlmClient, defaultModel, llmProvider } from '../llm';
import type { BulwarkTarget } from '../target';
import { untraced } from '../tracing';
import { DSL_VERSION, lookupCompiled, saveCompiled, type LlmCompiledRule, type SelfTest } from './cache';
import { describeShape, evaluate, explainCheck, inferShape, overlay, scopeOf, validateCheck, type Pred, type Scope, type Shape } from './dsl';

export * from './cache';

// ---------------------------------------------------------------------------
// Samples: real trial observations of the target, baseline plus every fault.

export interface Samples {
  baseline: Scope[];
  faulted: { fault: string; scope: Scope }[];
  shape: Shape;
}

export async function sampleObservations(target: BulwarkTarget, opts: { perFault?: number; baseline?: number; seed?: number; deadlineMs?: number } = {}): Promise<Samples> {
  const seed = opts.seed ?? 7;
  const run = (fault: ReturnType<typeof faultsFor>[number] | undefined, i: number) =>
    untraced(() => runTrial({ target, fault, seed: seed * 1000 + i, brain: 'simulated', deadlineMs: opts.deadlineMs ?? 5000, maxSteps: 50, traced: false }));
  const baseline = await Promise.all(Array.from({ length: opts.baseline ?? 3 }, (_, i) => run(undefined, i)));
  const faulted = (
    await Promise.all(
      faultsFor(target).map(async (f) => (await Promise.all(Array.from({ length: opts.perFault ?? 3 }, (_, i) => run(f, i)))).map((o) => ({ fault: f.id, obs: o }))),
    )
  ).flat();
  const all = [...baseline, ...faulted.map((x) => x.obs)];
  return { baseline: baseline.map(scopeOf), faulted: faulted.map((x) => ({ fault: x.fault, scope: scopeOf(x.obs) })), shape: inferShape(all.map(scopeOf)) };
}

/** The self-test a candidate check must pass. Returns the reasons it fails (empty = accepted). */
export function selfTest(check: Pred, counterexample: unknown, samples: Samples): { reasons: string[]; result: SelfTest } {
  const reasons: string[] = [];
  const all = [...samples.baseline.map((s) => ({ fault: 'baseline', scope: s })), ...samples.faulted];
  const results = all.map((s) => ({ ...s, r: evaluate(check, s.scope) }));
  const errored = results.filter((x) => x.r.error);
  if (errored.length) reasons.push(`errors on ${errored.length}/${all.length} real trials, e.g. ${errored[0].fault}: ${errored[0].r.error}`);
  const baseOk = results.filter((x) => x.fault === 'baseline' && x.r.ok);
  if (samples.baseline.length && baseOk.length === 0) {
    const first = results.find((x) => x.fault === 'baseline');
    reasons.push(`rejects every fault-free baseline trial (${first?.r.detail ?? ''})`);
  }
  let counterexampleRejected = false;
  let counterexampleDetail: string | undefined;
  if (!counterexample || typeof counterexample !== 'object') {
    reasons.push('no counterexample given, so there is no evidence the check can ever fail');
  } else {
    const base = baseOk[0]?.scope ?? samples.baseline[0] ?? all[0]?.scope ?? {};
    const r = evaluate(check, overlay(base, counterexample));
    counterexampleRejected = !r.ok && !r.error;
    counterexampleDetail = r.detail;
    if (r.error) reasons.push(`errors on its own counterexample: ${r.error}`);
    else if (r.ok) reasons.push('accepts its own counterexample (a violating observation), so it would accept everything');
  }
  const faulted = results.filter((x) => x.fault !== 'baseline');
  return {
    reasons,
    result: {
      samples: all.length,
      baselineSamples: samples.baseline.length,
      baselinePassed: baseOk.length,
      faultedSamples: faulted.length,
      faultedFlagged: faulted.filter((x) => !x.r.ok && !x.r.error).length,
      counterexampleRejected,
      ...(counterexampleDetail ? { counterexampleDetail } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The LLM call.

const COMPILE_SYSTEM = `You compile plain-English business rules for AI agents into checks written in a small declarative JSON DSL.
The check runs on one sandboxed trial of the agent: what actually happened (ledger of side effects, outcome, reply), never what the agent claims.
You never write code. You return the check and one counterexample through the submit_check tool.

DSL. Values (Expr):
  "text" | 3 | true | null                                  literal
  ["completed", "hung"]                                     list of literals
  {"path": "ticket.orderId"}                                 a field of the trial, or of a bound item ("e.body")
  {"agg": "count"|"sum"|"max"|"min", "list": Expr, "as"?: "r", "where"?: Pred, "field"?: "amount", "groupBy"?: "orderId"}
  {"find": Expr, "as": "o", "where": Pred, "field"?: "total"} first matching item (or its field), else null
  {"len": Expr}                                              length of a string or list
  {"lower": Expr}                                            lower-cased string
Predicates (Pred):
  {"cmp": "=="|"!="|"<"|"<="|">"|">="|"contains"|"notContains"|"in"|"startsWith", "left": Expr, "right": Expr}
  {"every": Expr, "as": "e", "where": Pred}                 true on an empty or missing list
  {"some": Expr, "as": "e", "where": Pred}
  {"and": [Pred]} | {"or": [Pred]} | {"not": Pred} | {"if": Pred, "then": Pred} | {"exists": Expr}
Notes: an agg with groupBy may only be the LEFT side of a cmp, and the cmp must then hold for every group.
"contains" works on strings (substring, case-sensitive; wrap both sides in lower for case-insensitive) and lists.
<, <=, >, >= need numbers on both sides: guard nullable fields with exists or if. Paths use dots; list items are reached only through every/some/agg/find.
A rule about a run that did not complete should usually still hold vacuously unless the rule says otherwise.
One trial is one run of the agent on exactly one ticket, so "per ticket", "per run" and "per brief" mean over the whole trial
(every item in the ledger), not only items that mention the ticket's own ids.

Counterexample: a partial trial (same field names as the check uses) that VIOLATES the rule. It is deep-merged over a real
passing trial (objects merge, lists replace), and your check must reject it. Keep it minimal and realistic.`;

const SUBMIT_CHECK = {
  name: 'submit_check',
  description: 'Submit the compiled check for the rule, a one-line reading of the rule, and a counterexample that violates it.',
  input_schema: {
    type: 'object' as const,
    properties: {
      intent: { type: 'string', description: 'one line: what the rule requires, in terms of the trial fields' },
      check: { type: 'object', description: 'the predicate (Pred) in the DSL' },
      counterexample: { type: 'object', description: 'a partial trial that violates the rule' },
    },
    required: ['intent', 'check', 'counterexample'],
  },
};

const clipJson = (v: unknown, n: number) => {
  const s = JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function buildCompilePrompt(target: BulwarkTarget, rule: string, samples: Samples, known: { rule: string; how: string }[], feedback?: string): string {
  const example = samples.baseline[0] ?? samples.faulted[0]?.scope ?? {};
  const trimmed = Object.fromEntries(Object.entries(example).filter(([k]) => k !== 'effects').map(([k, v]) => [k, v]));
  return [
    `## Target: ${target.name}`,
    `## Rule to compile`,
    rule,
    `## Fields of a trial (from ${samples.baseline.length + samples.faulted.length} real trials, baseline and faulted)`,
    describeShape(samples.shape),
    `outcome is one of completed, crashed, hung, runaway. durationMs is wall-clock ms. steps counts model decisions. replyJson is the JSON object in the final reply, or null. effects holds the same ledger lists that are also exposed by name.`,
    `## One real fault-free trial`,
    clipJson(trimmed, 2500),
    `## The target's other rules and how they are checked (for context; compile only the rule above)`,
    ...known.map((k) => `- "${k.rule}": ${k.how}`),
    ...(feedback ? [`## Your previous attempt was rejected`, feedback, 'Fix it and submit again.'] : []),
  ].join('\n');
}

export interface CompileAttempt {
  check?: unknown;
  intent?: string;
  counterexample?: unknown;
  rejected?: string[];
}

export interface CompileOutcome {
  rule: string;
  accepted?: LlmCompiledRule;
  attempts: CompileAttempt[];
}

/** One model call: anything Messages-API shaped (the real client, or a mock in tests). */
export type CompileLlm = (args: { system: string; prompt: string; tool: typeof SUBMIT_CHECK; model: string }) => Promise<{ input: unknown; usage?: Anthropic.Usage }>;

export function anthropicCompileLlm(client: Anthropic = createLlmClient()): CompileLlm {
  return async ({ system, prompt, tool, model }) => {
    const start = performance.now();
    try {
      const res = await client.messages.create(
        {
          model,
          max_tokens: 2000,
          system,
          tools: [tool],
          tool_choice: { type: 'any' },
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: prompt }],
        },
        { timeout: 90_000 },
      );
      recordLlmCall({ role: 'fixer', model, ...usageFromAnthropic(res.usage), ms: performance.now() - start });
      const call = res.content.find((b) => b.type === 'tool_use');
      return { input: call && call.type === 'tool_use' ? call.input : undefined, usage: res.usage };
    } catch (err) {
      recordLlmCall({ role: 'fixer', model, inputTokens: 0, outputTokens: 0, ms: performance.now() - start, error: true });
      throw err;
    }
  };
}

/** Compiles one rule: up to `maxAttempts` model calls, each validated and self-tested; the Judge's feedback goes back in. */
export async function compileRuleWithLlm(args: {
  target: BulwarkTarget;
  rule: string;
  samples: Samples;
  known: { rule: string; how: string }[];
  llm: CompileLlm;
  model?: string;
  maxAttempts?: number;
}): Promise<CompileOutcome> {
  const model = args.model ?? defaultModel('fixer');
  const attempts: CompileAttempt[] = [];
  return trace({ name: 'rules.llm-compile', kind: 'AGENT', attributes: { target: args.target.name, rule: args.rule, model } }, async () => {
    for (let i = 0; i < (args.maxAttempts ?? 2); i++) {
      const feedback = attempts.at(-1)?.rejected?.join('\n');
      let input: unknown;
      try {
        input = (await args.llm({ system: COMPILE_SYSTEM, prompt: buildCompilePrompt(args.target, args.rule, args.samples, args.known, feedback), tool: SUBMIT_CHECK, model })).input;
      } catch (err) {
        attempts.push({ rejected: [`LLM call failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`] });
        continue;
      }
      const { check, intent, counterexample } = (input ?? {}) as { check?: unknown; intent?: unknown; counterexample?: unknown };
      const attempt: CompileAttempt = { check, intent: typeof intent === 'string' ? intent : undefined, counterexample };
      attempts.push(attempt);
      try {
        validateCheck(check, { shape: args.samples.shape });
      } catch (err) {
        attempt.rejected = [`invalid check: ${err instanceof Error ? err.message : err}`];
        continue;
      }
      const t = selfTest(check as Pred, counterexample, args.samples);
      if (t.reasons.length) {
        attempt.rejected = t.reasons.map((r) => `self-test: ${r}`);
        continue;
      }
      return {
        rule: args.rule,
        attempts,
        accepted: {
          target: args.target.name,
          rule: args.rule,
          dslVersion: DSL_VERSION,
          check: check as Pred,
          how: explainCheck(check as Pred),
          intent: attempt.intent ?? '',
          counterexample,
          selfTest: t.result,
          model,
          compiledAt: new Date().toISOString(),
        },
      };
    }
    return { rule: args.rule, attempts };
  });
}

/**
 * Re-validates and re-self-tests a cached entry against fresh samples (e.g. before writing a lockfile, or
 * when loading one someone edited by hand). Returns the reasons it fails; empty means it still holds.
 */
export function recheck(entry: LlmCompiledRule, samples: Samples): string[] {
  try {
    validateCheck(entry.check, { shape: samples.shape });
  } catch (err) {
    return [`invalid check: ${err instanceof Error ? err.message : err}`];
  }
  return selfTest(entry.check, entry.counterexample, samples).reasons;
}

// ---------------------------------------------------------------------------
// Wiring: compile what the pattern library can't, before a run.

export interface RuleReport {
  rule: string;
  source: 'target' | 'pattern' | 'llm' | 'uncompiled';
  how?: string;
  dsl?: Pred;
  /** For LLM rules: compiled in this call (false = read from the cache or lockfile, free). */
  fresh?: boolean;
  selfTest?: SelfTest;
  /** Why the LLM compiler gave up, when it did. */
  rejected?: string[];
}

/**
 * Compiles a target's rules: target checks and patterns as before, cached LLM checks for free,
 * and, when an LLM is configured (or passed in), Claude compiles whatever is left. Accepted
 * checks are written to the local cache, so the scorecard (which compiles synchronously) sees them.
 * Without an LLM, nothing changes: uncompiled rules stay uncompiled.
 */
export async function prepareRules(
  target: BulwarkTarget,
  opts: { llm?: CompileLlm | null; model?: string; samples?: Samples; cachePath?: string; recompile?: boolean; onCompile?: (o: CompileOutcome) => void } = {},
): Promise<RuleReport[]> {
  const paths = opts.cachePath ? [opts.cachePath] : undefined;
  const compile = () => compileRules(target.rules, target.checks, { target: target.name, ...(paths ? { cachePaths: paths } : {}) });
  const first = compile();
  const todo = [...(opts.recompile ? first.compiled.filter((c) => c.source === 'llm').map((c) => c.rule) : []), ...first.uncompiled];
  // null: never call an LLM (e.g. tests); undefined: the configured provider, if any.
  const llm = opts.llm === null ? undefined : (opts.llm ?? (todo.length && llmProvider() ? anthropicCompileLlm() : undefined));
  const fresh = new Map<string, CompileOutcome>();
  if (todo.length && llm) {
    const samples = opts.samples ?? (await sampleObservations(target));
    const known = first.compiled.filter((c) => !todo.includes(c.rule)).map(({ rule, how }) => ({ rule, how }));
    for (const rule of todo) {
      const out = await compileRuleWithLlm({ target, rule, samples, known, llm, model: opts.model });
      fresh.set(rule, out);
      opts.onCompile?.(out);
      if (out.accepted) saveCompiled([out.accepted], opts.cachePath);
    }
  }
  const { compiled } = compile();
  return target.rules.map((rule): RuleReport => {
    const c = compiled.find((x) => x.rule === rule);
    const out = fresh.get(rule);
    if (!c) return { rule, source: 'uncompiled', ...(out ? { rejected: out.attempts.flatMap((a) => a.rejected ?? []) } : {}) };
    if (c.source !== 'llm') return { rule, source: c.source ?? 'pattern', how: c.how };
    const entry = out?.accepted ?? lookupCompiled(target.name, rule, paths);
    return { rule, source: 'llm', how: c.how, dsl: c.dsl, fresh: Boolean(out?.accepted), ...(entry ? { selfTest: entry.selfTest } : {}) };
  });
}

/** One line per rule for a console: where its check came from, and the DSL for LLM-compiled ones. */
export function describeRules(reports: RuleReport[]): string[] {
  const tag = (r: RuleReport) =>
    r.source === 'llm' ? `LLM (${r.fresh ? 'compiled now' : 'cached'})` : r.source === 'target' ? 'target check' : r.source === 'pattern' ? 'pattern' : 'UNCOMPILED';
  return reports.flatMap((r) => [
    `${tag(r).padEnd(22)} ${r.rule}`,
    ...(r.dsl ? [`${' '.repeat(23)}DSL ${JSON.stringify(r.dsl)}`] : []),
    ...(r.selfTest
      ? [`${' '.repeat(23)}self-test: ${r.selfTest.baselinePassed}/${r.selfTest.baselineSamples} baseline pass, flags ${r.selfTest.faultedFlagged}/${r.selfTest.faultedSamples} faulted trials, counterexample ${r.selfTest.counterexampleRejected ? 'rejected' : 'NOT rejected'}`]
      : []),
    ...(r.rejected?.length ? [`${' '.repeat(23)}LLM compiler gave up: ${r.rejected.join('; ')}`] : []),
  ]);
}
