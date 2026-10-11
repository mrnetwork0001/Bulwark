# Postmortem: gd-429-during-commit-timeout

**Run** 2026-10-11T16-33-14-751Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
A 429 storm on order lookups during a refund timeout-after-commit: the retries for one fault multiply the other, so a run that survives each fault alone runs out of attempts or time. (rate-limit@0.4 + timeout-after-commit@0.5)
