# Postmortem: model-degradation

**Run** 2026-10-11T16-33-14-751Z · **Status** ✅ fixed and verified

## Hypothesis
If the provider routes RefundBot to a weaker model, it gets sloppy (refunds twice, misreads the amount, forgets to email the customer) and more gullible; the business rules only hold if they are enforced in code, not left to model judgment.

## Blast radius (before)
31/40 trials passed (95% CI 62%–88%).
Outcomes: 40 completed. Broken rules: 9× Every ticket gets a reply to the customer.
- Replay: seed 1996207038 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run completed, 0 emails total))

## What neatlogs recorded
neatlogs read-back unavailable (neatlogs read-back disabled (wait 0)); used local evidence.

## Attempts

### ✅ Attempt 1: Money rules in code, and a guaranteed reply (`idempotency-key+refund-guard+ensure-reply`, by playbook)
The weaker model also forgets to email the customer. When the run ends without a send_email, the agent loop sends the reply itself, so "every ticket gets a reply" no longer depends on the model.

Checkpoint before attempt: `ckpt-011`. Judge: **fixed**. 31/40 → 40/40 on fresh seeds (p=1.2e-3), no regressions.
Overhead: happy path p50 15→13ms (-12%), p95 17→15ms (-9%), steps 5.0→5.0 (+0.0), cost n/a.


## Root cause and fix
The weaker model also forgets to email the customer. When the run ends without a send_email, the agent loop sends the reply itself, so "every ticket gets a reply" no longer depends on the model.

```diff
diff --git a/targets/refundbot/agent.ts b/targets/refundbot/agent.ts
index c3a16ed..58a17bf 100644
--- a/targets/refundbot/agent.ts
+++ b/targets/refundbot/agent.ts
@@ -70,7 +70,17 @@ export async function runRefundBot(
         // bulwark:step-budget: a stuck tool can't burn unbounded steps and tokens
         if (history.length >= MAX_STEPS) return { reply: await escalate(tools, ticket), steps: history };
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
         let output: unknown;
         try {
           output = await tools[decision.name](decision.input);
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 15→13ms (-12%), p95 17→15ms (-9%), steps 5.0→5.0 (+0.0), cost n/a.
Under model-degradation (informational, not budgeted): p50 189→203ms, avg steps 5.1→5.1.


## Proof the regression test guards the fix
With the fix removed: 33/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
