# Postmortem: gd-latency-malformed

**Run** 2026-10-11T16-33-14-751Z · **Status** ✅ fixed and verified

## Hypothesis
Most order lookups are slow and some come back truncated: every bounded retry spends its full 1s timeout, and the separate order reads that single-fault fixes added (lookup, refund guard, consistent re-read) add up past the 5s deadline. (latency-spike@0.7 + malformed-response@0.3)

## Blast radius (before)
35/40 trials passed (95% CI 74%–95%).
Outcomes: 35 completed, 5 hung. Broken rules: 5× Every ticket gets a reply to the customer.; 5× A run finishes within 5 seconds.
- Replay: seed 3347360258 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run hung, 0 emails total))
- Replay: seed 3347360258 → A run finishes within 5 seconds. (took 5001ms (limit 5000ms))

## What neatlogs recorded
neatlogs read-back unavailable (neatlogs read-back disabled (wait 0)); used local evidence.

## Attempts

### ✅ Attempt 1: One time budget for the whole run (`run-deadline`, by playbook)
Each single-fault fix bounds its own calls (1s x 3 attempts per order read), but a refund now reads the order up to three times (lookup, refund guard, consistent re-read). Under slow AND broken lookups together those bounded retries add up past the 5s deadline. Every call now draws on one 4s budget for the run; when it is spent, calls fail fast and the run escalates, and the reply email is exempt so the customer always hears back.

Checkpoint before attempt: `ckpt-012`. Judge: **fixed**. 35/40 → 40/40 on fresh seeds (p=2.7e-2), no regressions.
Overhead: happy path p50 13→12ms (-4%), p95 15→15ms (-5%), steps 5.0→5.0 (+0.0), cost n/a.


## Root cause and fix
Each single-fault fix bounds its own calls (1s x 3 attempts per order read), but a refund now reads the order up to three times (lookup, refund guard, consistent re-read). Under slow AND broken lookups together those bounded retries add up past the 5s deadline. Every call now draws on one 4s budget for the run; when it is spent, calls fail fast and the run escalates, and the reply email is exempt so the customer always hears back.

```diff
diff --git a/targets/refundbot/agent.ts b/targets/refundbot/agent.ts
index 58a17bf..eaf3430 100644
--- a/targets/refundbot/agent.ts
+++ b/targets/refundbot/agent.ts
@@ -57,6 +57,26 @@ async function escalate(tools: Tools, ticket: Ticket): Promise<RunResult['reply'
   return `Escalated ${ticket.id} to a human.`;
 }
 
+const RUN_BUDGET_MS = 4000;
+
+// bulwark:run-deadline: every service call draws on one time budget for the whole run, so retries in
+// separate tools can't add up past the deadline. When it is spent, calls fail fast and the run escalates;
+// the reply email is exempt, so the customer always hears back.
+function withDeadline(transport: Transport, deadline: number): Transport {
+  return (endpoint, payload) => {
+    if (endpoint === 'email.send') return transport(endpoint, payload);
+    const left = deadline - performance.now();
+    if (left <= 0) return Promise.reject(new Error(`run budget of ${RUN_BUDGET_MS}ms spent`));
+    return new Promise((resolve, reject) => {
+      const t = setTimeout(() => reject(new Error(`run budget of ${RUN_BUDGET_MS}ms spent`)), left);
+      transport(endpoint, payload).then(
+        (v) => (clearTimeout(t), resolve(v)),
+        (e) => (clearTimeout(t), reject(e)),
+      );
+    });
+  };
+}
+
 export async function runRefundBot(
   ticket: Ticket,
   deps: { transport: Transport; brain: Brain },
@@ -64,7 +84,7 @@ export async function runRefundBot(
   return trace(
     { name: 'refundbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } },
     async () => {
-      const tools = createTools(deps.transport, ticket);
+      const tools = createTools(withDeadline(deps.transport, performance.now() + RUN_BUDGET_MS), ticket);
       const history: Step[] = [];
       while (true) {
         // bulwark:step-budget: a stuck tool can't burn unbounded steps and tokens
```

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 13→12ms (-4%), p95 15→15ms (-5%), steps 5.0→5.0 (+0.0), cost n/a.
Under gd-latency-malformed (informational, not budgeted): p50 3010→3008ms, avg steps 2.2→2.2.


## Proof the regression test guards the fix
With the fix removed: 37/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
