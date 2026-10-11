# Postmortem: rate-limit

**Run** 2026-10-11T23-39-54-112Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
If the orders API rate-limits, RefundBot crashes because lookup_order never retries.

## Weak links found in the code
- `tools.ts:79` lookup_order never retries orders.get on transient errors
  - Blast radius (Entire Graph): createTools (function, targets/refundbot/tools.ts:76) ← 1 caller: runRefundBot (targets/refundbot/agent.ts:54)
  - Provenance: introduced in `cf0ceac`, 2026-10-10 by Claude Code session `8cdad8b4`, prompt "start building something for this app" (Entire checkpoint `01M4JHF2GWEP2029BVPZ8A9WQ1`, matched in the imported transcript; the commit predates Entire trailers)
