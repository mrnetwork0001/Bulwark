# Postmortem: missing-field

**Run** 2026-10-11T23-15-42-880Z · **Status** ✅ fixed and verified

## Hypothesis
If /company/enrich returns a partial record (no headcount), ResearchBot crashes on the missing field, or, once that is guarded, invents a headcount.

## Blast radius (before)
20/40 trials passed (95% CI 35%–65%).
Outcomes: 20 completed, 20 crashed. Broken rules: 20× Every ticket gets a brief or an explicit 'not found'.
- Replay: seed 677964271 → Every ticket gets a brief or an explicit 'not found'. (run crashed, no brief)

## Weak links found in the code
- `agent.ts:66` the model's final answer is returned unchecked, so when a tool returns nothing (or a field is missing) it can invent people and numbers
  - Blast radius (Entire Graph): runResearchBot (function, targets/researchbot/agent.ts:60) ← 0 callers
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched
- `tools.ts:73` enrich_company reads nested fields from company.enrich without checking they exist
  - Blast radius (Entire Graph): createTools (function, targets/researchbot/tools.ts:70) ← 1 caller: runResearchBot (targets/researchbot/agent.ts:62)
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
Diagnosed from neatlogs trace d30d609c6795153b763f67bc7b338f58 (3 spans, 3 detections; failing trial seed 303253422 from the BEFORE scorecard).

## Attempts

### ❌ Attempt 1: Validate the company record (`schema-validation`, by playbook)
Read every field defensively: a missing section becomes null instead of a TypeError, and no match becomes an explicit "not found".

Checkpoint before attempt: `ckpt-001`. Judge: **rejected**. still failing 21/59 trials (21× Every brief cites only data returned by the API.); SLO 95% not demonstrated: 38/59 passed; achieved lower bound 52.92% at 95% confidence.
Overhead: happy path p50 27→236ms (+764%), p95 31→253ms (+722%), steps 3.0→3.0 (+0.0), cost n/a.
Rolled back to `ckpt-001`.

### ❌ Attempt 2: Guard missing company/person fields and tool errors so ResearchBot never crashes or invents data (`defensive-tool-io-plus-prompt-constraint`, by claude-sonnet-5)
The crash came from tools.ts assuming company.enrich always returns a full match with every nested section present; when headcount (or the whole match) was missing, destructuring threw TypeError before the brain ever got a chance to answer, so the run crashed with no brief. The previous attempt only null-guarded fields but still let the model fabricate values/people and didn't harden against a totally missing match (matches array empty), and didn't guard search_people's profile fields either. This patch: (1) makes enrich_company fully defensive - no match returns an explicit found:false record with all nulls instead of throwing, every section read with optional chaining falling back to null; (2) makes search_people skip malformed profile entries instead of crashing, and treats next_cursor defensively; (3) wraps the tool invocation loop in agent.ts in a try/catch so any tool error becomes a step the brain can observe (enabling an explicit not-found reply) rather than crashing the whole run; (4) strengthens SYSTEM_PROMPT to explicitly instruct the model to use null for unreturned fields instead of guessing, and to only cite people/titles actually returned, directly addressing the "cites only data returned" and "no invented person" business rules without special-casing the test.

Checkpoint before attempt: `ckpt-002`. Judge: **rejected**. still failing 21/59 trials (21× Every brief cites only data returned by the API.); SLO 95% not demonstrated: 38/59 passed; achieved lower bound 52.92% at 95% confidence.
Overhead: happy path p50 27→119ms (+335%), p95 31→123ms (+300%), steps 3.0→3.0 (+0.0), cost n/a.
Rolled back to `ckpt-002`.

### ❌ Attempt 3: Guard enrich_company/search_people against partial data, never backfill guesses (`defensive-io-plus-explicit-null-passthrough`, by claude-sonnet-5)
The crash is in tools.ts: enrich_company destructures company.enrich's nested sections (basic_info, headcount, taxonomy, funding) and the match itself with non-null assertions (company.basic_info!.name etc.) and direct indexing (matches[0]), so a partial record missing headcount, or a response with no match at all, throws a TypeError before the brain ever sees a result, crashing the whole run (matches the neatlogs trace: 'Cannot read properties of undefined (reading total)'). The previously rejected patches null-guarded fields but evidently still let the model fabricate a plausible headcount/value when it saw null, and/or didn't fully guard the no-match case and search_people's profile fields, so brief-citation violations persisted. This patch: (1) makes enrich_company fully optional-chained for every nested field and explicitly returns a `found: false`, all-null record when there is no match at all, so there is never an exception and never a fabricated fallback; (2) makes search_people skip any profile missing a name instead of crashing or inventing one, and defensively reads next_cursor; (3) wraps the tool call in agent.ts in try/catch so any residual tool error surfaces as an observable error step instead of an uncaught crash, letting the brain still produce an explicit {status:'not found'}; (4) strengthens SYSTEM_PROMPT to explicitly instruct the model that a null field (including the no-match case) must be carried through unchanged, never replaced by a guess, and that only people/titles actually returned by search_people may be listed - directly targeting the still-failing 'cites only data returned' and 'no person without a source record' rules without special-casing any specific ticket or domain.

Checkpoint before attempt: `ckpt-003`. Judge: **rejected**. still failing 21/59 trials (21× Every brief cites only data returned by the API.); SLO 95% not demonstrated: 38/59 passed; achieved lower bound 52.92% at 95% confidence.
Overhead: happy path p50 27→60ms (+121%), p95 31→64ms (+108%), steps 3.0→3.0 (+0.0), cost n/a.
Rolled back to `ckpt-003`.

### ✅ Attempt 4: Validate the record and ground the brief (`schema-validation+ground-brief`, by playbook)
With the crash gone, the model fills the missing headcount with a guess. Rebuild the brief from the tool results so it can only state what the API returned (unknown → null).

Checkpoint before attempt: `ckpt-004`. Judge: **fixed**. 20/40 → 59/59 on fresh seeds (p=3.2e-10), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 27→85ms (+211%), p95 31→89ms (+191%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
With the crash gone, the model fills the missing headcount with a guess. Rebuild the brief from the tool results so it can only state what the API returned (unknown → null).

```diff
diff --git a/targets/researchbot/agent.ts b/targets/researchbot/agent.ts
index b2cfaaa..7aa03e4 100644
--- a/targets/researchbot/agent.ts
+++ b/targets/researchbot/agent.ts
@@ -4,7 +4,7 @@
 
 import { trace } from 'neatlogs';
 import type { Transport } from './crustdata';
-import { createTools, type ToolName } from './tools';
+import { createTools, type CompanyFacts, type PersonFacts, type ToolName } from './tools';
 
 export interface Ticket {
   id: string;
@@ -57,13 +57,53 @@ export const SYSTEM_PROMPT =
   '"people":[{"name":string,"title":string}] (2-3 people)}. If the company cannot be found, reply ' +
   '{"status":"not found","domain":string}.';
 
+// bulwark:grounded: the brief may only state what a tool returned. It is rebuilt from the tool
+// results: values the API didn't return become null, people the search never returned are dropped
+// (each person once), and no company means an explicit "not found".
+function groundBrief(reply: string, history: Step[]): string {
+  const company = history
+    .filter((s) => s.tool === 'enrich_company')
+    .map((s) => s.output as (Partial<CompanyFacts> & { notFound?: boolean }) | undefined)
+    .at(-1);
+  const asked = history.find((s) => s.tool === 'enrich_company')?.input.domain;
+  const domain = company?.domain ?? (typeof asked === 'string' ? asked : null);
+  if (!company || company.notFound || typeof company.name !== 'string') return JSON.stringify({ status: 'not found', domain });
+  const found = new Map<string, PersonFacts>();
+  for (const s of history) {
+    if (s.tool !== 'search_people' || !Array.isArray(s.output)) continue;
+    for (const p of s.output as PersonFacts[]) if (!found.has(p.name)) found.set(p.name, p);
+  }
+  let claimed: { name?: string }[] = [];
+  try {
+    const brief = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
+    if (Array.isArray(brief.people)) claimed = brief.people;
+  } catch {
+    // not JSON: keep no people rather than guess
+  }
+  const people = [...new Set(claimed.map((p) => p?.name))]
+    .flatMap((name) => {
+      const p = name ? found.get(name) : undefined;
+      return p ? [{ name: p.name, title: p.title }] : [];
+    })
+    .slice(0, 3);
+  return JSON.stringify({
+    status: 'ok',
+    name: company.name,
+    domain: company.domain ?? domain,
+    headcount: company.headcount ?? null,
+    industry: company.industry ?? null,
+    fundingUsd: company.fundingUsd ?? null,
+    people,
+  });
+}
+
 export async function runResearchBot(ticket: Ticket, deps: { transport: Transport; brain: Brain }): Promise<RunResult> {
   return trace({ name: 'researchbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } }, async () => {
     const tools = createTools(deps.transport);
     const history: Step[] = [];
     while (true) {
       const decision = await deps.brain.decide({ ticket, history });
-      if (decision.type === 'final') return { reply: decision.reply, steps: history };
+      if (decision.type === 'final') return { reply: groundBrief(decision.reply, history), steps: history };
       const output = await tools[decision.name](decision.input);
       history.push({ tool: decision.name, input: decision.input, output });
     }
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 7f84d43..6289f8c 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -65,20 +65,30 @@ export function peopleQuery(domain: string, limit: number): Record<string, unkno
   };
 }
 
+// bulwark:schema: a missing section becomes null instead of a crash; no match is an explicit "not found"
+function parseCompany(raw: string, domain: string): CompanyFacts | { notFound: true; domain: string } {
+  const body = JSON.parse(raw) as EnrichResponse;
+  const data = Array.isArray(body) ? body[0]?.matches?.[0]?.company_data : undefined;
+  const name = data?.basic_info?.name;
+  if (!data || typeof name !== 'string') return { notFound: true, domain };
+  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
+  const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
+  return {
+    name,
+    domain: str(data.basic_info?.primary_domain) ?? domain,
+    headcount: num(data.headcount?.total),
+    industry: str(data.taxonomy?.professional_network_industry),
+    fundingUsd: num(data.funding?.total_investment_usd),
+  };
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport): Tools {
   return {
     enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
       const raw = await transport('company.enrich', enrichRequest(String(input.domain)));
-      const company = (JSON.parse(raw) as EnrichResponse)[0].matches[0].company_data;
-      return {
-        name: company.basic_info!.name,
-        domain: company.basic_info!.primary_domain,
-        headcount: company.headcount!.total,
-        industry: company.taxonomy!.professional_network_industry,
-        fundingUsd: company.funding!.total_investment_usd,
-      };
+      return parseCompany(raw, String(input.domain));
     }),
 
     search_people: span({ kind: 'TOOL', name: 'search_people', toolName: 'search_people' }, async (input) => {
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 27→85ms (+211%), p95 31→89ms (+191%), steps 3.0→3.0 (+0.0), cost n/a.
Under missing-field (informational, not budgeted): p50 60→343ms, avg steps 2.0→3.0.


## Proof the regression test guards the fix
With the fix removed: 12/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
