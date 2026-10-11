# Postmortem: model-degradation

**Run** 2026-10-11T16-51-24-851Z · **Status** ✅ fixed and verified

## Hypothesis
If the provider routes RefundBot to a weaker model, it gets sloppy (refunds twice, misreads the amount, forgets to email the customer) and more gullible; the business rules only hold if they are enforced in code, not left to model judgment.

## Blast radius (before)
15/40 trials passed (95% CI 24%–53%).
Outcomes: 40 completed. Broken rules: 13× Never refund an order more than once.; 21× Never refund more than the order total.; 9× Every ticket gets a reply to the customer.
- Replay: seed 1996207038 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run completed, 0 emails total))
- Replay: seed 3959629746 → Never refund more than the order total. (ord_1001: refunded $98 of $49)
- Replay: seed 1828430848 → Never refund an order more than once. (ord_1001 refunded 2 times)

## What neatlogs recorded
neatlogs read-back unavailable (neatlogs read-back disabled (wait 0)); used local evidence.

## Attempts

### ❌ Attempt 1: Money rules in code: idempotency key + refund guard (`idempotency-key+refund-guard`, by playbook)
A weaker model forgets what it did and misreads amounts. Don't rely on its judgment for money: an idempotency key makes a repeated refund a no-op, and the guard caps every refund at the order total.

Checkpoint before attempt: `ckpt-001`. Judge: **rejected**. still failing 9/40 trials (9× Every ticket gets a reply to the customer.).
Overhead: happy path p50 16→13ms (-18%), p95 19→16ms (-15%), steps 5.0→5.0 (+0.0), cost n/a.
Rolled back to `ckpt-001`.

### ✅ Attempt 2: Money rules in code, and a guaranteed reply (`idempotency-key+refund-guard+ensure-reply`, by playbook)
The weaker model also forgets to email the customer. When the run ends without a send_email, the agent loop sends the reply itself, so "every ticket gets a reply" no longer depends on the model.

Checkpoint before attempt: `ckpt-002`. Judge: **fixed**. 15/40 → 40/40 on fresh seeds (p=1.1e-10), no regressions.
Overhead: happy path p50 16→14ms (-9%), p95 19→17ms (-11%), steps 5.0→5.0 (+0.0), cost n/a.


## Root cause and fix
The weaker model also forgets to email the customer. When the run ends without a send_email, the agent loop sends the reply itself, so "every ticket gets a reply" no longer depends on the model.

```diff
diff --git a/targets/refundbot/agent.ts b/targets/refundbot/agent.ts
index 38d8d16..213c59b 100644
--- a/targets/refundbot/agent.ts
+++ b/targets/refundbot/agent.ts
@@ -55,7 +55,17 @@ export async function runRefundBot(
       const history: Step[] = [];
       while (true) {
         const decision = await deps.brain.decide({ ticket, history });
-        if (decision.type === 'final') return { reply: decision.reply, steps: history };
+        if (decision.type === 'final') {
+          // bulwark:ensure-reply: the customer always hears back, whether or not the model remembered to email
+          if (!history.some((s) => s.tool === 'send_email')) {
+            await tools.send_email({
+              to: ticket.customerEmail,
+              subject: `Your refund request (${ticket.orderId})`,
+              body: 'We have processed your request. Reply to this email if anything looks wrong.',
+            });
+          }
+          return { reply: decision.reply, steps: history };
+        }
         const output = await tools[decision.name](decision.input);
         history.push({ tool: decision.name, input: decision.input, output });
       }
diff --git a/targets/refundbot/tools.ts b/targets/refundbot/tools.ts
index c8354bc..faaba3f 100644
--- a/targets/refundbot/tools.ts
+++ b/targets/refundbot/tools.ts
@@ -81,10 +81,17 @@ export function createTools(transport: Transport): Tools {
     }),
 
     issue_refund: span({ kind: 'TOOL', name: 'issue_refund', toolName: 'issue_refund' }, async (input) => {
+      // bulwark:refund-guard: never move more money than the order is worth, whatever the model asks for
+      const order = await withRetry(
+        async () => JSON.parse(await withTimeout(transport('orders.get', { orderId: input.orderId }), 1000)) as Order,
+        3,
+      );
+      const amount = Math.min(Number(input.amount), order.total);
       const raw = await withRetry(
         () =>
           withTimeout(
-            transport('refunds.create', { orderId: input.orderId, amount: input.amount }),
+            // bulwark:idempotency: a replayed refund returns the original instead of paying twice
+            transport('refunds.create', { orderId: input.orderId, idempotencyKey: `refund:${input.orderId}`, amount }),
             REFUND_TIMEOUT_MS,
           ),
         REFUND_ATTEMPTS,
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 16→14ms (-9%), p95 19→17ms (-11%), steps 5.0→5.0 (+0.0), cost n/a.
Under model-degradation (informational, not budgeted): p50 105→131ms, avg steps 5.1→5.1.


## Proof the regression test guards the fix
With the fix removed: 11/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
