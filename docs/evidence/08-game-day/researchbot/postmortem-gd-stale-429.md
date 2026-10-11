# Postmortem: gd-stale-429

**Run** 2026-10-11T16-31-26-812Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
The 429 retry gets through only to receive the 2024 snapshot from the cache: retries without a freshness check deliver old numbers. (crustdata-429@1 + stale-company-record@1)
