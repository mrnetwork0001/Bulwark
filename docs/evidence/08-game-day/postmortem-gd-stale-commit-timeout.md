# Postmortem: gd-stale-commit-timeout

**Run** 2026-10-11T16-33-14-751Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
A cached "paid" status on an order refunded at the till, while refunds time out after commit: the idempotency key stops our own double refund but not the one the other channel already made. (stale-order-status@1 + timeout-after-commit@0.5)
