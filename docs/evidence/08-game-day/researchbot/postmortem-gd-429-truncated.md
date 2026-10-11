# Postmortem: gd-429-truncated

**Run** 2026-10-11T16-31-26-812Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
A 429 window on /company/enrich and a truncated /person/search body in the same run: the 2s reset wait eats the time budget the second retry needs. (crustdata-429@1 + truncated-json@1)
