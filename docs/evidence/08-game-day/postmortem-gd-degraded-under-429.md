# Postmortem: gd-degraded-under-429

**Run** 2026-10-11T16-33-14-751Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
The provider downgrades the model during a 429 storm: a sloppy model on a flaky API is where model-judgment rules break first. (model-degradation@1 + rate-limit@0.4)
