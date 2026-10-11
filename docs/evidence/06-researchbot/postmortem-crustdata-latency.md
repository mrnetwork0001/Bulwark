# Postmortem: crustdata-latency

**Run** 2026-10-11T07-42-15-350Z · **Status** ✅ fixed and verified

## Hypothesis
If /company/enrich takes 10s to respond, ResearchBot hangs because enrich_company has no timeout.

## Blast radius (before)
24/40 trials passed (95% CI 45%–74%).
Outcomes: 24 completed, 16 hung. Broken rules: 16× Every ticket gets a brief or an explicit 'not found'.; 16× A run finishes within 5 seconds.
- Replay: seed 3466302124 → Every ticket gets a brief or an explicit 'not found'. (run hung, no brief)
- Replay: seed 3466302124 → A run finishes within 5 seconds. (took 5001ms (limit 5000ms))

## Weak links found in the code
- `tools.ts:73` enrich_company calls company.enrich with no timeout
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
neatlogs read-back unavailable (NEATLOGS_API_KEY not set); used local evidence.

## Attempts

### ✅ Attempt 1: Timeout on every Crustdata call (`timeout`, by playbook)
Bound each call to 1.5s so a slow response cannot hang the run.

Checkpoint before attempt: `ckpt-005`. Judge: **fixed**. 24/40 → 40/40 on fresh seeds (p=2.3e-6), no regressions.
Overhead: happy path p50 29→28ms (-1%), p95 31→30ms (-4%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
Bound each call to 1.5s so a slow response cannot hang the run.

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index eb1bc08..7e8a9cd 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -109,9 +109,24 @@ function retryDelayMs(err: unknown, attempt: number): number {
   return Number.isFinite(reset) && reset > 0 ? reset * 1000 + 50 : 100 * 2 ** attempt;
 }
 
+const CALL_TIMEOUT_MS = 1500;
+
+// bulwark:call-timeout: no Crustdata call may hang the run
+function withTimeout(transport: Transport, ms: number): Transport {
+  return (endpoint, payload) =>
+    new Promise((resolve, reject) => {
+      const t = setTimeout(() => reject(new Error(`${endpoint} timed out after ${ms}ms`)), ms);
+      transport(endpoint, payload).then(
+        (v) => (clearTimeout(t), resolve(v)),
+        (e) => (clearTimeout(t), reject(e)),
+      );
+    });
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport): Tools {
+  transport = withTimeout(transport, CALL_TIMEOUT_MS);
   transport = withRetry(transport);
   return {
     enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 29→28ms (-1%), p95 31→30ms (-4%), steps 3.0→3.0 (+0.0), cost n/a.
Under crustdata-latency (informational, not budgeted): p50 94→92ms, avg steps 2.2→3.0.


## Proof the regression test guards the fix
With the fix removed: 24/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
