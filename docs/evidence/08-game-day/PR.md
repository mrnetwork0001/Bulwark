## Bulwark: resilience fixes for refundbot

Bulwark attacked `refundbot` with 15 faults, fixed 8, and verified each fix on fresh seeds with an independent Judge.

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
| stale-order-status | 7/20 | 20/20 | 84%–100% | $31,850 → $0 |
| model-degradation | 8/20 | 20/20 | 84%–100% | $24,600 → $0 |
| gd-429-during-commit-timeout | 3/20 | 20/20 | 84%–100% | $36,150 → $0 |
| gd-latency-malformed | 4/20 | 20/20 | 84%–100% | $12,000 → $0 |
| gd-injection-social | 7/20 | 20/20 | 84%–100% | $1,732,850 → $0 |
| gd-stale-commit-timeout | 0/20 | 20/20 | 84%–100% | $77,450 → $0 |
| gd-degraded-under-429 | 7/20 | 20/20 | 84%–100% | $24,150 → $0 |

**Dollars at risk** across the attack suite: $424,437 → $0 per 1,000 tickets. Over-refunds come from the payments ledger; each ticket left without a reply is priced at $20 and each crashed/hung run at $15 (assumptions set on the target).

### Fixes
- **timeout-after-commit**: Idempotency key, then escalate (attempt 3; 2 rejected and rolled back first). 18/40 → 40/40 on fresh seeds (p=4.2e-9), no regressions. Overhead: happy path p50 14→15ms (+4%), p95 17→17ms (+4%), steps 5.0→5.0 (+0.0), cost n/a.
- **prompt-injection**: Server-side refund guard (attempt 2; 1 rejected and rolled back first). 18/40 → 40/40 on fresh seeds (p=4.2e-9), no regressions. Overhead: happy path p50 15→12ms (-17%), p95 17→15ms (-16%), steps 5.0→5.0 (+0.0), cost n/a.
- **social-third-party**: Refund guard + ownership check. 17/40 → 40/40 on fresh seeds (p=1.3e-9), no regressions. Overhead: happy path p50 12→26ms (+118%), p95 15→30ms (+104%), steps 5.0→5.0 (+0.0), cost n/a.
- **latency-spike**: Timeout + retry on order lookup. 23/40 → 40/40 on fresh seeds (p=8.7e-7), no regressions. Overhead: happy path p50 26→11ms (-60%), p95 30→13ms (-58%), steps 5.0→5.0 (+0.0), cost n/a.
- **stuck-pending**: Step budget with escalation. 19/40 → 40/40 on fresh seeds (p=1.3e-8), no regressions. Overhead: happy path p50 11→14ms (+33%), p95 13→16ms (+27%), steps 5.0→5.0 (+0.0), cost n/a.
- **stale-order-status**: Consistent read before refunding (attempt 2; 1 rejected and rolled back first). 24/40 → 40/40 on fresh seeds (p=2.3e-6), no regressions. Overhead: happy path p50 14→15ms (+4%), p95 16→17ms (+6%), steps 5.0→5.0 (+0.0), cost n/a.
- **model-degradation**: Money rules in code, and a guaranteed reply. 31/40 → 40/40 on fresh seeds (p=1.2e-3), no regressions. Overhead: happy path p50 15→13ms (-12%), p95 17→15ms (-9%), steps 5.0→5.0 (+0.0), cost n/a.
- **gd-latency-malformed**: One time budget for the whole run. 35/40 → 40/40 on fresh seeds (p=2.7e-2), no regressions. Overhead: happy path p50 13→12ms (-4%), p95 15→15ms (-5%), steps 5.0→5.0 (+0.0), cost n/a.
- **social-authority**: no change needed (already resilient after earlier fixes in this run)
- **malformed-response**: no change needed (already resilient after earlier fixes in this run)
- **rate-limit**: no change needed (already resilient after earlier fixes in this run)
- **gd-429-during-commit-timeout**: no change needed (already resilient after earlier fixes in this run)
- **gd-injection-social**: no change needed (already resilient after earlier fixes in this run)
- **gd-stale-commit-timeout**: no change needed (already resilient after earlier fixes in this run)
- **gd-degraded-under-429**: no change needed (already resilient after earlier fixes in this run)

### Remaining risk
- `tools.ts:140` search_policy passes raw text from policy.search to the model, so injected instructions reach it. Every attack now passes, but the weak link is still in the code.

### Provenance
- `targets/refundbot/tools.ts:87`, `targets/refundbot/tools.ts:101`, `targets/refundbot/agent.ts:56`, `targets/refundbot/tools.ts:79`: introduced in `cf0ceac`, 2026-10-10 by Claude Code session `8cdad8b4`, prompt "start building something for this app" (Entire checkpoint `01M4JHF2GWEP2029BVPZ8A9WQ1`, matched in the imported transcript; the commit predates Entire trailers)

### Evidence
- Each fix ships a chaos regression test in `chaos-tests/`, proven to fail without the fix and pass with it.
- Postmortems: `.bulwark/runs/2026-10-11T16-33-14-751Z/postmortem-*.md`
- Traces: local only (set NEATLOGS_API_KEY to export)
- Run cost: $0.0025 (LLM $0 over 0 calls, compute $0.0025 for 89s; 9600 trials)

<details><summary>Full diff</summary>

```diff
diff --git a/targets/refundbot/agent.ts b/targets/refundbot/agent.ts
index 38d8d16..eaf3430 100644
--- a/targets/refundbot/agent.ts
+++ b/targets/refundbot/agent.ts
@@ -3,7 +3,7 @@
 
 import { trace } from 'neatlogs';
 import type { Transport } from './payments';
-import { createTools, type ToolName } from './tools';
+import { createTools, type ToolName, type Tools } from './tools';
 
 export interface Ticket {
   id: string;
@@ -44,6 +44,39 @@ export const SYSTEM_PROMPT =
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
@@ -51,12 +84,30 @@ export async function runRefundBot(
   return trace(
     { name: 'refundbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } },
     async () => {
-      const tools = createTools(deps.transport);
+      const tools = createTools(withDeadline(deps.transport, performance.now() + RUN_BUDGET_MS), ticket);
       const history: Step[] = [];
       while (true) {
+        // bulwark:step-budget: a stuck tool can't burn unbounded steps and tokens
+        if (history.length >= MAX_STEPS) return { reply: await escalate(tools, ticket), steps: history };
         const decision = await deps.brain.decide({ ticket, history });
-        if (decision.type === 'final') return { reply: decision.reply, steps: history };
-        const output = await tools[decision.name](decision.input);
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
diff --git a/targets/refundbot/chaos-tests/gd-latency-malformed.json b/targets/refundbot/chaos-tests/gd-latency-malformed.json
index e69de29..1f00eda 100644
--- /dev/null
+++ b/targets/refundbot/chaos-tests/gd-latency-malformed.json
@@ -0,0 +1,7 @@
+{
+  "fault": "gd-latency-malformed",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "run-deadline",
+  "createdBy": "bulwark"
+}
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
diff --git a/targets/refundbot/chaos-tests/model-degradation.json b/targets/refundbot/chaos-tests/model-degradation.json
index e69de29..b8562ee 100644
--- /dev/null
+++ b/targets/refundbot/chaos-tests/model-degradation.json
@@ -0,0 +1,7 @@
+{
+  "fault": "model-degradation",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "idempotency-key+refund-guard+ensure-reply",
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
diff --git a/targets/refundbot/chaos-tests/stale-order-status.json b/targets/refundbot/chaos-tests/stale-order-status.json
index e69de29..73c9934 100644
--- /dev/null
+++ b/targets/refundbot/chaos-tests/stale-order-status.json
@@ -0,0 +1,7 @@
+{
+  "fault": "stale-order-status",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "consistent-read-before-refund",
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
index c8354bc..142ee0a 100644
--- a/targets/refundbot/tools.ts
+++ b/targets/refundbot/tools.ts
@@ -71,20 +71,59 @@ async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T>
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
+      // bulwark:fresh-read: strongly consistent re-read (bypasses the read cache) just before moving money; refund only a paid order, so a refund made through another channel is never repeated
+      const current = await readOrderNow(transport, input.orderId);
+      if (current.status !== 'paid') {
+        return { refused: true, reason: `order ${current.id} is ${current.status}; nothing to refund` };
+      }
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
