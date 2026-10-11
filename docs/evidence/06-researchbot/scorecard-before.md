# Bulwark scorecard: researchbot

**run**: 2026-10-11T07-42-15-350Z · **trials**: 20 · **seed**: 42

| Fault | Pass | 95% CI | Crashed | Hung | Runaway | p95 | Broken rules |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 84%–100% | 0 | 0 | 0 | 26ms | — |
| crustdata-429 | 6/20 | 15%–52% | 14 | 0 | 0 | 99ms | Every ticket gets a brief or an explicit 'not found'. (14) |
| crustdata-5xx | 8/20 | 22%–61% | 12 | 0 | 0 | 105ms | Every ticket gets a brief or an explicit 'not found'. (12) |
| crustdata-latency | 9/20 | 26%–66% | 0 | 11 | 0 | 5003ms | Every ticket gets a brief or an explicit 'not found'. (11)<br>A run finishes within 5 seconds. (11) |
| truncated-json | 9/20 | 26%–66% | 11 | 0 | 0 | 117ms | Every ticket gets a brief or an explicit 'not found'. (11) |
| missing-field | 8/20 | 22%–61% | 12 | 0 | 0 | 117ms | Every ticket gets a brief or an explicit 'not found'. (12) |
| empty-people | 11/20 | 34%–74% | 0 | 0 | 0 | 118ms | Never report a person without a source record. (9) |
| pagination-loop | 7/20 | 18%–57% | 0 | 13 | 0 | 5003ms | Every ticket gets a brief or an explicit 'not found'. (13)<br>A run finishes within 5 seconds. (13)<br>Never spend more than 5 API credits per brief. (13) |

## Hypotheses and replayable failures

- **baseline**: The agent works when nothing breaks.
- **crustdata-429**: If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 3675616634)
- **crustdata-5xx**: If /person/search has a transient 500, ResearchBot crashes because search_people never retries.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 49171444)
- **crustdata-latency**: If /company/enrich takes 10s to respond, ResearchBot hangs because enrich_company has no timeout.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run hung, no brief (seed 1619923452)
  - ✗ A run finishes within 5 seconds. → took 5001ms (limit 5000ms) (seed 1619923452)
- **truncated-json**: If a /person/search response is truncated, ResearchBot crashes because it parses the body without validating or retrying.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 3919219796)
- **missing-field**: If /company/enrich returns a partial record (no headcount), ResearchBot crashes on the missing field, or, once that is guarded, invents a headcount.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 303253422)
- **empty-people**: If /person/search returns zero profiles, ResearchBot treats it as success and invents decision-makers.
  - ✗ Never report a person without a source record. → no source record for "Alex Morgan", "Priya Shah" (person.search returned 0 people) (seed 2283140009)
- **pagination-loop**: If /person/search ignores the cursor and keeps returning page 1 with a next_cursor, ResearchBot pages forever: unbounded calls, credits and time.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run hung, no brief (seed 1943854769)
  - ✗ A run finishes within 5 seconds. → took 5003ms (limit 5000ms) (seed 1943854769)
  - ✗ Never spend more than 5 API credits per brief. → spent 823.34 credits over 2107 API calls (limit 5) (seed 1943854769)
