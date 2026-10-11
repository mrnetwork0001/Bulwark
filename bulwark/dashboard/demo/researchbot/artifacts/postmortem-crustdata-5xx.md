# Postmortem: crustdata-5xx

**Run** 2026-10-11T23-15-42-880Z · **Status** ✅ fixed and verified

## Hypothesis
If /person/search has a transient 500, ResearchBot crashes because search_people never retries.

## Blast radius (before)
20/40 trials passed (95% CI 35%–65%).
Outcomes: 20 completed, 20 crashed. Broken rules: 20× Every ticket gets a brief or an explicit 'not found'.
- Replay: seed 3342513742 → Every ticket gets a brief or an explicit 'not found'. (run crashed, no brief), neatlogs trace `7c4d684798d9fcb16d18c6de7b1c0eee`

## Weak links found in the code
- `tools.ts:89` search_people never retries person.search when the server fails (5xx)
  - Blast radius (Entire Graph): createTools (function, targets/researchbot/tools.ts:70) ← 1 caller: runResearchBot (targets/researchbot/agent.ts:62)
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
neatlogs trace 7c4d684798d9fcb16d18c6de7b1c0eee finalized only after Blue ran (4 spans, 3 detections; failing trial seed 3342513742 from the Judge's baseline); Blue used local evidence.

## Attempts

### ✅ Attempt 1: Retry transient 5xx errors in search_people (and enrich_company) like 429s (`retry-on-5xx-like-429`, by claude-sonnet-5)
tools.ts only retries 429 rate-limit errors. A transient 500 from /person/search (and potentially /company/enrich) is thrown straight through withRateLimitRetry's isRateLimited check, which returns false for 5xx, so the error propagates and crashes the run (20/20 crashed trials, "run crashed, no brief"). The fix generalizes the transient-error detection to also recognize 5xx server errors (HTTP 500-599) and retries them with a short fixed backoff (not the rate-limit reset wait, since there's no reset header for a 500), still respecting the overall wall-clock budget. On exhausting retries for a 5xx, enrich_company treats it as "not found" and search_people returns whatever people were already collected, exactly like the existing 429 handling, so the run always completes with a grounded brief or explicit not-found instead of crashing.

Checkpoint before attempt: `ckpt-007`. Judge: **fixed**. 20/40 → 59/59 on fresh seeds (p=3.2e-10), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 38→31ms (-19%), p95 42→34ms (-19%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
tools.ts only retries 429 rate-limit errors. A transient 500 from /person/search (and potentially /company/enrich) is thrown straight through withRateLimitRetry's isRateLimited check, which returns false for 5xx, so the error propagates and crashes the run (20/20 crashed trials, "run crashed, no brief"). The fix generalizes the transient-error detection to also recognize 5xx server errors (HTTP 500-599) and retries them with a short fixed backoff (not the rate-limit reset wait, since there's no reset header for a 500), still respecting the overall wall-clock budget. On exhausting retries for a 5xx, enrich_company treats it as "not found" and search_people returns whatever people were already collected, exactly like the existing 429 handling, so the run always completes with a grounded brief or explicit not-found instead of crashing.

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 8c73ed6..38a867b 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -84,15 +84,18 @@ function parseCompany(raw: string, domain: string): CompanyFacts | { notFound: t
 
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
-// A 429 is transient. Crustdata documents a 15-requests-per-minute window and reports
-// how long until it clears via x-ratelimit-reset (seconds) or retryAfterMs on the error
-// (if the transport surfaces it). We honor that wait instead of guessing a short backoff
-// that lands inside the still-open window, but we never let a wait blow the run's 5s
-// wall-clock budget: if waiting would, we give up on this call and let the caller treat
-// it as "not found" rather than crash.
+// A 429 is transient, and so is a 5xx (a bad gateway, a dropped backend, a one-off server
+// error). Crustdata documents a 15-requests-per-minute window for 429s and reports how long
+// until it clears via x-ratelimit-reset (seconds) or retryAfterMs on the error (if the
+// transport surfaces it). We honor that wait instead of guessing a short backoff that lands
+// inside the still-open window. A 5xx carries no such reset signal, so we retry it after a
+// short fixed backoff instead. Either way we never let a wait blow the run's 5s wall-clock
+// budget: if waiting would, we give up on this call and let the caller treat it as
+// "not found"/partial rather than crash.
 
 const RUN_DEADLINE_MS = 5000;
 const DEFAULT_RATE_LIMIT_WAIT_MS = 2100; // just past the documented 2s reset window
+const SERVER_ERROR_RETRY_WAIT_MS = 150; // short fixed backoff for a transient 5xx
 const SAFETY_MARGIN_MS = 300; // leave room to parse, decide, and reply after the wait
 
 const runStartedAt = Date.now();
@@ -106,7 +109,21 @@ function isRateLimited(err: unknown): boolean {
   return /HTTP 429/.test(msg) || /rate limit/i.test(msg);
 }
 
+function isServerError(err: unknown): boolean {
+  const msg = err instanceof Error ? err.message : String(err);
+  if (/rate limit/i.test(msg)) return false;
+  const match = /HTTP (\d{3})/.exec(msg);
+  if (!match) return false;
+  const code = Number(match[1]);
+  return code >= 500 && code < 600;
+}
+
+function isTransient(err: unknown): boolean {
+  return isRateLimited(err) || isServerError(err);
+}
+
 function retryWaitMs(err: unknown): number {
+  if (isServerError(err)) return SERVER_ERROR_RETRY_WAIT_MS;
   const anyErr = err as { retryAfterMs?: number; headers?: Record<string, string> } | undefined;
   if (anyErr && typeof anyErr.retryAfterMs === 'number' && anyErr.retryAfterMs > 0) return anyErr.retryAfterMs;
   const resetHeader = anyErr?.headers?.['x-ratelimit-reset'] ?? anyErr?.headers?.['X-RateLimit-Reset'];
@@ -122,9 +139,10 @@ function sleep(ms: number): Promise<void> {
 }
 
 /**
- * Run a transient-fault-prone call once, retrying up to `maxRetries` times on a 429 if (and
- * only if) there's enough time left in the run's wall-clock budget to wait out the reset
- * window and still get a reply. Any other error, or a 429 with no budget left, propagates.
+ * Run a transient-fault-prone call once, retrying up to `maxRetries` times on a 429 or a 5xx
+ * if (and only if) there's enough time left in the run's wall-clock budget to wait out the
+ * backoff and still get a reply. Any other error, or a transient error with no budget left,
+ * propagates.
  */
 async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
   let attempt = 0;
@@ -132,7 +150,7 @@ async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries: number):
     try {
       return await fn();
     } catch (err) {
-      if (!isRateLimited(err) || attempt >= maxRetries) throw err;
+      if (!isTransient(err) || attempt >= maxRetries) throw err;
       const wait = retryWaitMs(err);
       if (wait > remainingBudgetMs()) throw err;
       await sleep(wait);
@@ -150,7 +168,7 @@ export function createTools(transport: Transport): Tools {
         const raw = await withRateLimitRetry(() => transport('company.enrich', enrichRequest(domain)), 1);
         return parseCompany(raw, domain);
       } catch (err) {
-        if (isRateLimited(err)) return { notFound: true, domain };
+        if (isTransient(err)) return { notFound: true, domain };
         throw err;
       }
     }),
@@ -172,7 +190,7 @@ export function createTools(transport: Transport): Tools {
           cursor = page.next_cursor;
         } while (cursor);
       } catch (err) {
-        if (!isRateLimited(err)) throw err;
+        if (!isTransient(err)) throw err;
         // Return whatever leaders we already collected rather than crash on a later page.
       }
       return people;
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 38→31ms (-19%), p95 42→34ms (-19%), steps 3.0→3.0 (+0.0), cost n/a.
Under crustdata-5xx (informational, not budgeted): p50 46→183ms, avg steps 2.5→3.0.


## Proof the regression test guards the fix
With the fix removed: 23/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
