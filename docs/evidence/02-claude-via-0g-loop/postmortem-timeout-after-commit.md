# Postmortem: timeout-after-commit

**Run** 2026-10-11T03-01-09-926Z · **Status** ✅ fixed and verified

## Hypothesis
If a refund succeeds but the response is slow, the blind retry refunds the customer twice.

## Blast radius (before)
18/40 trials passed (95% CI 31%–60%).
Outcomes: 38 completed, 2 crashed. Broken rules: 22× Never refund an order more than once.; 22× Never refund more than the order total.; 2× Every ticket gets a reply to the customer.
- Replay: seed 383800011 → Never refund an order more than once. (ord_1001 refunded 2 times)
- Replay: seed 383800011 → Never refund more than the order total. (ord_1001: refunded $98 of $49)
- Replay: seed 3995534623 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run crashed, 0 emails total))

## Weak links found in the code
- `tools.ts:87` issue_refund retries a money-moving call (refunds.create) without an idempotency key

## Attempts

### ❌ Attempt 1: Add stable idempotency key to issue_refund retries (`idempotency-key-on-refund-retry`, by claude-sonnet-5)
Root cause: issue_refund retries the refunds.create call via withRetry/withTimeout without any idempotency key. When a refund actually commits on the server but the response is slow and times out client-side, withRetry fires another refunds.create call for the same logical request, and the payments sandbox has no way to recognize it as a duplicate, so the order gets refunded twice (and over the order total). The fix generates one idempotency key per issue_refund invocation (before entering the retry loop) and sends it on every attempt, including the timed-out-then-retried ones, so the payments backend can dedupe retries of the same logical refund while still allowing genuinely distinct refund requests (different key each time issue_refund is called fresh) to proceed. This fixes the double-refund/over-refund without changing any business logic, tool schema, or agent control flow.

Checkpoint before attempt: `ckpt-001`. Judge: **rejected**. still failing 2/40 trials (2× Every ticket gets a reply to the customer.)
Rolled back to `ckpt-001`.

### ✅ Attempt 2: Add idempotency key for refund retries and cap retry/timeout budget so runs finish within time/step limits (`idempotency-key-plus-timeout-budget`, by claude-sonnet-5)
Two things cause the double-refund and the occasional crash/no-reply:

1. issue_refund retried refunds.create without an idempotency key, so a slow-but-committed refund followed by a retry created a second refund on the server. Fix: generate one idempotency key per issue_refund call (not per attempt) and pass it on every attempt including retries, so the payments backend can dedupe retries of the same logical refund.

2. The previous idempotency-only fix still crashed 2/40 trials with "no email sent" / crash. That's because with REFUND_TIMEOUT_MS=1000 and REFUND_ATTEMPTS=3, a single issue_refund call can take up to ~3s before even succeeding/throwing, and if it ultimately throws (e.g. all attempts time out even though the server actually committed), the exception propagates out of the tool call in agent.ts's run loop, which has no try/catch around `await tools[decision.name](decision.input)`. That causes the whole run to crash with an unhandled rejection before any send_email happens, which is exactly the "no email sent, run crashed" failure that was still occurring. Also, with retries eating multiple seconds, a slow run can also blow the 5s wall-clock budget.

The fix:
- Generate an idempotency key once per issue_refund invocation and send it with every retry attempt (via transport input field `idempotencyKey`), so retried attempts after a server-side commit are recognized as duplicates and not double-applied/double-counted in the ledger.
- Reduce the retry budget (attempts and per-attempt timeout) so a worst case issue_refund call cannot exceed the 5s overall run budget, leaving headroom for the other required steps (lookup_order, search_policy, send_email) within the 12-step/5s budget.
- Wrap the tool invocation in agent.ts's run loop in a try/catch so that if a tool call still throws (e.g. transport genuinely down, non-refund tool errors), the agent records the failure as a step result and the brain can still proceed to send an email / finalize the ticket rather than crashing the whole run unhandled. This guarantees "every ticket gets a reply" (an email) even in the rare case a tool call errors out, without masking the double-refund/over-refund bugs (which are fixed by idempotency key dedup in the ledger itself, verified independently of the agent's control flow).

This keeps business logic, tool schemasge, and the model-decision loop unchanged, only hardening the money-moving call against duplicate side effects and hardening the run loop against unhandled tool exceptions so every ticket still gets its reply.

Checkpoint before attempt: `ckpt-002`. Judge: **fixed**. 18/40 → 40/40 on fresh seeds (p=4.2e-9), no regressions


## Root cause and fix
Two things cause the double-refund and the occasional crash/no-reply:

1. issue_refund retried refunds.create without an idempotency key, so a slow-but-committed refund followed by a retry created a second refund on the server. Fix: generate one idempotency key per issue_refund call (not per attempt) and pass it on every attempt including retries, so the payments backend can dedupe retries of the same logical refund.

2. The previous idempotency-only fix still crashed 2/40 trials with "no email sent" / crash. That's because with REFUND_TIMEOUT_MS=1000 and REFUND_ATTEMPTS=3, a single issue_refund call can take up to ~3s before even succeeding/throwing, and if it ultimately throws (e.g. all attempts time out even though the server actually committed), the exception propagates out of the tool call in agent.ts's run loop, which has no try/catch around `await tools[decision.name](decision.input)`. That causes the whole run to crash with an unhandled rejection before any send_email happens, which is exactly the "no email sent, run crashed" failure that was still occurring. Also, with retries eating multiple seconds, a slow run can also blow the 5s wall-clock budget.

The fix:
- Generate an idempotency key once per issue_refund invocation and send it with every retry attempt (via transport input field `idempotencyKey`), so retried attempts after a server-side commit are recognized as duplicates and not double-applied/double-counted in the ledger.
- Reduce the retry budget (attempts and per-attempt timeout) so a worst case issue_refund call cannot exceed the 5s overall run budget, leaving headroom for the other required steps (lookup_order, search_policy, send_email) within the 12-step/5s budget.
- Wrap the tool invocation in agent.ts's run loop in a try/catch so that if a tool call still throws (e.g. transport genuinely down, non-refund tool errors), the agent records the failure as a step result and the brain can still proceed to send an email / finalize the ticket rather than crashing the whole run unhandled. This guarantees "every ticket gets a reply" (an email) even in the rare case a tool call errors out, without masking the double-refund/over-refund bugs (which are fixed by idempotency key dedup in the ledger itself, verified independently of the agent's control flow).

This keeps business logic, tool schemasge, and the model-decision loop unchanged, only hardening the money-moving call against duplicate side effects and hardening the run loop against unhandled tool exceptions so every ticket still gets its reply.

```diff
diff --git a/targets/refundbot/agent.ts b/targets/refundbot/agent.ts
index 38d8d16..a69f7e1 100644
--- a/targets/refundbot/agent.ts
+++ b/targets/refundbot/agent.ts
@@ -56,7 +56,20 @@ export async function runRefundBot(
       while (true) {
         const decision = await deps.brain.decide({ ticket, history });
         if (decision.type === 'final') return { reply: decision.reply, steps: history };
-        const output = await tools[decision.name](decision.input);
+        // Tool calls (especially issue_refund, which retries under a tight
+        // timeout budget) can still throw if the transport is genuinely
+        // unavailable. Record the failure as a step instead of letting it
+        // crash the whole run unhandled, so the brain gets a chance to see
+        // the error and still send the customer a reply email before the
+        // run ends. This does not change the ledger's view of what actually
+        // happened (that's enforced by the payments sandbox + idempotency
+        // key), it only keeps the agent loop resilient.
+        let output: unknown;
+        try {
+          output = await tools[decision.name](decision.input);
+        } catch (err) {
+          output = { error: err instanceof Error ? err.message : String(err) };
+        }
         history.push({ tool: decision.name, input: decision.input, output });
       }
     },
diff --git a/targets/refundbot/tools.ts b/targets/refundbot/tools.ts
index c8354bc..5a2d0ae 100644
--- a/targets/refundbot/tools.ts
+++ b/targets/refundbot/tools.ts
@@ -45,8 +45,11 @@ export const TOOL_SCHEMAS = [
   },
 ];
 
-const REFUND_TIMEOUT_MS = 1000;
-const REFUND_ATTEMPTS = 3;
+// Kept small enough that worst case (all attempts time out) still leaves
+// headroom under the 5s overall run budget for the other steps the agent
+// needs to take (lookup_order, search_policy, send_email, final reply).
+const REFUND_TIMEOUT_MS = 700;
+const REFUND_ATTEMPTS = 2;
 
 function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
   return new Promise((resolve, reject) => {
@@ -58,12 +61,15 @@ function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
   });
 }
 
-// Payments are flaky, so refunds get retried.
-async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
+// Payments are flaky, so refunds get retried. Each attempt reuses the same
+// idempotency key so that if an earlier attempt actually committed on the
+// server before the client timed out, the retry is recognized as a duplicate
+// of the same logical request rather than applied again.
+async function withRetry<T>(fn: (idempotencyKey: string) => Promise<T>, attempts: number, idempotencyKey: string): Promise<T> {
   let lastErr: unknown;
   for (let i = 0; i < attempts; i++) {
     try {
-      return await fn();
+      return await fn(idempotencyKey);
     } catch (err) {
       lastErr = err;
     }
@@ -71,6 +77,10 @@ async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T>
   throw lastErr;
 }
 
+function makeIdempotencyKey(): string {
+  return `idem_${Date.now()}_${Math.random().toString(36).slice(2)}`;
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport): Tools {
@@ -81,13 +91,20 @@ export function createTools(transport: Transport): Tools {
     }),
 
     issue_refund: span({ kind: 'TOOL', name: 'issue_refund', toolName: 'issue_refund' }, async (input) => {
+      // One idempotency key per issue_refund invocation (not per attempt), so
+      // every retry of this same logical refund request carries the same key
+      // and the payments backend can dedupe it, while a genuinely new
+      // issue_refund call (e.g. a separate ticket or a deliberate re-request)
+      // gets a fresh key.
+      const idempotencyKey = makeIdempotencyKey();
       const raw = await withRetry(
-        () =>
+        (key) =>
           withTimeout(
-            transport('refunds.create', { orderId: input.orderId, amount: input.amount }),
+            transport('refunds.create', { orderId: input.orderId, amount: input.amount, idempotencyKey: key }),
             REFUND_TIMEOUT_MS,
           ),
         REFUND_ATTEMPTS,
+        idempotencyKey,
       );
       return JSON.parse(raw) as Refund;
     }),
```

## Proof the regression test guards the fix
With the fix removed: 32/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
