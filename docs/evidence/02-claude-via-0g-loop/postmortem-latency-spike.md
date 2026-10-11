# Postmortem: latency-spike

**Run** 2026-10-11T03-01-09-926Z · **Status** ✅ fixed and verified

## Hypothesis
If the orders API slows to 10s, RefundBot hangs because lookup_order has no timeout.

## Blast radius (before)
23/40 trials passed (95% CI 42%–71%).
Outcomes: 23 completed, 17 hung. Broken rules: 17× Every ticket gets a reply to the customer.; 17× A run finishes within 5 seconds.
- Replay: seed 290047738 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run hung, 0 emails total))
- Replay: seed 290047738 → A run finishes within 5 seconds. (took 5002ms (limit 5000ms))

## Weak links found in the code
- `tools.ts:79` lookup_order calls orders.get with no timeout

## Attempts

### ✅ Attempt 1: Add timeout to lookup_order (and internal getOrder) calls (`lookup-order-timeout`, by claude-sonnet-5)
Root cause: lookup_order (and the getOrder helper used internally by issue_refund) call transport('orders.get', ...) with no timeout, unlike issue_refund which already wraps its transport call in withTimeout/withRetry. When the orders API latency spikes to 10s, these awaits hang indefinitely, so the agent loop never gets a chance to let the brain see an error and send the customer a reply, blowing both the 5s wall-clock budget and the "every ticket gets a reply" rule (the run hangs with 0 emails sent).

Fix: wrap both the orders.get call in lookup_order and the one in the internal getOrder cache-miss path with the same withTimeout helper already used for refunds, using a short timeout (1500ms) that leaves headroom in the 5s overall budget for search_policy, issue_refund, send_email and the final reply. On timeout the promise rejects; agent.ts's existing try/catch around tool calls turns that into an error step (not a crash), exactly the same mechanism already relied on for issue_refund failures, so the brain can proceed to inform the customer and finish the run instead of hanging. orders.get is a read-only lookup, so abandoning a slow in-flight request on timeout has no side-effect/idempotency implications (unlike refunds, it does not need retries, which would just re-consume the timeout budget against the same 10s-latency fault).

Checkpoint before attempt: `ckpt-005`. Judge: **fixed**. 23/40 → 40/40 on fresh seeds (p=8.7e-7), no regressions


## Root cause and fix
Root cause: lookup_order (and the getOrder helper used internally by issue_refund) call transport('orders.get', ...) with no timeout, unlike issue_refund which already wraps its transport call in withTimeout/withRetry. When the orders API latency spikes to 10s, these awaits hang indefinitely, so the agent loop never gets a chance to let the brain see an error and send the customer a reply, blowing both the 5s wall-clock budget and the "every ticket gets a reply" rule (the run hangs with 0 emails sent).

Fix: wrap both the orders.get call in lookup_order and the one in the internal getOrder cache-miss path with the same withTimeout helper already used for refunds, using a short timeout (1500ms) that leaves headroom in the 5s overall budget for search_policy, issue_refund, send_email and the final reply. On timeout the promise rejects; agent.ts's existing try/catch around tool calls turns that into an error step (not a crash), exactly the same mechanism already relied on for issue_refund failures, so the brain can proceed to inform the customer and finish the run instead of hanging. orders.get is a read-only lookup, so abandoning a slow in-flight request on timeout has no side-effect/idempotency implications (unlike refunds, it does not need retries, which would just re-consume the timeout budget against the same 10s-latency fault).

```diff
diff --git a/targets/refundbot/tools.ts b/targets/refundbot/tools.ts
index 6c64c58..0417f2b 100644
--- a/targets/refundbot/tools.ts
+++ b/targets/refundbot/tools.ts
@@ -51,6 +51,14 @@ export const TOOL_SCHEMAS = [
 const REFUND_TIMEOUT_MS = 700;
 const REFUND_ATTEMPTS = 2;
 
+// Order lookups are read-only, so unlike refunds there's nothing to retry
+// against (retrying a slow read just burns the same budget again against the
+// same latency). A single bounded attempt is enough: if it times out, the
+// transport call is abandoned and the tool call rejects, which agent.ts turns
+// into an error step so the brain can still finish the run and reply to the
+// customer within the overall 5s budget.
+const LOOKUP_TIMEOUT_MS = 1500;
+
 function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
   return new Promise((resolve, reject) => {
     const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
@@ -124,7 +132,7 @@ export function createTools(transport: Transport): Tools {
   async function getOrder(orderId: string): Promise<Order> {
     const cached = orderCache.get(orderId);
     if (cached) return cached;
-    const raw = await transport('orders.get', { orderId });
+    const raw = await withTimeout(transport('orders.get', { orderId }), LOOKUP_TIMEOUT_MS);
     const order = JSON.parse(raw) as Order;
     orderCache.set(orderId, order);
     return order;
@@ -132,7 +140,7 @@ export function createTools(transport: Transport): Tools {
 
   return {
     lookup_order: span({ kind: 'TOOL', name: 'lookup_order', toolName: 'lookup_order' }, async (input) => {
-      const raw = await transport('orders.get', { orderId: input.orderId });
+      const raw = await withTimeout(transport('orders.get', { orderId: input.orderId }), LOOKUP_TIMEOUT_MS);
       const order = JSON.parse(raw) as Order;
       orderCache.set(String(input.orderId), order);
       return order;
```

## Proof the regression test guards the fix
With the fix removed: 21/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
