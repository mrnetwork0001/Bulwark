# Postmortem: crustdata-429

**Run** 2026-10-11T07-42-15-350Z · **Status** ✅ fixed and verified

## Hypothesis
If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.

## Blast radius (before)
15/40 trials passed (95% CI 24%–53%).
Outcomes: 15 completed, 25 crashed. Broken rules: 25× Every ticket gets a brief or an explicit 'not found'.
- Replay: seed 710243649 → Every ticket gets a brief or an explicit 'not found'. (run crashed, no brief)

## Weak links found in the code
- `tools.ts:73` enrich_company never retries company.enrich on transient errors
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
neatlogs read-back unavailable (NEATLOGS_API_KEY not set); used local evidence.

## Attempts

### ❌ Attempt 1: Retry transient errors with exponential backoff (`retry-backoff`, by playbook)
A 429 is transient: retry with 100/200/400ms backoff instead of crashing.

Checkpoint before attempt: `ckpt-003`. Judge: **rejected**. still failing 25/40 trials (25× Every ticket gets a brief or an explicit 'not found'.).
Overhead: happy path p50 26→24ms (-11%), p95 29→26ms (-10%), steps 3.0→3.0 (+0.0), cost n/a.
Rolled back to `ckpt-003`.

### ✅ Attempt 2: Retry, honouring the rate-limit reset header (`retry-after`, by playbook)
Retrying inside the rate-limit window just collects more 429s. Crustdata says when capacity frees up (x-ratelimit-reset, like Retry-After); wait that long, then retry.

Checkpoint before attempt: `ckpt-004`. Judge: **fixed**. 15/40 → 40/40 on fresh seeds (p=1.1e-10), no regressions.
Overhead: happy path p50 26→29ms (+8%), p95 29→31ms (+9%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
Retrying inside the rate-limit window just collects more 429s. Crustdata says when capacity frees up (x-ratelimit-reset, like Retry-After); wait that long, then retry.

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 6289f8c..eb1bc08 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -82,9 +82,37 @@ function parseCompany(raw: string, domain: string): CompanyFacts | { notFound: t
   };
 }
 
+const CALL_ATTEMPTS = 4;
+
+// bulwark:retry-transient: 429s, 5xx, timeouts and unreadable bodies are retried; other 4xx are not
+function withRetry(transport: Transport): Transport {
+  return async (endpoint, payload) => {
+    let lastErr: unknown;
+    for (let i = 0; i < CALL_ATTEMPTS; i++) {
+      try {
+        return await transport(endpoint, payload);
+      } catch (err) {
+        lastErr = err;
+        const status = (err as { status?: number }).status;
+        if (status !== undefined && status !== 429 && status < 500) throw err;
+        if (i < CALL_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, retryDelayMs(err, i)));
+      }
+    }
+    throw lastErr;
+  };
+}
+
+function retryDelayMs(err: unknown, attempt: number): number {
+  // bulwark:rate-limit-reset: a 429 says when capacity frees up (x-ratelimit-reset / Retry-After, in seconds); wait that long
+  const headers = (err as { headers?: Record<string, string> }).headers ?? {};
+  const reset = Number(headers['x-ratelimit-reset'] ?? headers['retry-after']);
+  return Number.isFinite(reset) && reset > 0 ? reset * 1000 + 50 : 100 * 2 ** attempt;
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport): Tools {
+  transport = withRetry(transport);
   return {
     enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
       const raw = await transport('company.enrich', enrichRequest(String(input.domain)));
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 26→29ms (+8%), p95 29→31ms (+9%), steps 3.0→3.0 (+0.0), cost n/a.
Under crustdata-429 (informational, not budgeted): p50 13→2087ms, avg steps 1.8→3.0.


## Proof the regression test guards the fix
With the fix removed: 18/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
