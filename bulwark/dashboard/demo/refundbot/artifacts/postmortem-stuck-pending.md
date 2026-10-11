# Postmortem: stuck-pending

**Run** 2026-10-11T23-39-54-112Z · **Status** ✅ fixed and verified

## Hypothesis
If an order never leaves pending, RefundBot re-checks it forever and burns steps and tokens.

## Blast radius (before)
19/40 trials passed (95% CI 33%–63%).
Outcomes: 19 completed, 21 runaway. Broken rules: 21× Every ticket gets a reply to the customer.; 21× A run takes at most 12 steps.
- Replay: seed 399606141 → Every ticket gets a reply to the customer. (no email sent to ada@example.com via send_email (run runaway, 0 emails total)), neatlogs trace `bd5910161cc359b1f433b6e591e71b8c`
- Replay: seed 399606141 → A run takes at most 12 steps. (51 steps (limit 12)), neatlogs trace `bd5910161cc359b1f433b6e591e71b8c`

## Weak links found in the code
- `agent.ts:56` the agent loop has no step budget, so a stuck tool means unbounded steps and cost
  - Blast radius (Entire Graph): runRefundBot (function, targets/refundbot/agent.ts:47) ← 0 callers
  - Provenance: introduced in `cf0ceac`, 2026-10-10 by Claude Code session `8cdad8b4`, prompt "start building something for this app" (Entire checkpoint `01M4JHF2GWEP2029BVPZ8A9WQ1`, matched in the imported transcript; the commit predates Entire trailers)

## What neatlogs recorded
Diagnosed from neatlogs trace 25bfce4e89cbaab5c13f9d2a545c22c7 (52 spans, 2 detections; failing trial seed 3897159366 from the BEFORE scorecard).

## Attempts

### ✅ Attempt 1: Step budget with escalation (`step-budget`, by playbook)
Cap the agent at 8 steps and escalate to a human, so a stuck tool cannot burn unbounded steps and tokens.

Checkpoint before attempt: `ckpt-008`. Judge: **fixed**. 19/40 → 59/59 on fresh seeds (p=8.1e-11), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 11→12ms (+3%), p95 14→14ms (-1%), steps 5.0→5.0 (+0.0), cost n/a.


## Root cause and fix
Cap the agent at 8 steps and escalate to a human, so a stuck tool cannot burn unbounded steps and tokens.

```diff
diff --git a/targets/refundbot/agent.ts b/targets/refundbot/agent.ts
index f8b5ae1..c3a16ed 100644
--- a/targets/refundbot/agent.ts
+++ b/targets/refundbot/agent.ts
@@ -67,6 +67,8 @@ export async function runRefundBot(
       const tools = createTools(deps.transport, ticket);
       const history: Step[] = [];
       while (true) {
+        // bulwark:step-budget: a stuck tool can't burn unbounded steps and tokens
+        if (history.length >= MAX_STEPS) return { reply: await escalate(tools, ticket), steps: history };
         const decision = await deps.brain.decide({ ticket, history });
         if (decision.type === 'final') return { reply: decision.reply, steps: history };
         let output: unknown;
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 11→12ms (+3%), p95 14→14ms (-1%), steps 5.0→5.0 (+0.0), cost n/a.
Under stuck-pending (informational, not budgeted): p50 189→146ms, avg steps 29.1→6.6.


## Proof the regression test guards the fix
With the fix removed: 18/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
