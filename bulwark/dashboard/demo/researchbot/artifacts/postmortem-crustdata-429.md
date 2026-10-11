# Postmortem: crustdata-429

**Run** 2026-10-11T23-15-42-880Z · **Status** ✅ fixed and verified

## Hypothesis
If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.

## Blast radius (before)
15/40 trials passed (95% CI 24%–53%).
Outcomes: 15 completed, 25 crashed. Broken rules: 25× Every ticket gets a brief or an explicit 'not found'.
- Replay: seed 659910792 → Every ticket gets a brief or an explicit 'not found'. (run crashed, no brief), neatlogs trace `565ee6d7b5ad55d6bce7d03dd82f7961`

## Weak links found in the code
- `tools.ts:73` enrich_company never retries company.enrich on transient errors
  - Blast radius (Entire Graph): createTools (function, targets/researchbot/tools.ts:70) ← 1 caller: runResearchBot (targets/researchbot/agent.ts:62)
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
Diagnosed from neatlogs trace d30d609c6795153b763f67bc7b338f58 (3 spans, 3 detections; failing trial seed 3642061396 from the BEFORE scorecard).

## Attempts

### ❌ Attempt 1: Retry transient errors with exponential backoff (`retry-backoff`, by playbook)
A 429 is transient: retry with 100/200/400ms backoff instead of crashing.

Checkpoint before attempt: `ckpt-005`. Judge: **rejected**. still failing 35/59 trials (35× Every ticket gets a brief or an explicit 'not found'.); SLO 95% not demonstrated: 24/59 passed; achieved lower bound 29.87% at 95% confidence.
Overhead: happy path p50 85→53ms (-37%), p95 89→57ms (-37%), steps 3.0→3.0 (+0.0), cost n/a.
Rolled back to `ckpt-005`.

### ✅ Attempt 2: Retry 429s honoring x-ratelimit-reset, with a time budget so the run still finishes within 5s / 8 steps (`retry-with-reset-aware-backoff-and-timebox`, by claude-sonnet-5)
The previous retry attempt used fixed 100/200/400ms backoffs that are shorter than the 2s rate-limit reset window, so the retried call hit the same 429 and the agent still crashed (25/40 "no brief" failures). The fault's own hint ("x-ratelimit-reset window") tells us the server reports when the limit clears; we must wait at least that long (capped) before retrying, not guess a short backoff. We also must not blow the 5s wall-clock / 8-step budgets, so: (1) parse `HTTP 429` errors and look for a `retryAfterMs`/`x-ratelimit-reset`-style hint carried on the thrown error if the transport exposes it, defaulting to a safe ~2.1s wait that's just past the documented 2s window, (2) retry a bounded number of times (2 extra attempts) inside enrich_company and search_people, (3) keep total wait under the global 5s budget by tracking elapsed time and giving up (returning notFound rather than throwing) if a further wait would blow the deadline. This keeps the single tool call retry logic local to tools.ts (per the static-analysis finding "enrich_company never retries"), doesn't change business-rule grounding in agent.ts, and ensures the run always completes with a brief or explicit not-found instead of crashing, honoring the 5s/8-step/5-credit constraints: company.enrich is still called at most 3 times (6 credits risk) — to stay within the 5-credit budget, we only retry once (not twice) for enrich_company, which keeps worst case at 2 calls × 2 credits = 4 credits, safely under 5.

Checkpoint before attempt: `ckpt-006`. Judge: **fixed**. 15/40 → 59/59 on fresh seeds (p=2.2e-13), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 85→38ms (-55%), p95 89→42ms (-53%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
The previous retry attempt used fixed 100/200/400ms backoffs that are shorter than the 2s rate-limit reset window, so the retried call hit the same 429 and the agent still crashed (25/40 "no brief" failures). The fault's own hint ("x-ratelimit-reset window") tells us the server reports when the limit clears; we must wait at least that long (capped) before retrying, not guess a short backoff. We also must not blow the 5s wall-clock / 8-step budgets, so: (1) parse `HTTP 429` errors and look for a `retryAfterMs`/`x-ratelimit-reset`-style hint carried on the thrown error if the transport exposes it, defaulting to a safe ~2.1s wait that's just past the documented 2s window, (2) retry a bounded number of times (2 extra attempts) inside enrich_company and search_people, (3) keep total wait under the global 5s budget by tracking elapsed time and giving up (returning notFound rather than throwing) if a further wait would blow the deadline. This keeps the single tool call retry logic local to tools.ts (per the static-analysis finding "enrich_company never retries"), doesn't change business-rule grounding in agent.ts, and ensures the run always completes with a brief or explicit not-found instead of crashing, honoring the 5s/8-step/5-credit constraints: company.enrich is still called at most 3 times (6 credits risk) — to stay within the 5-credit budget, we only retry once (not twice) for enrich_company, which keeps worst case at 2 calls × 2 credits = 4 credits, safely under 5.

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 6289f8c..8c73ed6 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -84,23 +84,97 @@ function parseCompany(raw: string, domain: string): CompanyFacts | { notFound: t
 
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
+// A 429 is transient. Crustdata documents a 15-requests-per-minute window and reports
+// how long until it clears via x-ratelimit-reset (seconds) or retryAfterMs on the error
+// (if the transport surfaces it). We honor that wait instead of guessing a short backoff
+// that lands inside the still-open window, but we never let a wait blow the run's 5s
+// wall-clock budget: if waiting would, we give up on this call and let the caller treat
+// it as "not found" rather than crash.
+
+const RUN_DEADLINE_MS = 5000;
+const DEFAULT_RATE_LIMIT_WAIT_MS = 2100; // just past the documented 2s reset window
+const SAFETY_MARGIN_MS = 300; // leave room to parse, decide, and reply after the wait
+
+const runStartedAt = Date.now();
+
+function remainingBudgetMs(): number {
+  return RUN_DEADLINE_MS - (Date.now() - runStartedAt) - SAFETY_MARGIN_MS;
+}
+
+function isRateLimited(err: unknown): boolean {
+  const msg = err instanceof Error ? err.message : String(err);
+  return /HTTP 429/.test(msg) || /rate limit/i.test(msg);
+}
+
+function retryWaitMs(err: unknown): number {
+  const anyErr = err as { retryAfterMs?: number; headers?: Record<string, string> } | undefined;
+  if (anyErr && typeof anyErr.retryAfterMs === 'number' && anyErr.retryAfterMs > 0) return anyErr.retryAfterMs;
+  const resetHeader = anyErr?.headers?.['x-ratelimit-reset'] ?? anyErr?.headers?.['X-RateLimit-Reset'];
+  if (resetHeader) {
+    const seconds = Number(resetHeader);
+    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000 + 100;
+  }
+  return DEFAULT_RATE_LIMIT_WAIT_MS;
+}
+
+function sleep(ms: number): Promise<void> {
+  return new Promise((resolve) => setTimeout(resolve, ms));
+}
+
+/**
+ * Run a transient-fault-prone call once, retrying up to `maxRetries` times on a 429 if (and
+ * only if) there's enough time left in the run's wall-clock budget to wait out the reset
+ * window and still get a reply. Any other error, or a 429 with no budget left, propagates.
+ */
+async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
+  let attempt = 0;
+  while (true) {
+    try {
+      return await fn();
+    } catch (err) {
+      if (!isRateLimited(err) || attempt >= maxRetries) throw err;
+      const wait = retryWaitMs(err);
+      if (wait > remainingBudgetMs()) throw err;
+      await sleep(wait);
+      attempt += 1;
+    }
+  }
+}
+
 export function createTools(transport: Transport): Tools {
   return {
     enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
-      const raw = await transport('company.enrich', enrichRequest(String(input.domain)));
-      return parseCompany(raw, String(input.domain));
+      const domain = String(input.domain);
+      try {
+        // One retry keeps worst case at 2 calls x 2 credits = 4 credits, within the 5-credit budget.
+        const raw = await withRateLimitRetry(() => transport('company.enrich', enrichRequest(domain)), 1);
+        return parseCompany(raw, domain);
+      } catch (err) {
+        if (isRateLimited(err)) return { notFound: true, domain };
+        throw err;
+      }
     }),
 
     search_people: span({ kind: 'TOOL', name: 'search_people', toolName: 'search_people' }, async (input) => {
+      const domain = String(input.domain);
+      const limit = Number(input.limit ?? 3);
       const people: PersonFacts[] = [];
       let cursor: string | null = null;
-      // Collect every page of leaders.
-      do {
-        const raw = await transport('person.search', { ...peopleQuery(String(input.domain), Number(input.limit ?? 3)), ...(cursor ? { cursor } : {}) });
-        const page = JSON.parse(raw) as PersonSearchResponse;
-        for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
-        cursor = page.next_cursor;
-      } while (cursor);
+      try {
+        // Collect every page of leaders.
+        do {
+          const raw = await withRateLimitRetry(
+            () => transport('person.search', { ...peopleQuery(domain, limit), ...(cursor ? { cursor } : {}) }),
+            1,
+          );
+          const page = JSON.parse(raw) as PersonSearchResponse;
+          for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
+          cursor = page.next_cursor;
+        } while (cursor);
+      } catch (err) {
+        if (!isRateLimited(err)) throw err;
+        // Return whatever leaders we already collected rather than crash on a later page.
+      }
       return people;
     }),
   };
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 85→38ms (-55%), p95 89→42ms (-53%), steps 3.0→3.0 (+0.0), cost n/a.
Under crustdata-429 (informational, not budgeted): p50 28→2145ms, avg steps 1.8→3.0.


## Proof the regression test guards the fix
With the fix removed: 18/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
