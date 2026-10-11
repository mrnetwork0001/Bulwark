# Postmortem: latency-spike

**Run** 2026-10-11T23-39-54-112Z · **Status** ✅ fixed and verified

## Hypothesis
If the orders API slows to 10s, RefundBot hangs because lookup_order has no timeout.

## Blast radius (before)
23/40 trials passed (95% CI 42%–71%).
Outcomes: 23 completed, 17 hung. Broken rules: 17× Every ticket gets a reply to the customer.; 17× A run finishes within 5 seconds.
- Replay: seed 290047738 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run hung, 0 emails total)), neatlogs trace `c708a34d1374f58c44c42bcf9c72c306`
- Replay: seed 290047738 → A run finishes within 5 seconds. (took 5002ms (limit 5000ms)), neatlogs trace `c708a34d1374f58c44c42bcf9c72c306`

## Weak links found in the code
- `tools.ts:79` lookup_order calls orders.get with no timeout
  - Blast radius (Entire Graph): createTools (function, targets/refundbot/tools.ts:76) ← 1 caller: runRefundBot (targets/refundbot/agent.ts:54)
  - Provenance: introduced in `cf0ceac`, 2026-10-10 by Claude Code session `8cdad8b4`, prompt "start building something for this app" (Entire checkpoint `01M4JHF2GWEP2029BVPZ8A9WQ1`, matched in the imported transcript; the commit predates Entire trailers)

## What neatlogs recorded
Diagnosed from neatlogs trace 25bfce4e89cbaab5c13f9d2a545c22c7 (3 spans, 3 detections; failing trial seed 2657296630 from the BEFORE scorecard).

## Attempts

### ✅ Attempt 1: Timeout + retry on order lookup (`harden-lookup`, by playbook)
Bound each lookup to 1s and retry up to 3 times so one slow response cannot hang the run.

Checkpoint before attempt: `ckpt-007`. Judge: **fixed**. 23/40 → 59/59 on fresh seeds (p=1.6e-8), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 13→11ms (-12%), p95 15→14ms (-9%), steps 5.0→5.0 (+0.0), cost n/a.


## Root cause and fix
Bound each lookup to 1s and retry up to 3 times so one slow response cannot hang the run.

```diff
diff --git a/targets/refundbot/tools.ts b/targets/refundbot/tools.ts
index 7b80618..4909923 100644
--- a/targets/refundbot/tools.ts
+++ b/targets/refundbot/tools.ts
@@ -71,13 +71,27 @@ async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T>
   throw lastErr;
 }
 
+const LOOKUP_TIMEOUT_MS = 1000;
+const LOOKUP_ATTEMPTS = 3;
+
+function parseOrder(raw: string): Order {
+  const order = JSON.parse(raw) as Order;
+  if (typeof order?.id !== 'string' || typeof order.total !== 'number' || typeof order.status !== 'string') {
+    throw new Error('invalid order payload');
+  }
+  return order;
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport, ticket?: { customerEmail: string }): Tools {
   return {
     lookup_order: span({ kind: 'TOOL', name: 'lookup_order', toolName: 'lookup_order' }, async (input) => {
-      const raw = await transport('orders.get', { orderId: input.orderId });
-      return JSON.parse(raw) as Order;
+      // bulwark:lookup-hardened: bounded wait, validated body, retried on transient failure
+      return withRetry(
+        async () => parseOrder(await withTimeout(transport('orders.get', { orderId: input.orderId }), LOOKUP_TIMEOUT_MS)),
+        LOOKUP_ATTEMPTS,
+      );
     }),
 
     issue_refund: span({ kind: 'TOOL', name: 'issue_refund', toolName: 'issue_refund' }, async (input) => {
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 13→11ms (-12%), p95 15→14ms (-9%), steps 5.0→5.0 (+0.0), cost n/a.
Under latency-spike (informational, not budgeted): p50 3038→1040ms, avg steps 3.1→4.6.


## Proof the regression test guards the fix
With the fix removed: 21/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
