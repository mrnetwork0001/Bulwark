# Postmortem: rate-limit

**Run** 2026-10-11T03-01-09-926Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
If the orders API rate-limits, RefundBot crashes because lookup_order never retries.

## Weak links found in the code
- `tools.ts:79` lookup_order never retries orders.get on transient errors
