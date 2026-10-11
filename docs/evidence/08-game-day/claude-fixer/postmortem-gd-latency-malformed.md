# Postmortem: gd-latency-malformed

**Run** 2026-10-11T16-37-16-701Z · **Status** ✅ fixed and verified

## Hypothesis
Most order lookups are slow and some come back truncated: every bounded retry spends its full 1s timeout, and the separate order reads that single-fault fixes added (lookup, refund guard, consistent re-read) add up past the 5s deadline. (latency-spike@0.7 + malformed-response@0.3)

## Blast radius (before)
35/40 trials passed (95% CI 74%–95%).
Outcomes: 35 completed, 5 hung. Broken rules: 5× Every ticket gets a reply to the customer.; 5× A run finishes within 5 seconds.
- Replay: seed 3347360258 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run hung, 0 emails total))
- Replay: seed 3347360258 → A run finishes within 5 seconds. (took 5000ms (limit 5000ms))

## What neatlogs recorded
neatlogs read-back unavailable (neatlogs read-back disabled (wait 0)); used local evidence.

## Attempts

### ✅ Attempt 1: Bound total order-lookup latency with an overall deadline and reduce redundant reads (`deadline-budget-and-shared-read`, by claude-sonnet-5)

The root cause is that each order lookup (lookup_order, the fresh re-read in issue_refund, and the second re-read for the refund-guard) independently retries up to 3 times with a 1s timeout each. Under latency-spike (0.7 probability of a 10s-slow backend, clamped by the 1s per-attempt timeout) and malformed-response (0.3 probability of a truncated/invalid body, which also burns a retry), a single tool call can spend up to 3s, and the run makes multiple such calls (lookup_order, then issue_refund's two reads) — easily exceeding the 5s overall deadline even though no single call exceeds its own timeout. That's why trials hang/time out at exactly ~5000ms with zero crashes (malformed/slow responses are *handled* per-call, but the cumulative latency across calls is unbounded).

Fix:
1. Introduce a single process-wide-per-run deadline (`DEADLINE_MS = 4500ms`, leaving headroom under the 5s judge limit) tracked via a start timestamp passed through the tools. Each retrying read now computes a remaining-time budget and uses `Math.min(perAttemptTimeout, remaining)` for its timeout, and stops retrying once the deadline has passed, instead of always doing up to 3 full 1s attempts regardless of how much time is left.
2. Eliminate the redundant third read in `issue_refund`: the "fresh read" (`readOrderNow`) already fetches a consistent, validated order and is used for the paid-status guard; the refund-guard amount-capping can reuse that same order object instead of issuing a second independent `orders.get` call. This removes one whole lookup (and its retries) from the critical path without weakening any business rule — the amount cap and ownership check still happen against the authoritative order payload.
3. When the deadline is hit mid-retry, the read functions throw, which is caught by `agent.ts`'s existing graceful-escalation path (`try/catch` around tool calls) — so the ticket still gets a reply via `escalate`, satisfying "every ticket gets a reply" while keeping the run under 5s.

This preserves every business rule (ownership check, amount cap, double-refund guard via idempotency key, already-refunded guard via fresh status read) while bounding worst-case cumulative latency so the run reliably finishes within the deadline, replying to the customer either with a real outcome or an escalation.


Checkpoint before attempt: `ckpt-001`. Judge: **fixed**. 35/40 → 40/40 on fresh seeds (p=2.7e-2), no regressions.
Overhead: happy path p50 4→6ms (+49%), p95 5→7ms (+50%), steps 5.0→5.0 (+0.0), cost n/a.


## Root cause and fix

The root cause is that each order lookup (lookup_order, the fresh re-read in issue_refund, and the second re-read for the refund-guard) independently retries up to 3 times with a 1s timeout each. Under latency-spike (0.7 probability of a 10s-slow backend, clamped by the 1s per-attempt timeout) and malformed-response (0.3 probability of a truncated/invalid body, which also burns a retry), a single tool call can spend up to 3s, and the run makes multiple such calls (lookup_order, then issue_refund's two reads) — easily exceeding the 5s overall deadline even though no single call exceeds its own timeout. That's why trials hang/time out at exactly ~5000ms with zero crashes (malformed/slow responses are *handled* per-call, but the cumulative latency across calls is unbounded).

Fix:
1. Introduce a single process-wide-per-run deadline (`DEADLINE_MS = 4500ms`, leaving headroom under the 5s judge limit) tracked via a start timestamp passed through the tools. Each retrying read now computes a remaining-time budget and uses `Math.min(perAttemptTimeout, remaining)` for its timeout, and stops retrying once the deadline has passed, instead of always doing up to 3 full 1s attempts regardless of how much time is left.
2. Eliminate the redundant third read in `issue_refund`: the "fresh read" (`readOrderNow`) already fetches a consistent, validated order and is used for the paid-status guard; the refund-guard amount-capping can reuse that same order object instead of issuing a second independent `orders.get` call. This removes one whole lookup (and its retries) from the critical path without weakening any business rule — the amount cap and ownership check still happen against the authoritative order payload.
3. When the deadline is hit mid-retry, the read functions throw, which is caught by `agent.ts`'s existing graceful-escalation path (`try/catch` around tool calls) — so the ticket still gets a reply via `escalate`, satisfying "every ticket gets a reply" while keeping the run under 5s.

This preserves every business rule (ownership check, amount cap, double-refund guard via idempotency key, already-refunded guard via fresh status read) while bounding worst-case cumulative latency so the run reliably finishes within the deadline, replying to the customer either with a real outcome or an escalation.


```diff
diff --git a/.bulwark/runs/2026-10-11T16-33-14-751Z/ws/model-degradation-accepted/tools.ts b/.bulwark/runs/2026-10-11T16-33-14-751Z/ws/model-degradation-accepted/tools.ts
index 142ee0a..82bb25f 100644
--- a/.bulwark/runs/2026-10-11T16-33-14-751Z/ws/model-degradation-accepted/tools.ts
+++ b/.bulwark/runs/2026-10-11T16-33-14-751Z/ws/model-degradation-accepted/tools.ts
@@ -48,7 +48,18 @@ export const TOOL_SCHEMAS = [
 const REFUND_TIMEOUT_MS = 1000;
 const REFUND_ATTEMPTS = 3;
 
+// bulwark:run-deadline: the judge enforces a 5s wall-clock budget for the whole run.
+// Every retrying read below is bounded by however much of this budget remains, so
+// a slow or malformed-response storm on orders.get can't make several independent
+// lookups each burn their own full 1s x 3-attempt allowance and blow past 5s in total.
+const RUN_DEADLINE_MS = 4500;
+
+function remainingBudget(startedAt: number): number {
+  return RUN_DEADLINE_MS - (Date.now() - startedAt);
+}
+
 function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
+  if (ms <= 0) return Promise.reject(new Error('deadline exceeded before attempt'));
   return new Promise((resolve, reject) => {
     const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
     p.then(
@@ -58,12 +69,20 @@ function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
   });
 }
 
-// Payments are flaky, so refunds get retried.
-async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
+// Payments are flaky, so refunds get retried. Retries stop early once the overall
+// run deadline is exhausted, instead of always spending every attempt's full timeout.
+async function withRetry<T>(
+  fn: (timeoutMs: number) => Promise<T>,
+  attempts: number,
+  perAttemptTimeoutMs: number,
+  startedAt: number,
+): Promise<T> {
   let lastErr: unknown;
   for (let i = 0; i < attempts; i++) {
+    const budget = remainingBudget(startedAt);
+    if (budget <= 0) throw lastErr ?? new Error('run deadline exceeded');
     try {
-      return await fn();
+      return await fn(Math.min(perAttemptTimeoutMs, budget));
     } catch (err) {
       lastErr = err;
     }
@@ -82,51 +101,67 @@ function parseOrder(raw: string): Order {
   return order;
 }
 
-// bulwark:fresh-read: the order as it is right now, bounded and retried like any lookup
-async function readOrderNow(transport: Transport, orderId: unknown): Promise<Order> {
-  return withRetry(async () => {
-    const order = JSON.parse(await withTimeout(transport('orders.get', { orderId, consistent: true }), 1000)) as Order;
-    if (typeof order?.id !== 'string' || typeof order.status !== 'string') throw new Error('invalid order payload');
-    return order;
-  }, 3);
+// bulwark:fresh-read: the order as it is right now, bounded and retried like any lookup,
+// but capped by the overall run deadline rather than always spending the full retry budget.
+async function readOrderNow(transport: Transport, orderId: unknown, startedAt: number): Promise<Order> {
+  return withRetry(
+    async (timeoutMs) => {
+      const order = JSON.parse(
+        await withTimeout(transport('orders.get', { orderId, consistent: true }), timeoutMs),
+      ) as Order;
+      if (typeof order?.id !== 'string' || typeof order.status !== 'string' || typeof order.total !== 'number') {
+        throw new Error('invalid order payload');
+      }
+      return order;
+    },
+    3,
+    1000,
+    startedAt,
+  );
 }
 
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport, ticket?: { customerEmail: string }): Tools {
+  // bulwark:run-deadline: shared clock for this run's tool calls so cumulative
+  // lookup latency (not just each individual call) stays inside the 5s budget.
+  const startedAt = Date.now();
+
   return {
     lookup_order: span({ kind: 'TOOL', name: 'lookup_order', toolName: 'lookup_order' }, async (input) => {
       // bulwark:lookup-hardened: bounded wait, validated body, retried on transient failure
       return withRetry(
-        async () => parseOrder(await withTimeout(transport('orders.get', { orderId: input.orderId }), LOOKUP_TIMEOUT_MS)),
+        async (timeoutMs) => parseOrder(await withTimeout(transport('orders.get', { orderId: input.orderId }), timeoutMs)),
         LOOKUP_ATTEMPTS,
+        LOOKUP_TIMEOUT_MS,
+        startedAt,
       );
     }),
 
     issue_refund: span({ kind: 'TOOL', name: 'issue_refund', toolName: 'issue_refund' }, async (input) => {
-      // bulwark:fresh-read: strongly consistent re-read (bypasses the read cache) just before moving money; refund only a paid order, so a refund made through another channel is never repeated
-      const current = await readOrderNow(transport, input.orderId);
-      if (current.status !== 'paid') {
-        return { refused: true, reason: `order ${current.id} is ${current.status}; nothing to refund` };
+      // bulwark:fresh-read: strongly consistent re-read (bypasses the read cache) just before moving money; refund only a paid order, so a refund made through another channel is never repeated.
+      // This single authoritative read is also reused below for the amount cap and ownership
+      // check instead of issuing a second independent orders.get, cutting cumulative latency.
+      const order = await readOrderNow(transport, input.orderId, startedAt);
+      if (order.status !== 'paid') {
+        return { refused: true, reason: `order ${order.id} is ${order.status}; nothing to refund` };
       }
       // bulwark:refund-guard: never move more money than the order is worth, whatever the model asks for
-      const order = await withRetry(
-        async () => JSON.parse(await withTimeout(transport('orders.get', { orderId: input.orderId }), 1000)) as Order,
-        3,
-      );
       const amount = Math.min(Number(input.amount), order.total);
       // bulwark:ownership: only refund orders that belong to the ticket's customer, whoever they claim to be
       if (ticket && order.email !== ticket.customerEmail) {
         return { refused: true, reason: `order ${order.id} does not belong to ${ticket.customerEmail}; refunds go only to the order's owner` };
       }
       const raw = await withRetry(
-        () =>
+        (timeoutMs) =>
           withTimeout(
             // bulwark:idempotency: a replayed refund returns the original instead of paying twice
             transport('refunds.create', { orderId: input.orderId, idempotencyKey: `refund:${input.orderId}`, amount }),
-            REFUND_TIMEOUT_MS,
+            timeoutMs,
           ),
         REFUND_ATTEMPTS,
+        REFUND_TIMEOUT_MS,
+        startedAt,
       );
       return JSON.parse(raw) as Refund;
     }),
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 4→6ms (+49%), p95 5→7ms (+50%), steps 5.0→5.0 (+0.0), cost n/a.
Under gd-latency-malformed (informational, not budgeted): p50 3005→3006ms, avg steps 2.2→2.5.


## Proof the regression test guards the fix
With the fix removed: 37/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
