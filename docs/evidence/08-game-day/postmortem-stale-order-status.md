# Postmortem: stale-order-status

**Run** 2026-10-11T16-33-14-751Z · **Status** ✅ fixed and verified

## Hypothesis
If the order was already refunded through another channel (the store POS) but the orders API serves a cached "paid" status, RefundBot refunds it a second time, because it never re-reads the order before moving money.

## Blast radius (before)
24/40 trials passed (95% CI 45%–74%).
Outcomes: 40 completed. Broken rules: 16× Never refund an order that is already refunded.
- Replay: seed 3611092018 → Never refund an order that is already refunded. (refunded ord_1001 ($49) again: it was already refunded via store-pos)

## What neatlogs recorded
neatlogs read-back unavailable (neatlogs read-back disabled (wait 0)); used local evidence.

## Attempts

### ❌ Attempt 1: Re-read the order before refunding (`recheck-before-refund`, by playbook)
Look the order up again right before issue_refund and refund only if it is still paid.

Checkpoint before attempt: `ckpt-009`. Judge: **rejected**. still failing 16/40 trials (16× Never refund an order that is already refunded.).
Overhead: happy path p50 14→11ms (-18%), p95 16→13ms (-16%), steps 5.0→5.0 (+0.0), cost n/a.
Rolled back to `ckpt-009`.

### ✅ Attempt 2: Consistent read before refunding (`consistent-read-before-refund`, by playbook)
A second read through the same cache returns the same stale "paid". Read the order with a strongly consistent read (bypassing the cache) right before moving money, and refuse unless it is paid: idempotency by order state, which also covers refunds made through another channel.

Checkpoint before attempt: `ckpt-010`. Judge: **fixed**. 24/40 → 40/40 on fresh seeds (p=2.3e-6), no regressions.
Overhead: happy path p50 14→15ms (+4%), p95 16→17ms (+6%), steps 5.0→5.0 (+0.0), cost n/a.


## Root cause and fix
A second read through the same cache returns the same stale "paid". Read the order with a strongly consistent read (bypassing the cache) right before moving money, and refuse unless it is paid: idempotency by order state, which also covers refunds made through another channel.

```diff
diff --git a/targets/refundbot/tools.ts b/targets/refundbot/tools.ts
index 4909923..142ee0a 100644
--- a/targets/refundbot/tools.ts
+++ b/targets/refundbot/tools.ts
@@ -82,6 +82,15 @@ function parseOrder(raw: string): Order {
   return order;
 }
 
+// bulwark:fresh-read: the order as it is right now, bounded and retried like any lookup
+async function readOrderNow(transport: Transport, orderId: unknown): Promise<Order> {
+  return withRetry(async () => {
+    const order = JSON.parse(await withTimeout(transport('orders.get', { orderId, consistent: true }), 1000)) as Order;
+    if (typeof order?.id !== 'string' || typeof order.status !== 'string') throw new Error('invalid order payload');
+    return order;
+  }, 3);
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport, ticket?: { customerEmail: string }): Tools {
@@ -95,6 +104,11 @@ export function createTools(transport: Transport, ticket?: { customerEmail: stri
     }),
 
     issue_refund: span({ kind: 'TOOL', name: 'issue_refund', toolName: 'issue_refund' }, async (input) => {
+      // bulwark:fresh-read: strongly consistent re-read (bypasses the read cache) just before moving money; refund only a paid order, so a refund made through another channel is never repeated
+      const current = await readOrderNow(transport, input.orderId);
+      if (current.status !== 'paid') {
+        return { refused: true, reason: `order ${current.id} is ${current.status}; nothing to refund` };
+      }
       // bulwark:refund-guard: never move more money than the order is worth, whatever the model asks for
       const order = await withRetry(
         async () => JSON.parse(await withTimeout(transport('orders.get', { orderId: input.orderId }), 1000)) as Order,
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 14→15ms (+4%), p95 16→17ms (+6%), steps 5.0→5.0 (+0.0), cost n/a.
Under stale-order-status (informational, not budgeted): p50 127→116ms, avg steps 4.4→4.4.


## Proof the regression test guards the fix
With the fix removed: 19/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
