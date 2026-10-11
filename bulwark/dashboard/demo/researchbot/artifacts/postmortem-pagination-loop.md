# Postmortem: pagination-loop

**Run** 2026-10-11T23-15-42-880Z · **Status** ✅ fixed and verified

## Hypothesis
If /person/search ignores the cursor and keeps returning page 1 with a next_cursor, ResearchBot pages forever: unbounded calls, credits and time.

## Blast radius (before)
19/40 trials passed (95% CI 33%–63%).
Outcomes: 19 completed, 21 hung. Broken rules: 21× Every ticket gets a brief or an explicit 'not found'.; 21× A run finishes within 5 seconds.; 21× Never spend more than 5 API credits per brief.; 21× Never call the same API endpoint more than 20 times in one run.
- Replay: seed 135730802 → Every ticket gets a brief or an explicit 'not found'. (run hung, no brief), neatlogs trace `dd9d212f2cd116a4da0dbd221ea112a5`
- Replay: seed 135730802 → A run finishes within 5 seconds. (took 5000ms (limit 5000ms)), neatlogs trace `dd9d212f2cd116a4da0dbd221ea112a5`
- Replay: seed 135730802 → Never spend more than 5 API credits per brief. (spent 726.23 credits over 1858 API calls (limit 5)), neatlogs trace `dd9d212f2cd116a4da0dbd221ea112a5`
- Replay: seed 135730802 → Never call the same API endpoint more than 20 times in one run. (endpoint "person.search": the number of apiCalls per endpoint <= 20 fails (1857 vs 20)), neatlogs trace `dd9d212f2cd116a4da0dbd221ea112a5`

## Weak links found in the code
- `agent.ts:64` the agent loop has no step budget, so a stuck tool means unbounded steps and cost
  - Blast radius (Entire Graph): runResearchBot (function, targets/researchbot/agent.ts:60) ← 0 callers
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched
- `tools.ts:89` search_people follows person.search's next_cursor with no page cap, so a stuck cursor means unbounded calls and credits
  - Blast radius (Entire Graph): createTools (function, targets/researchbot/tools.ts:70) ← 1 caller: runResearchBot (targets/researchbot/agent.ts:62)
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
Diagnosed from neatlogs trace d30d609c6795153b763f67bc7b338f58 (4 spans, 3 detections; failing trial seed 1792856198 from the BEFORE scorecard).

## Attempts

### ✅ Attempt 1: Cap pagination pages, cursor progress, and overall step/call budgets (`page-cap+cursor-progress-check+step-budget`, by claude-sonnet-5)
search_people's pagination loop trusted next_cursor unconditionally: if the API returns the same page/cursor forever (or a cursor that never advances), the loop runs until the process-level wall-clock deadline fires a TimeoutError deep inside a single call, after already issuing thousands of requests and burning thousands of credits/calls before that error is even thrown. That blows the 5s/5-credit/20-calls-per-endpoint/8-steps budgets long before the timeout mechanism can stop it, because the timeout only guards one in-flight transport call, not the number of iterations of the do/while loop around it.

Fix at the root: bound the pagination loop itself by a small, generous-but-finite max page count, and detect a non-advancing cursor (the actual fault here: cursor ignored, same page echoed back with a next_cursor) by comparing the new cursor to the previous one and stopping as soon as it repeats or the page returned no new profiles. This makes a single search_people call cost at most a handful of API calls/credits regardless of a stuck backend, independent of and in addition to the per-call timeout. Also add a hard step cap in the agent loop as defense in depth so a brain stuck deciding to call tools forever cannot run away either, surfacing a "not found" instead of hanging past the step/time budget.

Checkpoint before attempt: `ckpt-010`. Judge: **fixed**. 19/40 → 59/59 on fresh seeds (p=8.1e-11), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 32→32ms (-2%), p95 35→34ms (-3%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
search_people's pagination loop trusted next_cursor unconditionally: if the API returns the same page/cursor forever (or a cursor that never advances), the loop runs until the process-level wall-clock deadline fires a TimeoutError deep inside a single call, after already issuing thousands of requests and burning thousands of credits/calls before that error is even thrown. That blows the 5s/5-credit/20-calls-per-endpoint/8-steps budgets long before the timeout mechanism can stop it, because the timeout only guards one in-flight transport call, not the number of iterations of the do/while loop around it.

Fix at the root: bound the pagination loop itself by a small, generous-but-finite max page count, and detect a non-advancing cursor (the actual fault here: cursor ignored, same page echoed back with a next_cursor) by comparing the new cursor to the previous one and stopping as soon as it repeats or the page returned no new profiles. This makes a single search_people call cost at most a handful of API calls/credits regardless of a stuck backend, independent of and in addition to the per-call timeout. Also add a hard step cap in the agent loop as defense in depth so a brain stuck deciding to call tools forever cannot run away either, surfacing a "not found" instead of hanging past the step/time budget.

```diff
diff --git a/targets/researchbot/agent.ts b/targets/researchbot/agent.ts
index 7aa03e4..7d57a56 100644
--- a/targets/researchbot/agent.ts
+++ b/targets/researchbot/agent.ts
@@ -57,6 +57,13 @@ export const SYSTEM_PROMPT =
   '"people":[{"name":string,"title":string}] (2-3 people)}. If the company cannot be found, reply ' +
   '{"status":"not found","domain":string}.';
 
+// bulwark: a step is one brain.decide call; the business rule caps a run at 8 of them. Bound the
+// loop at that limit (defense in depth alongside tools.ts's own per-tool page/time caps) so a
+// brain that keeps deciding to call tools, or a tool that keeps returning without ever letting
+// the brain finish, can't run away: once the cap is hit we stop and report "not found" rather
+// than loop, crash, or hang past the step/time budget.
+const MAX_STEPS = 8;
+
 // bulwark:grounded: the brief may only state what a tool returned. It is rebuilt from the tool
 // results: values the API didn't return become null, people the search never returned are dropped
 // (each person once), and no company means an explicit "not found".
@@ -97,15 +104,25 @@ function groundBrief(reply: string, history: Step[]): string {
   });
 }
 
+/** Build a grounded "not found" reply from whatever enrich_company call (if any) was attempted. */
+function notFoundReply(history: Step[]): string {
+  const asked = history.find((s) => s.tool === 'enrich_company')?.input.domain;
+  const domain = typeof asked === 'string' ? asked : null;
+  return JSON.stringify({ status: 'not found', domain });
+}
+
 export async function runResearchBot(ticket: Ticket, deps: { transport: Transport; brain: Brain }): Promise<RunResult> {
   return trace({ name: 'researchbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } }, async () => {
     const tools = createTools(deps.transport);
     const history: Step[] = [];
-    while (true) {
+    for (let step = 0; step < MAX_STEPS; step++) {
       const decision = await deps.brain.decide({ ticket, history });
       if (decision.type === 'final') return { reply: groundBrief(decision.reply, history), steps: history };
       const output = await tools[decision.name](decision.input);
       history.push({ tool: decision.name, input: decision.input, output });
     }
+    // Hit the step cap without the brain producing a final answer: report "not found" rather
+    // than loop further, so the run always completes within the step/time budget.
+    return { reply: notFoundReply(history), steps: history };
   });
 }
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index fb50579..12b56de 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -126,12 +126,23 @@ export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise
 // retrying (the same cursor would just be re-fetched), so instead of treating it as fatal we
 // stop paginating and keep whatever complete pages we already parsed, same as we'd keep a
 // partial list on a 429/5xx/timeout we can't recover from.
+//
+// A stuck cursor (the API ignores the cursor we send and keeps echoing page 1 with a
+// `next_cursor` set) is a fourth kind of fault: nothing ever errors, so the per-call timeout
+// never fires, but the do/while pagination loop would otherwise run forever, issuing an
+// unbounded number of calls/credits before any single call's timeout could even trip. We
+// guard against that directly: a hard cap on the number of pages fetched per search_people
+// call, plus an explicit check that each new page actually makes progress (a new cursor we
+// haven't seen, and at least one profile we haven't already collected). Either guard tripping
+// just stops pagination and returns what's been collected so far, the same as any other
+// recoverable partial-result case above.
 
 const RUN_DEADLINE_MS = 5000;
 const DEFAULT_RATE_LIMIT_WAIT_MS = 2100; // just past the documented 2s reset window
 const SERVER_ERROR_RETRY_WAIT_MS = 150; // short fixed backoff for a transient 5xx
 const SAFETY_MARGIN_MS = 300; // leave room to parse, decide, and reply after the wait
 const MIN_CALL_TIMEOUT_MS = 50; // never race with a non-positive/instant timeout
+const MAX_PERSON_SEARCH_PAGES = 5; // hard cap: 5 pages x ~3 profiles x 0.13 credits stays well under the 5-credit budget
 
 const runStartedAt = Date.now();
 
@@ -262,10 +273,19 @@ export function createTools(transport: Transport): Tools {
       const domain = String(input.domain);
       const limit = Number(input.limit ?? 3);
       const people: PersonFacts[] = [];
+      const seenIds = new Set<number>();
+      const seenCursors = new Set<string>();
       let cursor: string | null = null;
+      let pages = 0;
       try {
-        // Collect every page of leaders.
+        // Collect pages of leaders, but never more than MAX_PERSON_SEARCH_PAGES, and stop as
+        // soon as a page fails to make progress (same cursor seen before, or no new profiles) --
+        // that's the signature of a backend that ignores the cursor and echoes the same page
+        // forever. Without this, a stuck cursor would make this loop (not just a single
+        // transport call) run unbounded, blowing the credit/call/time budgets long before any
+        // per-call timeout could trip.
         do {
+          pages += 1;
           const raw = await withRateLimitRetry(
             () => transport('person.search', { ...peopleQuery(domain, limit), ...(cursor ? { cursor } : {}) }),
             1,
@@ -274,8 +294,18 @@ export function createTools(transport: Transport): Tools {
           // instead of letting a raw SyntaxError escape; withRateLimitRetry's isTransient()
           // check (and the catch below) treat that the same as a 429/5xx/timeout.
           const page = parsePersonPage(raw);
-          for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
-          cursor = page.next_cursor;
+          let gotNew = false;
+          for (const p of page.profiles) {
+            if (seenIds.has(p.crustdata_person_id)) continue;
+            seenIds.add(p.crustdata_person_id);
+            people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
+            gotNew = true;
+          }
+          const nextCursor = page.next_cursor;
+          const cursorRepeats = nextCursor !== null && seenCursors.has(nextCursor);
+          if (nextCursor !== null) seenCursors.add(nextCursor);
+          if (!gotNew || cursorRepeats || pages >= MAX_PERSON_SEARCH_PAGES) break;
+          cursor = nextCursor;
         } while (cursor);
       } catch (err) {
         if (!isTransient(err)) throw err;
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 32→32ms (-2%), p95 35→34ms (-3%), steps 3.0→3.0 (+0.0), cost n/a.
Under pagination-loop (informational, not budgeted): p50 5000→189ms, avg steps 2.5→3.0.


## Proof the regression test guards the fix
With the fix removed: 16/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
