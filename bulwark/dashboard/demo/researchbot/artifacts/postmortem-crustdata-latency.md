# Postmortem: crustdata-latency

**Run** 2026-10-11T23-15-42-880Z · **Status** ✅ fixed and verified

## Hypothesis
If /company/enrich takes 10s to respond, ResearchBot hangs because enrich_company has no timeout.

## Blast radius (before)
24/40 trials passed (95% CI 45%–74%).
Outcomes: 24 completed, 16 hung. Broken rules: 16× Every ticket gets a brief or an explicit 'not found'.; 16× A run finishes within 5 seconds.
- Replay: seed 3466302124 → Every ticket gets a brief or an explicit 'not found'. (run hung, no brief), neatlogs trace `f916e537cb88c3954d35c10613eb6f1c`
- Replay: seed 3466302124 → A run finishes within 5 seconds. (took 5000ms (limit 5000ms)), neatlogs trace `f916e537cb88c3954d35c10613eb6f1c`

## Weak links found in the code
- `tools.ts:73` enrich_company calls company.enrich with no timeout
  - Blast radius (Entire Graph): createTools (function, targets/researchbot/tools.ts:70) ← 1 caller: runResearchBot (targets/researchbot/agent.ts:62)
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
Diagnosed from neatlogs trace f916e537cb88c3954d35c10613eb6f1c (3 spans, 3 detections; failing trial seed 3466302124 from the Judge's baseline).

## Attempts

### ✅ Attempt 1: Add per-call timeout to Crustdata transport calls so a slow enrich/search can't hang the run (`timeout-wrapped-transport-calls`, by claude-sonnet-5)
The static analysis correctly identifies the root cause: enrich_company (and search_people) call transport() with no timeout. When company.enrich takes 10s to respond, the awaited promise never resolves within the run's 5s budget, so the run hangs past the deadline instead of failing fast and falling back to "not found"/partial results. The retry/backoff logic already budgets wall-clock time correctly for 429/5xx, but it has no way to bound an individual call that simply never returns (or returns very late) — there's no race against a timeout.

The fix wraps every transport() call in a timeout that's capped by the remaining run budget (minus safety margin). If the call doesn't settle in time, it rejects with a distinguishable timeout error, which the existing isTransient-like handling treats as a soft failure: enrich_company returns {notFound:true, domain} and search_people returns whatever people it already collected. This keeps the run within the 5s wall-clock limit and guarantees the agent still produces a grounded brief or "not found" instead of hanging, without changing any business-rule semantics (no credits are over-charged, no invented people/data, retries for 429/5xx remain unaffected since a slow-but-eventually-erroring call will now time out instead of hanging the whole process).

Checkpoint before attempt: `ckpt-008`. Judge: **fixed**. 24/40 → 59/59 on fresh seeds (p=5.6e-8), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 31→35ms (+15%), p95 34→39ms (+16%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
The static analysis correctly identifies the root cause: enrich_company (and search_people) call transport() with no timeout. When company.enrich takes 10s to respond, the awaited promise never resolves within the run's 5s budget, so the run hangs past the deadline instead of failing fast and falling back to "not found"/partial results. The retry/backoff logic already budgets wall-clock time correctly for 429/5xx, but it has no way to bound an individual call that simply never returns (or returns very late) — there's no race against a timeout.

The fix wraps every transport() call in a timeout that's capped by the remaining run budget (minus safety margin). If the call doesn't settle in time, it rejects with a distinguishable timeout error, which the existing isTransient-like handling treats as a soft failure: enrich_company returns {notFound:true, domain} and search_people returns whatever people it already collected. This keeps the run within the 5s wall-clock limit and guarantees the agent still produces a grounded brief or "not found" instead of hanging, without changing any business-rule semantics (no credits are over-charged, no invented people/data, retries for 429/5xx remain unaffected since a slow-but-eventually-erroring call will now time out instead of hanging the whole process).

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 38a867b..6cb8362 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -92,14 +92,27 @@ export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise
 // short fixed backoff instead. Either way we never let a wait blow the run's 5s wall-clock
 // budget: if waiting would, we give up on this call and let the caller treat it as
 // "not found"/partial rather than crash.
+//
+// A slow backend (no error at all, just a very late response) is the same kind of risk: an
+// unbounded await can blow the wall-clock budget on its own even though nothing "failed". So
+// every transport() call is additionally raced against a timeout bounded by the time left in
+// the run, and a timeout is treated as transient exactly like a 429/5xx.
 
 const RUN_DEADLINE_MS = 5000;
 const DEFAULT_RATE_LIMIT_WAIT_MS = 2100; // just past the documented 2s reset window
 const SERVER_ERROR_RETRY_WAIT_MS = 150; // short fixed backoff for a transient 5xx
 const SAFETY_MARGIN_MS = 300; // leave room to parse, decide, and reply after the wait
+const MIN_CALL_TIMEOUT_MS = 50; // never race with a non-positive/instant timeout
 
 const runStartedAt = Date.now();
 
+class TimeoutError extends Error {
+  constructor() {
+    super('timed out waiting for response');
+    this.name = 'TimeoutError';
+  }
+}
+
 function remainingBudgetMs(): number {
   return RUN_DEADLINE_MS - (Date.now() - runStartedAt) - SAFETY_MARGIN_MS;
 }
@@ -118,12 +131,16 @@ function isServerError(err: unknown): boolean {
   return code >= 500 && code < 600;
 }
 
+function isTimeout(err: unknown): boolean {
+  return err instanceof TimeoutError;
+}
+
 function isTransient(err: unknown): boolean {
-  return isRateLimited(err) || isServerError(err);
+  return isRateLimited(err) || isServerError(err) || isTimeout(err);
 }
 
 function retryWaitMs(err: unknown): number {
-  if (isServerError(err)) return SERVER_ERROR_RETRY_WAIT_MS;
+  if (isServerError(err) || isTimeout(err)) return SERVER_ERROR_RETRY_WAIT_MS;
   const anyErr = err as { retryAfterMs?: number; headers?: Record<string, string> } | undefined;
   if (anyErr && typeof anyErr.retryAfterMs === 'number' && anyErr.retryAfterMs > 0) return anyErr.retryAfterMs;
   const resetHeader = anyErr?.headers?.['x-ratelimit-reset'] ?? anyErr?.headers?.['X-RateLimit-Reset'];
@@ -139,16 +156,51 @@ function sleep(ms: number): Promise<void> {
 }
 
 /**
- * Run a transient-fault-prone call once, retrying up to `maxRetries` times on a 429 or a 5xx
- * if (and only if) there's enough time left in the run's wall-clock budget to wait out the
- * backoff and still get a reply. Any other error, or a transient error with no budget left,
- * propagates.
+ * Race a call against the time left in the run's wall-clock budget, so a backend that never
+ * responds (or responds very late) can't hang the whole process past the deadline. Resolves/
+ * rejects like `fn()` normally would, or rejects with a TimeoutError if it doesn't settle in
+ * time. If there's effectively no budget left, fails fast with a TimeoutError instead of
+ * issuing a doomed call.
+ */
+function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
+  const budget = remainingBudgetMs();
+  const timeoutMs = Math.max(budget, MIN_CALL_TIMEOUT_MS);
+  return new Promise<T>((resolve, reject) => {
+    let settled = false;
+    const timer = setTimeout(() => {
+      if (settled) return;
+      settled = true;
+      reject(new TimeoutError());
+    }, timeoutMs);
+    fn().then(
+      (value) => {
+        if (settled) return;
+        settled = true;
+        clearTimeout(timer);
+        resolve(value);
+      },
+      (err) => {
+        if (settled) return;
+        settled = true;
+        clearTimeout(timer);
+        reject(err);
+      },
+    );
+  });
+}
+
+/**
+ * Run a transient-fault-prone call once, retrying up to `maxRetries` times on a 429, a 5xx, or
+ * a timeout if (and only if) there's enough time left in the run's wall-clock budget to wait
+ * out the backoff and still get a reply. Any other error, or a transient error with no budget
+ * left, propagates. Every attempt is itself bounded by the remaining budget so a hanging
+ * backend can never outlast the run's deadline.
  */
 async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
   let attempt = 0;
   while (true) {
     try {
-      return await fn();
+      return await withTimeout(fn);
     } catch (err) {
       if (!isTransient(err) || attempt >= maxRetries) throw err;
       const wait = retryWaitMs(err);
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 31→35ms (+15%), p95 34→39ms (+16%), steps 3.0→3.0 (+0.0), cost n/a.
Under crustdata-latency (informational, not budgeted): p50 129→123ms, avg steps 2.2→2.6.


## Proof the regression test guards the fix
With the fix removed: 24/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
