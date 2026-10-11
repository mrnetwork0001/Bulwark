# Postmortem: gd-partial-5xx

**Run** 2026-10-11T16-31-26-812Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
A record without headcount plus a transient 500: the retry and the missing-field guard have to work in the same run. (missing-field@1 + crustdata-5xx@1)
