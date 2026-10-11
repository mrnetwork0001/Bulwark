# Postmortem: malformed-response

**Run** 2026-10-11T03-01-09-926Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
If the orders API returns a truncated body, RefundBot crashes because it trusts the JSON.

## Weak links found in the code
- `tools.ts:79` lookup_order trusts the JSON from orders.get without validating it
