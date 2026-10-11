# Postmortem: gd-latency-empty

**Run** 2026-10-11T16-31-26-812Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
A 10s enrich response and a search that finds nobody: the timeout path and the "invent people" path together. (crustdata-latency@1 + empty-people@1)
