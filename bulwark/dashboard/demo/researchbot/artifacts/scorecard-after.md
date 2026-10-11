# Bulwark scorecard: researchbot

**run**: 2026-10-11T23-15-42-880Z · **trials**: 20 · **seed**: 42

| Fault | Pass | 95% CI | Crashed | Hung | Runaway | p95 | Broken rules |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 84%–100% | 0 | 0 | 0 | 25ms | — |
| crustdata-429 | 20/20 | 84%–100% | 0 | 0 | 0 | 53ms | — |
| crustdata-5xx | 20/20 | 84%–100% | 0 | 0 | 0 | 58ms | — |
| crustdata-latency | 20/20 | 84%–100% | 0 | 0 | 0 | 96ms | — |
| truncated-json | 20/20 | 84%–100% | 0 | 0 | 0 | 69ms | — |
| missing-field | 20/20 | 84%–100% | 0 | 0 | 0 | 75ms | — |
| empty-people | 20/20 | 84%–100% | 0 | 0 | 0 | 75ms | — |
| pagination-loop | 20/20 | 84%–100% | 0 | 0 | 0 | 83ms | — |

## Hypotheses and replayable failures

- **baseline**: The agent works when nothing breaks.
- **crustdata-429**: If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.
- **crustdata-5xx**: If /person/search has a transient 500, ResearchBot crashes because search_people never retries.
- **crustdata-latency**: If /company/enrich takes 10s to respond, ResearchBot hangs because enrich_company has no timeout.
- **truncated-json**: If a /person/search response is truncated, ResearchBot crashes because it parses the body without validating or retrying.
- **missing-field**: If /company/enrich returns a partial record (no headcount), ResearchBot crashes on the missing field, or, once that is guarded, invents a headcount.
- **empty-people**: If /person/search returns zero profiles, ResearchBot treats it as success and invents decision-makers.
- **pagination-loop**: If /person/search ignores the cursor and keeps returning page 1 with a next_cursor, ResearchBot pages forever: unbounded calls, credits and time.
