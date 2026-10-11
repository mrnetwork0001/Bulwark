# Postmortem: empty-people

**Run** 2026-10-11T07-42-15-350Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
If /person/search returns zero profiles, ResearchBot treats it as success and invents decision-makers.

## Weak links found in the code
- `agent.ts:66` the model's final answer is returned unchecked, so when a tool returns nothing (or a field is missing) it can invent people and numbers
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched
