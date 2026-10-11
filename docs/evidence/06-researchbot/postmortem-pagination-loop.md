# Postmortem: pagination-loop

**Run** 2026-10-11T07-42-15-350Z · **Status** ✅ fixed and verified

## Hypothesis
If /person/search ignores the cursor and keeps returning page 1 with a next_cursor, ResearchBot pages forever: unbounded calls, credits and time.

## Blast radius (before)
19/40 trials passed (95% CI 33%–63%).
Outcomes: 19 completed, 21 hung. Broken rules: 21× Every ticket gets a brief or an explicit 'not found'.; 21× A run finishes within 5 seconds.; 21× Never spend more than 5 API credits per brief.
- Replay: seed 135730802 → Every ticket gets a brief or an explicit 'not found'. (run hung, no brief)
- Replay: seed 135730802 → A run finishes within 5 seconds. (took 5001ms (limit 5000ms))
- Replay: seed 135730802 → Never spend more than 5 API credits per brief. (spent 744.17 credits over 1904 API calls (limit 5))

## Weak links found in the code
- `agent.ts:64` the agent loop has no step budget, so a stuck tool means unbounded steps and cost
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched
- `tools.ts:89` search_people follows person.search's next_cursor with no page cap, so a stuck cursor means unbounded calls and credits
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
neatlogs read-back unavailable (NEATLOGS_API_KEY not set); used local evidence.

## Attempts

### ❌ Attempt 1: Step budget (`step-budget`, by playbook)
Cap the agent at 6 steps so a stuck run cannot go on forever.

Checkpoint before attempt: `ckpt-007`. Judge: **rejected**. still failing 21/40 trials (21× Every ticket gets a brief or an explicit 'not found'.; 21× A run finishes within 5 seconds.; 21× Never spend more than 5 API credits per brief.).
Overhead: happy path p50 39→33ms (-16%), p95 41→35ms (-16%), steps 3.0→3.0 (+0.0), cost n/a.
Rolled back to `ckpt-007`.

### ✅ Attempt 2: Cursor cap + dedupe (bounds credits per brief) (`cursor-cap`, by playbook)
The loop is inside one tool call, so a step budget never sees it. Follow next_cursor for at most 2 pages (every page is billed) and keep each person once.

Checkpoint before attempt: `ckpt-008`. Judge: **fixed**. 19/40 → 40/40 on fresh seeds (p=1.3e-8), no regressions.
Overhead: happy path p50 39→35ms (-11%), p95 41→37ms (-11%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
The loop is inside one tool call, so a step budget never sees it. Follow next_cursor for at most 2 pages (every page is billed) and keep each person once.

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 7035bf5..766f48d 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -132,6 +132,8 @@ function requireJson(transport: Transport): Transport {
   };
 }
 
+const MAX_PAGES = 2;
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport): Tools {
@@ -147,13 +149,14 @@ export function createTools(transport: Transport): Tools {
     search_people: span({ kind: 'TOOL', name: 'search_people', toolName: 'search_people' }, async (input) => {
       const people: PersonFacts[] = [];
       let cursor: string | null = null;
-      // Collect every page of leaders.
+      let pages = 0;
+      // bulwark:cursor-cap: at most MAX_PAGES pages (each page costs credits), and each person once
       do {
         const raw = await transport('person.search', { ...peopleQuery(String(input.domain), Number(input.limit ?? 3)), ...(cursor ? { cursor } : {}) });
         const page = JSON.parse(raw) as PersonSearchResponse;
-        for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
+        for (const p of page.profiles) if (!people.some((x) => x.id === p.crustdata_person_id)) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
         cursor = page.next_cursor;
-      } while (cursor);
+      } while (cursor && ++pages < MAX_PAGES);
       return people;
     }),
   };
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 39→35ms (-11%), p95 41→37ms (-11%), steps 3.0→3.0 (+0.0), cost n/a.
Under pagination-loop (informational, not budgeted): p50 5000→149ms, avg steps 2.5→3.0.


## Proof the regression test guards the fix
With the fix removed: 16/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
