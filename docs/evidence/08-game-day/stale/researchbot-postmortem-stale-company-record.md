# Postmortem: stale-company-record

**Run** 2026-10-11T16-52-19-277Z · **Status** ✅ fixed and verified

## Hypothesis
If a stale-while-revalidate cache in front of /company/enrich serves a 2024 snapshot (old last_updated, old headcount), ResearchBot reports the old headcount as current, because it never checks how fresh the record is.

## Blast radius (before)
20/40 trials passed (95% CI 35%–65%).
Outcomes: 40 completed. Broken rules: 20× Every brief cites only data returned by the API.
- Replay: seed 2175808574 → Every brief cites only data returned by the API. (headcount 250 is not in any API response (API returned [416]))

## What neatlogs recorded
neatlogs read-back unavailable (neatlogs read-back disabled (wait 0)); used local evidence.

## Attempts

### ❌ Attempt 1: Ground the brief in tool results (`ground-brief`, by playbook)
The brief may only state what a tool returned.

Checkpoint before attempt: `ckpt-001`. Judge: **rejected**. still failing 20/40 trials (20× Every brief cites only data returned by the API.).
Overhead: happy path p50 28→30ms (+7%), p95 31→33ms (+7%), steps 3.0→3.0 (+0.0), cost n/a.
Rolled back to `ckpt-001`.

### ✅ Attempt 2: Check the record is fresh (`fresh-record`, by playbook)
Grounding can't help when the tool itself returned a 2024 snapshot. Check the record's last_updated; if it is older than 180 days, fetch it again (the cache revalidates), and if it is still stale, drop the headcount rather than state an old one as current.

Checkpoint before attempt: `ckpt-002`. Judge: **fixed**. 20/40 → 40/40 on fresh seeds (p=3.9e-8), no regressions.
Overhead: happy path p50 28→66ms (+139%), p95 31→80ms (+157%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
Grounding can't help when the tool itself returned a 2024 snapshot. Check the record's last_updated; if it is older than 180 days, fetch it again (the cache revalidates), and if it is still stale, drop the headcount rather than state an old one as current.

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 7f84d43..8559134 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -65,9 +65,39 @@ export function peopleQuery(domain: string, limit: number): Record<string, unkno
   };
 }
 
+const MAX_RECORD_AGE_DAYS = 180;
+
+// bulwark:fresh-record: a company record last updated more than MAX_RECORD_AGE_DAYS ago came from a stale
+// cache. Fetch it again (the cache revalidates); if it is still stale, drop the headcount it can't vouch for.
+function requireFresh(transport: Transport): Transport {
+  const stale = (raw: string) => {
+    try {
+      const body = JSON.parse(raw) as EnrichResponse;
+      return (Array.isArray(body) ? body : []).some((e) =>
+        (e?.matches ?? []).some((m) => {
+          const updated = Date.parse(String((m?.company_data as { last_updated?: string } | undefined)?.last_updated ?? ''));
+          return Number.isFinite(updated) && Date.now() - updated > MAX_RECORD_AGE_DAYS * 86_400_000;
+        }),
+      );
+    } catch {
+      return false;
+    }
+  };
+  return async (endpoint, payload) => {
+    let raw = await transport(endpoint, payload);
+    if (endpoint !== 'company.enrich' || !stale(raw)) return raw;
+    raw = await transport(endpoint, payload);
+    if (!stale(raw)) return raw;
+    const body = JSON.parse(raw) as EnrichResponse;
+    for (const e of body) for (const m of e.matches ?? []) if (m.company_data) delete m.company_data.headcount;
+    return JSON.stringify(body);
+  };
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport): Tools {
+  transport = requireFresh(transport);
   return {
     enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
       const raw = await transport('company.enrich', enrichRequest(String(input.domain)));
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 28→66ms (+139%), p95 31→80ms (+157%), steps 3.0→3.0 (+0.0), cost n/a.
Under stale-company-record (informational, not budgeted): p50 195→435ms, avg steps 3.0→3.0.


## Proof the regression test guards the fix
With the fix removed: 17/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
