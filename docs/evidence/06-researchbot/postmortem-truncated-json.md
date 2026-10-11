# Postmortem: truncated-json

**Run** 2026-10-11T07-42-15-350Z · **Status** ✅ fixed and verified

## Hypothesis
If a /person/search response is truncated, ResearchBot crashes because it parses the body without validating or retrying.

## Blast radius (before)
23/40 trials passed (95% CI 42%–71%).
Outcomes: 23 completed, 17 crashed. Broken rules: 17× Every ticket gets a brief or an explicit 'not found'.
- Replay: seed 2936708545 → Every ticket gets a brief or an explicit 'not found'. (run crashed, no brief)

## Weak links found in the code
- `tools.ts:89` search_people trusts the JSON from person.search without validating it
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
neatlogs read-back unavailable (NEATLOGS_API_KEY not set); used local evidence.

## Attempts

### ✅ Attempt 1: Validate the body, then retry (`valid-json+retry`, by playbook)
A cut-off body arrives as a successful call and only fails when parsed, so a plain retry never sees it. Check the body parses at the transport, which turns it into a retryable failure.

Checkpoint before attempt: `ckpt-006`. Judge: **fixed**. 23/40 → 40/40 on fresh seeds (p=8.7e-7), no regressions.
Overhead: happy path p50 28→39ms (+39%), p95 30→41ms (+36%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
A cut-off body arrives as a successful call and only fails when parsed, so a plain retry never sees it. Check the body parses at the transport, which turns it into a retryable failure.

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 7e8a9cd..7035bf5 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -123,9 +123,19 @@ function withTimeout(transport: Transport, ms: number): Transport {
     });
 }
 
+// bulwark:valid-json: a cut-off body is a failed call (retried), not something to parse
+function requireJson(transport: Transport): Transport {
+  return async (endpoint, payload) => {
+    const raw = await transport(endpoint, payload);
+    JSON.parse(raw);
+    return raw;
+  };
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport): Tools {
+  transport = requireJson(transport);
   transport = withTimeout(transport, CALL_TIMEOUT_MS);
   transport = withRetry(transport);
   return {
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 28→39ms (+39%), p95 30→41ms (+36%), steps 3.0→3.0 (+0.0), cost n/a.
Under truncated-json (informational, not budgeted): p50 95→129ms, avg steps 2.6→3.0.


## Proof the regression test guards the fix
With the fix removed: 17/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
