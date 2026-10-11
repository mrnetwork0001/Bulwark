# Postmortem: model-degradation

**Run** 2026-10-11T16-51-52-496Z · **Status** ✅ fixed and verified

## Hypothesis
If the provider routes ResearchBot to a weaker model, it skips the people search, rounds numbers and answers in prose; the brief is only trustworthy if it is rebuilt from tool results in code.

## Blast radius (before)
12/40 trials passed (95% CI 18%–45%).
Outcomes: 40 completed. Broken rules: 11× Every brief cites only data returned by the API.; 11× Never report a person without a source record.; 9× Every ticket gets a brief or an explicit 'not found'.
- Replay: seed 3404486461 → Never report a person without a source record. (no source record for "Alex Morgan", "Priya Shah" (person.search returned 0 people))
- Replay: seed 1828430848 → Every ticket gets a brief or an explicit 'not found'. (reply is neither a brief nor "not found": "Retool (retool.com) has about 400 employees. Key people: Alex Morgan (Chief Executive Officer), Priya Shah (VP of Engin)
- Replay: seed 3909296889 → Every brief cites only data returned by the API. (headcount 400 is not in any API response (API returned [416]))

## What neatlogs recorded
neatlogs read-back unavailable (neatlogs read-back disabled (wait 0)); used local evidence.

## Attempts

### ❌ Attempt 1: Validate the company record (`schema-validation`, by playbook)
Read every field defensively.

Checkpoint before attempt: `ckpt-001`. Judge: **rejected**. still failing 28/40 trials (11× Every brief cites only data returned by the API.; 11× Never report a person without a source record.; 9× Every ticket gets a brief or an explicit 'not found'.).
Overhead: happy path p50 29→22ms (-24%), p95 31→25ms (-20%), steps 3.0→3.0 (+0.0), cost n/a.
Rolled back to `ckpt-001`.

### ✅ Attempt 2: Ground the brief in tool results (`ground-brief`, by playbook)
A weaker model rounds numbers, skips the people search and answers in prose. Don't depend on its judgment: rebuild the brief from tool results in code, so it is always JSON and only states what the API returned.

Checkpoint before attempt: `ckpt-002`. Judge: **fixed**. 12/40 → 40/40 on fresh seeds (p=1.9e-12), no regressions.
Overhead: happy path p50 29→28ms (-5%), p95 31→30ms (-3%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
A weaker model rounds numbers, skips the people search and answers in prose. Don't depend on its judgment: rebuild the brief from tool results in code, so it is always JSON and only states what the API returned.

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
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 29→28ms (-5%), p95 31→30ms (-3%), steps 3.0→3.0 (+0.0), cost n/a.
Under model-degradation (informational, not budgeted): p50 148→141ms, avg steps 2.7→2.7.


## Proof the regression test guards the fix
With the fix removed: 12/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
