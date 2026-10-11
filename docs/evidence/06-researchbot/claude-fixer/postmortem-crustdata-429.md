# Postmortem: crustdata-429

**Run** 2026-10-11T07-39-53-333Z · **Status** ✅ fixed and verified

## Hypothesis
If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.

## Blast radius (before)
7/20 trials passed (95% CI 18%–57%).
Outcomes: 7 completed, 13 crashed. Broken rules: 13× Every ticket gets a brief or an explicit 'not found'.
- Replay: seed 710243649 → Every ticket gets a brief or an explicit 'not found'. (run crashed, no brief)

## Weak links found in the code
- `tools.ts:73` enrich_company never retries company.enrich on transient errors
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
neatlogs read-back unavailable (NEATLOGS_API_KEY not set); used local evidence.

## Attempts

### ✅ Attempt 1: Retry enrich_company (and search_people) on 429 rate-limit using x-ratelimit-reset, with time/step budget safety (`retry-with-backoff-on-429`, by claude-sonnet-5)

Root cause: enrich_company (and search_people) call `transport()` once and never handle a 429 rate-limit response. Crustdata's company.enrich endpoint is limited to 15 RPM; when it returns 429 with an `x-ratelimit-reset` window (observed ~2s), the unhandled error propagates up and crashes the run before any brief is produced, violating "Every ticket gets a brief or an explicit 'not found'."

Fix: add a small retry helper in tools.ts that:
- Detects a 429/rate-limit error from the transport (by inspecting the thrown error's message/status/retryAfter-like fields, defensively, since the transport shape isn't fully known here).
- Waits for the reset window indicated by the error (falling back to a short fixed backoff) before retrying, capped at a small number of attempts so we never blow the 8-step / 5s budgets.
- Re-throws if retries are exhausted or the error isn't a rate-limit error, so genuine failures still surface (no silent brief invention — all cited data still comes straight from the parsed API response).

This keeps the "one step per tool call" contract intact (retries happen inside the single `enrich_company`/`search_people` tool call, not as extra brain.decide steps), so the step-cap rule is unaffected, and the wait is bounded well under the 5s wall-clock budget (two retries x ~2s reset window ≈ 4s worst case, but typically immediate on success). No new Crustdata calls are added beyond what's needed to get a successful response, so credit usage per brief is unchanged (same calls as before, just retried on failure instead of crashing).


Checkpoint before attempt: `ckpt-001`. Judge: **fixed**. 7/20 → 20/20 on fresh seeds (p=6.4e-6), no regressions.
Overhead: happy path p50 19→18ms (-5%), p95 21→21ms (0%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix

Root cause: enrich_company (and search_people) call `transport()` once and never handle a 429 rate-limit response. Crustdata's company.enrich endpoint is limited to 15 RPM; when it returns 429 with an `x-ratelimit-reset` window (observed ~2s), the unhandled error propagates up and crashes the run before any brief is produced, violating "Every ticket gets a brief or an explicit 'not found'."

Fix: add a small retry helper in tools.ts that:
- Detects a 429/rate-limit error from the transport (by inspecting the thrown error's message/status/retryAfter-like fields, defensively, since the transport shape isn't fully known here).
- Waits for the reset window indicated by the error (falling back to a short fixed backoff) before retrying, capped at a small number of attempts so we never blow the 8-step / 5s budgets.
- Re-throws if retries are exhausted or the error isn't a rate-limit error, so genuine failures still surface (no silent brief invention — all cited data still comes straight from the parsed API response).

This keeps the "one step per tool call" contract intact (retries happen inside the single `enrich_company`/`search_people` tool call, not as extra brain.decide steps), so the step-cap rule is unaffected, and the wait is bounded well under the 5s wall-clock budget (two retries x ~2s reset window ≈ 4s worst case, but typically immediate on success). No new Crustdata calls are added beyond what's needed to get a successful response, so credit usage per brief is unchanged (same calls as before, just retried on failure instead of crashing).


```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 7f84d43..8318272 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -67,10 +67,75 @@ export function peopleQuery(domain: string, limit: number): Record<string, unkno
 
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
+/** Max extra attempts after the first try, for a rate-limited call. Kept small so we stay well inside the step/time budgets. */
+const MAX_RATE_LIMIT_RETRIES = 2;
+/** Fallback wait (ms) if we can't read a reset window off the error. */
+const DEFAULT_RATE_LIMIT_WAIT_MS = 2000;
+/** Never wait longer than this per retry, however the server phrases the reset window. */
+const MAX_RATE_LIMIT_WAIT_MS = 2500;
+
+function sleep(ms: number): Promise<void> {
+  return new Promise((resolve) => setTimeout(resolve, ms));
+}
+
+/** Best-effort read of a rate-limit status code off an unknown thrown value. */
+function statusOf(err: unknown): number | undefined {
+  if (err && typeof err === 'object') {
+    const e = err as Record<string, unknown>;
+    const candidates = [e.status, e.statusCode, e.code];
+    for (const c of candidates) {
+      if (typeof c === 'number') return c;
+      if (typeof c === 'string' && /^\d+$/.test(c)) return Number(c);
+    }
+  }
+  return undefined;
+}
+
+/** Best-effort read of the reset window (ms) off an unknown thrown value, from common header/field shapes. */
+function resetWaitMsOf(err: unknown): number | undefined {
+  if (!err || typeof err !== 'object') return undefined;
+  const e = err as Record<string, unknown>;
+  const headers = (e.headers ?? e.responseHeaders) as Record<string, unknown> | undefined;
+  const rawReset =
+    e['x-ratelimit-reset'] ??
+    e.retryAfter ??
+    e.retry_after ??
+    (headers ? headers['x-ratelimit-reset'] ?? headers['retry-after'] : undefined);
+  if (rawReset === undefined) return undefined;
+  const n = typeof rawReset === 'string' ? Number(rawReset) : rawReset;
+  if (typeof n !== 'number' || Number.isNaN(n)) return undefined;
+  // Reset windows for this API are observed in seconds (e.g. 2s); treat small
+  // integers as seconds, larger ones as already-milliseconds.
+  const ms = n <= 60 ? n * 1000 : n;
+  return Math.min(ms, MAX_RATE_LIMIT_WAIT_MS);
+}
+
+function isRateLimitError(err: unknown): boolean {
+  if (statusOf(err) === 429) return true;
+  const message = err instanceof Error ? err.message : String(err);
+  return /\b429\b|rate.?limit/i.test(message);
+}
+
+/** Runs fn(), retrying on 429s by waiting out the reported (or default) reset window. */
+async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
+  let lastErr: unknown;
+  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
+    try {
+      return await fn();
+    } catch (err) {
+      lastErr = err;
+      if (!isRateLimitError(err) || attempt === MAX_RATE_LIMIT_RETRIES) throw err;
+      await sleep(resetWaitMsOf(err) ?? DEFAULT_RATE_LIMIT_WAIT_MS);
+    }
+  }
+  // Unreachable, but keeps TS happy.
+  throw lastErr;
+}
+
 export function createTools(transport: Transport): Tools {
   return {
     enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
-      const raw = await transport('company.enrich', enrichRequest(String(input.domain)));
+      const raw = await withRateLimitRetry(() => transport('company.enrich', enrichRequest(String(input.domain))));
       const company = (JSON.parse(raw) as EnrichResponse)[0].matches[0].company_data;
       return {
         name: company.basic_info!.name,
@@ -86,7 +151,9 @@ export function createTools(transport: Transport): Tools {
       let cursor: string | null = null;
       // Collect every page of leaders.
       do {
-        const raw = await transport('person.search', { ...peopleQuery(String(input.domain), Number(input.limit ?? 3)), ...(cursor ? { cursor } : {}) });
+        const raw = await withRateLimitRetry(() =>
+          transport('person.search', { ...peopleQuery(String(input.domain), Number(input.limit ?? 3)), ...(cursor ? { cursor } : {}) }),
+        );
         const page = JSON.parse(raw) as PersonSearchResponse;
         for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
         cursor = page.next_cursor;
```

## Overhead
Compared with the unpatched code on the no-fault baseline (20 runs): happy path p50 19→18ms (-5%), p95 21→21ms (0%), steps 3.0→3.0 (+0.0), cost n/a.
Under crustdata-429 (informational, not budgeted): p50 8→2038ms, avg steps 1.7→3.0.


## Proof the regression test guards the fix
With the fix removed: 9/20 passed. With the fix: 20/20 passed. ✅ The test catches the bug.
