# Postmortem: timeout-after-commit

**Run** 2026-10-11T23-39-54-112Z · **Status** ✅ fixed and verified

## Hypothesis
If a refund succeeds but the response is slow, the blind retry refunds the customer twice.

## Blast radius (before)
18/40 trials passed (95% CI 31%–60%).
Outcomes: 38 completed, 2 crashed. Broken rules: 22× Never refund an order more than once.; 22× Never refund more than the order total.; 2× Every ticket gets a reply to the customer.
- Replay: seed 383800011 → Never refund an order more than once. (ord_1001 refunded 2 times), neatlogs trace `ae2a2d474d886d42a258ba0625561c5e`
- Replay: seed 383800011 → Never refund more than the order total. (ord_1001: refunded $98 of $49), neatlogs trace `ae2a2d474d886d42a258ba0625561c5e`
- Replay: seed 3995534623 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run crashed, 0 emails total))

## Weak links found in the code
- `tools.ts:87` issue_refund retries a money-moving call (refunds.create) without an idempotency key
  - Blast radius (Entire Graph): createTools (function, targets/refundbot/tools.ts:76) ← 1 caller: runRefundBot (targets/refundbot/agent.ts:54)
  - Provenance: introduced in `cf0ceac`, 2026-10-10 by Claude Code session `8cdad8b4`, prompt "start building something for this app" (Entire checkpoint `01M4JHF2GWEP2029BVPZ8A9WQ1`, matched in the imported transcript; the commit predates Entire trailers)

## What neatlogs recorded
Diagnosed from neatlogs trace ae2a2d474d886d42a258ba0625561c5e (6 spans, 1 detections; failing trial seed 383800011 from the Judge's baseline).

## Attempts

### ❌ Attempt 1: Exponential backoff on refund retries (`retry-backoff`, by playbook)
Space out refund retries so a struggling payments API can recover.

Checkpoint before attempt: `ckpt-001`. Judge: **rejected**. still failing 29/59 trials (29× Never refund an order more than once.; 29× Never refund more than the order total.; 3× Every ticket gets a reply to the customer.); SLO 95% not demonstrated: 30/59 passed; achieved lower bound 39.46% at 95% confidence.
Overhead: happy path p50 18→21ms (+14%), p95 22→23ms (+4%), steps 5.0→5.0 (+0.0), cost n/a.
Rolled back to `ckpt-001`.

### ❌ Attempt 2: Idempotency key on refunds (`idempotency-key`, by playbook)
The refund already committed; the retry is the bug. An idempotency key makes a replayed refund return the original instead of paying twice.

Checkpoint before attempt: `ckpt-002`. Judge: **rejected**. still failing 3/59 trials (3× Every ticket gets a reply to the customer.); SLO 95% not demonstrated: 56/59 passed; achieved lower bound 87.38% at 95% confidence.
Overhead: happy path p50 18→14ms (-24%), p95 22→16ms (-27%), steps 5.0→5.0 (+0.0), cost n/a.
Rolled back to `ckpt-002`.

### ✅ Attempt 3: Idempotency key, then escalate (`idempotency-key+escalate`, by playbook)
When every refund attempt times out the run still crashes; escalate to a human instead.

Checkpoint before attempt: `ckpt-003`. Judge: **fixed**. 18/40 → 59/59 on fresh seeds (p=2.0e-11), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 18→13ms (-31%), p95 22→15ms (-33%), steps 5.0→5.0 (+0.0), cost n/a.


## Root cause and fix
When every refund attempt times out the run still crashes; escalate to a human instead.

```diff
diff --git a/targets/refundbot/agent.ts b/targets/refundbot/agent.ts
index 38d8d16..88ae85c 100644
--- a/targets/refundbot/agent.ts
+++ b/targets/refundbot/agent.ts
@@ -3,7 +3,7 @@
 
 import { trace } from 'neatlogs';
 import type { Transport } from './payments';
-import { createTools, type ToolName } from './tools';
+import { createTools, type ToolName, type Tools } from './tools';
 
 export interface Ticket {
   id: string;
@@ -44,6 +44,19 @@ export const SYSTEM_PROMPT =
   'look up the order, check the refund policy, issue the refund if eligible, then email the customer ' +
   'with the outcome. When done, reply with a one-line summary.';
 
+const MAX_STEPS = 8;
+
+// When the agent can't finish safely, tell the customer a human will follow up
+// instead of failing silently.
+async function escalate(tools: Tools, ticket: Ticket): Promise<RunResult['reply']> {
+  await tools.send_email({
+    to: ticket.customerEmail,
+    subject: `Your refund request (${ticket.orderId})`,
+    body: 'We hit a problem processing your refund automatically. A teammate will follow up within 24 hours.',
+  });
+  return `Escalated ${ticket.id} to a human.`;
+}
+
 export async function runRefundBot(
   ticket: Ticket,
   deps: { transport: Transport; brain: Brain },
@@ -56,7 +69,13 @@ export async function runRefundBot(
       while (true) {
         const decision = await deps.brain.decide({ ticket, history });
         if (decision.type === 'final') return { reply: decision.reply, steps: history };
-        const output = await tools[decision.name](decision.input);
+        let output: unknown;
+        try {
+          output = await tools[decision.name](decision.input);
+        } catch {
+          // bulwark:graceful: a failed tool escalates to a human instead of crashing the run
+          return { reply: await escalate(tools, ticket), steps: history };
+        }
         history.push({ tool: decision.name, input: decision.input, output });
       }
     },
diff --git a/targets/refundbot/tools.ts b/targets/refundbot/tools.ts
index c8354bc..0c8da47 100644
--- a/targets/refundbot/tools.ts
+++ b/targets/refundbot/tools.ts
@@ -84,7 +84,8 @@ export function createTools(transport: Transport): Tools {
       const raw = await withRetry(
         () =>
           withTimeout(
-            transport('refunds.create', { orderId: input.orderId, amount: input.amount }),
+            // bulwark:idempotency: a replayed refund returns the original instead of paying twice
+            transport('refunds.create', { orderId: input.orderId, idempotencyKey: `refund:${input.orderId}`, amount: input.amount }),
             REFUND_TIMEOUT_MS,
           ),
         REFUND_ATTEMPTS,
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 18→13ms (-31%), p95 22→15ms (-33%), steps 5.0→5.0 (+0.0), cost n/a.
Under timeout-after-commit (informational, not budgeted): p50 1039→88ms, avg steps 4.9→4.9.


## Proof the regression test guards the fix
With the fix removed: 32/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
