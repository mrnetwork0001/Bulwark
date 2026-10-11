# Postmortem: crustdata-5xx

**Run** 2026-10-11T07-42-15-350Z · **Status** ⏭ skipped (already resilient after earlier fixes in this run)

## Hypothesis
If /person/search has a transient 500, ResearchBot crashes because search_people never retries.

## Weak links found in the code
- `tools.ts:89` search_people never retries person.search when the server fails (5xx)
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched
