# Bulwark scorecard: researchbot

**run**: 2026-10-11T23-15-42-880Z · **trials**: 20 · **seed**: 42

| Fault | Pass | 95% CI | Crashed | Hung | Runaway | p95 | Broken rules |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 84%–100% | 0 | 0 | 0 | 32ms | — |
| crustdata-429 | 6/20 | 15%–52% | 14 | 0 | 0 | 120ms | Every ticket gets a brief or an explicit 'not found'. (14) |
| crustdata-5xx | 8/20 | 22%–61% | 12 | 0 | 0 | 127ms | Every ticket gets a brief or an explicit 'not found'. (12) |
| crustdata-latency | 9/20 | 26%–66% | 0 | 11 | 0 | 5002ms | Every ticket gets a brief or an explicit 'not found'. (11)<br>A run finishes within 5 seconds. (11) |
| truncated-json | 9/20 | 26%–66% | 11 | 0 | 0 | 147ms | Every ticket gets a brief or an explicit 'not found'. (11) |
| missing-field | 8/20 | 22%–61% | 12 | 0 | 0 | 148ms | Every ticket gets a brief or an explicit 'not found'. (12) |
| empty-people | 11/20 | 34%–74% | 0 | 0 | 0 | 147ms | Never report a person without a source record. (9) |
| pagination-loop | 7/20 | 18%–57% | 0 | 13 | 0 | 5021ms | Every ticket gets a brief or an explicit 'not found'. (13)<br>A run finishes within 5 seconds. (13)<br>Never spend more than 5 API credits per brief. (13)<br>Never call the same API endpoint more than 20 times in one run. (13) |

## Hypotheses and replayable failures

- **baseline**: The agent works when nothing breaks.
- **crustdata-429**: If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 3642061396)
- **crustdata-5xx**: If /person/search has a transient 500, ResearchBot crashes because search_people never retries.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 49171444)
- **crustdata-latency**: If /company/enrich takes 10s to respond, ResearchBot hangs because enrich_company has no timeout.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run hung, no brief (seed 1619923452)
  - ✗ A run finishes within 5 seconds. → took 5000ms (limit 5000ms) (seed 1619923452)
- **truncated-json**: If a /person/search response is truncated, ResearchBot crashes because it parses the body without validating or retrying.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 3919219796)
- **missing-field**: If /company/enrich returns a partial record (no headcount), ResearchBot crashes on the missing field, or, once that is guarded, invents a headcount.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 303253422)
- **empty-people**: If /person/search returns zero profiles, ResearchBot treats it as success and invents decision-makers.
  - ✗ Never report a person without a source record. → no source record for "Alex Morgan", "Priya Shah" (person.search returned 0 people) (seed 2283140009)
- **pagination-loop**: If /person/search ignores the cursor and keeps returning page 1 with a next_cursor, ResearchBot pages forever: unbounded calls, credits and time.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run hung, no brief (seed 1792856198)
  - ✗ A run finishes within 5 seconds. → took 5000ms (limit 5000ms) (seed 1792856198)
  - ✗ Never spend more than 5 API credits per brief. → spent 619.76 credits over 1585 API calls (limit 5) (seed 1792856198)
  - ✗ Never call the same API endpoint more than 20 times in one run. → endpoint "person.search": the number of apiCalls per endpoint <= 20 fails (1584 vs 20) (seed 1792856198)
