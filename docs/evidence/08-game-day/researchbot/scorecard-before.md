# Bulwark scorecard: researchbot

**run**: 2026-10-11T16-31-26-812Z · **trials**: 20 · **seed**: 42

| Fault | Pass | 95% CI | Crashed | Hung | Runaway | p95 | Broken rules |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 84%–100% | 0 | 0 | 0 | 31ms | — |
| crustdata-429 | 6/20 | 15%–52% | 14 | 0 | 0 | 147ms | Every ticket gets a brief or an explicit 'not found'. (14) |
| crustdata-5xx | 8/20 | 22%–61% | 12 | 0 | 0 | 154ms | Every ticket gets a brief or an explicit 'not found'. (12) |
| crustdata-latency | 9/20 | 26%–66% | 0 | 11 | 0 | 5004ms | Every ticket gets a brief or an explicit 'not found'. (11)<br>A run finishes within 5 seconds. (11) |
| truncated-json | 9/20 | 26%–66% | 11 | 0 | 0 | 168ms | Every ticket gets a brief or an explicit 'not found'. (11) |
| missing-field | 8/20 | 22%–61% | 12 | 0 | 0 | 170ms | Every ticket gets a brief or an explicit 'not found'. (12) |
| empty-people | 11/20 | 34%–74% | 0 | 0 | 0 | 171ms | Never report a person without a source record. (9) |
| pagination-loop | 7/20 | 18%–57% | 0 | 13 | 0 | 5003ms | Every ticket gets a brief or an explicit 'not found'. (13)<br>A run finishes within 5 seconds. (13)<br>Never spend more than 5 API credits per brief. (13) |
| stale-company-record | 11/20 | 34%–74% | 0 | 0 | 0 | 180ms | Every brief cites only data returned by the API. (9) |
| gd-429-truncated | 0/20 | 0%–16% | 20 | 0 | 0 | 50ms | Every ticket gets a brief or an explicit 'not found'. (20) |
| gd-latency-empty | 0/20 | 0%–16% | 0 | 20 | 0 | 5038ms | Every ticket gets a brief or an explicit 'not found'. (20)<br>A run finishes within 5 seconds. (20) |
| gd-partial-5xx | 0/20 | 0%–16% | 20 | 0 | 0 | 134ms | Every ticket gets a brief or an explicit 'not found'. (20) |
| gd-stale-429 | 0/20 | 0%–16% | 20 | 0 | 0 | 48ms | Every ticket gets a brief or an explicit 'not found'. (20) |

## Hypotheses and replayable failures

- **baseline**: The agent works when nothing breaks.
- **crustdata-429**: If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 3675616634)
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
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run hung, no brief (seed 1776078579)
  - ✗ A run finishes within 5 seconds. → took 5002ms (limit 5000ms) (seed 1776078579)
  - ✗ Never spend more than 5 API credits per brief. → spent 819.44 credits over 2097 API calls (limit 5) (seed 1776078579)
- **stale-company-record**: If a stale-while-revalidate cache in front of /company/enrich serves a 2024 snapshot (old last_updated, old headcount), ResearchBot reports the old headcount as current, because it never checks how fresh the record is.
  - ✗ Every brief cites only data returned by the API. → headcount 250 is not in any API response (API returned [416]) (seed 3772333194)
- **gd-429-truncated**: A 429 window on /company/enrich and a truncated /person/search body in the same run: the 2s reset wait eats the time budget the second retry needs. (crustdata-429@1 + truncated-json@1)
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 1677956767)
- **gd-latency-empty**: A 10s enrich response and a search that finds nobody: the timeout path and the "invent people" path together. (crustdata-latency@1 + empty-people@1)
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run hung, no brief (seed 2276265549)
  - ✗ A run finishes within 5 seconds. → took 5030ms (limit 5000ms) (seed 2276265549)
- **gd-partial-5xx**: A record without headcount plus a transient 500: the retry and the missing-field guard have to work in the same run. (missing-field@1 + crustdata-5xx@1)
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 4081931968)
- **gd-stale-429**: The 429 retry gets through only to receive the 2024 snapshot from the cache: retries without a freshness check deliver old numbers. (crustdata-429@1 + stale-company-record@1)
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 2921521876)
