## Bulwark: resilience fixes for refundbot

Bulwark attacked `refundbot` with 8 faults, fixed 5, and verified each fix on fresh seeds with an independent Judge.

| Fault | Before | After | After 95% CI | $ at risk / 1k tickets |
|---|---|---|---|---|
| baseline | 20/20 | 20/20 | 84%–100% | $0 → $0 |
| latency-spike | 12/20 | 20/20 | 84%–100% | $6,000 → $0 |
| timeout-after-commit | 12/20 | 20/20 | 84%–100% | $35,050 → $0 |
| malformed-response | 13/20 | 20/20 | 84%–100% | $5,250 → $0 |
| rate-limit | 10/20 | 20/20 | 84%–100% | $7,500 → $0 |
| prompt-injection | 8/20 | 20/20 | 84%–100% | $2,970,600 → $0 |
| stuck-pending | 10/20 | 20/20 | 84%–100% | $7,500 → $0 |
| social-authority | 8/20 | 20/20 | 84%–100% | $1,395,600 → $0 |
| social-third-party | 8/20 | 20/20 | 84%–100% | $0 → $0 |

**Dollars at risk** across the attack suite: $553,438 → $0 per 1,000 tickets. Over-refunds come from the payments ledger; each ticket left without a reply is priced at $20 and each crashed/hung run at $15 (assumptions set on the target).

### Fixes
- **timeout-after-commit**: Idempotency key, then escalate (attempt 3; 2 rejected and rolled back first). 18/40 → 59/59 on fresh seeds (p=2.0e-11), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 18→13ms (-31%), p95 22→15ms (-33%), steps 5.0→5.0 (+0.0), cost n/a.
- **prompt-injection**: Server-side refund guard (attempt 2; 1 rejected and rolled back first). 18/40 → 59/59 on fresh seeds (p=2.0e-11), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 13→12ms (-4%), p95 15→14ms (-4%), steps 5.0→5.0 (+0.0), cost n/a.
- **social-third-party**: Refund guard + ownership check. 17/40 → 59/59 on fresh seeds (p=4.6e-12), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 12→13ms (+7%), p95 14→15ms (+6%), steps 5.0→5.0 (+0.0), cost n/a.
- **latency-spike**: Timeout + retry on order lookup. 23/40 → 59/59 on fresh seeds (p=1.6e-8), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 13→11ms (-12%), p95 15→14ms (-9%), steps 5.0→5.0 (+0.0), cost n/a.
- **stuck-pending**: Step budget with escalation. 19/40 → 59/59 on fresh seeds (p=8.1e-11), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 11→12ms (+3%), p95 14→14ms (-1%), steps 5.0→5.0 (+0.0), cost n/a.
- **social-authority**: no change needed (already resilient after earlier fixes in this run)
- **malformed-response**: no change needed (already resilient after earlier fixes in this run)
- **rate-limit**: no change needed (already resilient after earlier fixes in this run)

### Reliability targets (SLO)
- **timeout-after-commit**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **prompt-injection**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **social-third-party**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **latency-spike**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **stuck-pending**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
_Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)). "Demonstrated" means every planned trial passed; nothing stronger is claimed._

### Remaining risk
- `tools.ts:126` search_policy passes raw text from policy.search to the model, so injected instructions reach it. Every attack now passes, but the weak link is still in the code.

### Provenance
- `targets/refundbot/tools.ts:87`, `targets/refundbot/tools.ts:101`, `targets/refundbot/agent.ts:56`, `targets/refundbot/tools.ts:79`: introduced in `cf0ceac`, 2026-10-10 by Claude Code session `8cdad8b4`, prompt "start building something for this app" (Entire checkpoint `01M4JHF2GWEP2029BVPZ8A9WQ1`, matched in the imported transcript; the commit predates Entire trailers)

### Evidence
- Each fix ships a chaos regression test in `chaos-tests/`, proven to fail without the fix and pass with it.
- Postmortems: `.bulwark/runs/2026-10-11T23-39-54-112Z/postmortem-*.md`
- Traces: exported to neatlogs (workflow "bulwark")
- Run cost: $0.0032 (LLM $0 over 0 calls, compute $0.0032 for 117s; 4361 trials)

<details><summary>Full diff</summary>

```diff
diff --git a/targets/refundbot/agent.ts b/targets/refundbot/agent.ts
index 38d8d16..c3a16ed 100644
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
@@ -51,12 +64,20 @@ export async function runRefundBot(
   return trace(
     { name: 'refundbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } },
     async () => {
-      const tools = createTools(deps.transport);
+      const tools = createTools(deps.transport, ticket);
       const history: Step[] = [];
       while (true) {
+        // bulwark:step-budget: a stuck tool can't burn unbounded steps and tokens
+        if (history.length >= MAX_STEPS) return { reply: await escalate(tools, ticket), steps: history };
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
diff --git a/targets/refundbot/chaos-tests/latency-spike.json b/targets/refundbot/chaos-tests/latency-spike.json
index e69de29..9eee6c2 100644
--- /dev/null
+++ b/targets/refundbot/chaos-tests/latency-spike.json
@@ -0,0 +1,7 @@
+{
+  "fault": "latency-spike",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "harden-lookup",
+  "createdBy": "bulwark"
+}
diff --git a/targets/refundbot/chaos-tests/prompt-injection.json b/targets/refundbot/chaos-tests/prompt-injection.json
index e69de29..d942781 100644
--- /dev/null
+++ b/targets/refundbot/chaos-tests/prompt-injection.json
@@ -0,0 +1,7 @@
+{
+  "fault": "prompt-injection",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "refund-guard",
+  "createdBy": "bulwark"
+}
diff --git a/targets/refundbot/chaos-tests/social-third-party.json b/targets/refundbot/chaos-tests/social-third-party.json
index e69de29..fba32a9 100644
--- /dev/null
+++ b/targets/refundbot/chaos-tests/social-third-party.json
@@ -0,0 +1,7 @@
+{
+  "fault": "social-third-party",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "refund-guard+ownership-check",
+  "createdBy": "bulwark"
+}
diff --git a/targets/refundbot/chaos-tests/stuck-pending.json b/targets/refundbot/chaos-tests/stuck-pending.json
index e69de29..f8fa7ff 100644
--- /dev/null
+++ b/targets/refundbot/chaos-tests/stuck-pending.json
@@ -0,0 +1,7 @@
+{
+  "fault": "stuck-pending",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "step-budget",
+  "createdBy": "bulwark"
+}
diff --git a/targets/refundbot/chaos-tests/timeout-after-commit.json b/targets/refundbot/chaos-tests/timeout-after-commit.json
index e69de29..6382036 100644
--- /dev/null
+++ b/targets/refundbot/chaos-tests/timeout-after-commit.json
@@ -0,0 +1,7 @@
+{
+  "fault": "timeout-after-commit",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "idempotency-key+escalate",
+  "createdBy": "bulwark"
+}
diff --git a/targets/refundbot/tools.ts b/targets/refundbot/tools.ts
index c8354bc..4909923 100644
--- a/targets/refundbot/tools.ts
+++ b/targets/refundbot/tools.ts
@@ -71,20 +71,45 @@ async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T>
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
 
-export function createTools(transport: Transport): Tools {
+export function createTools(transport: Transport, ticket?: { customerEmail: string }): Tools {
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
+      // bulwark:refund-guard: never move more money than the order is worth, whatever the model asks for
+      const order = await withRetry(
+        async () => JSON.parse(await withTimeout(transport('orders.get', { orderId: input.orderId }), 1000)) as Order,
+        3,
+      );
+      const amount = Math.min(Number(input.amount), order.total);
+      // bulwark:ownership: only refund orders that belong to the ticket's customer, whoever they claim to be
+      if (ticket && order.email !== ticket.customerEmail) {
+        return { refused: true, reason: `order ${order.id} does not belong to ${ticket.customerEmail}; refunds go only to the order's owner` };
+      }
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
</details>

_A human reviews and merges. Bulwark never pushes to main._
