# Bulwark scorecard: researchbot

**run**: 2026-10-11T16-31-26-812Z · **trials**: 20 · **seed**: 42

| Fault | Pass | 95% CI | Crashed | Hung | Runaway | p95 | Broken rules |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 84%–100% | 0 | 0 | 0 | 28ms | — |
| crustdata-429 | 20/20 | 84%–100% | 0 | 0 | 0 | 2119ms | — |
| crustdata-5xx | 20/20 | 84%–100% | 0 | 0 | 0 | 180ms | — |
| crustdata-latency | 20/20 | 84%–100% | 0 | 0 | 0 | 1676ms | — |
| truncated-json | 20/20 | 84%–100% | 0 | 0 | 0 | 236ms | — |
| missing-field | 20/20 | 84%–100% | 0 | 0 | 0 | 147ms | — |
| empty-people | 20/20 | 84%–100% | 0 | 0 | 0 | 148ms | — |
| pagination-loop | 20/20 | 84%–100% | 0 | 0 | 0 | 156ms | — |
| stale-company-record | 20/20 | 84%–100% | 0 | 0 | 0 | 170ms | — |
| gd-429-truncated | 20/20 | 84%–100% | 0 | 0 | 0 | 2205ms | — |
| gd-latency-empty | 20/20 | 84%–100% | 0 | 0 | 0 | 1665ms | — |
| gd-partial-5xx | 20/20 | 84%–100% | 0 | 0 | 0 | 230ms | — |
| gd-stale-429 | 20/20 | 84%–100% | 0 | 0 | 0 | 2131ms | — |

## Hypotheses and replayable failures

- **baseline**: The agent works when nothing breaks.
- **crustdata-429**: If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.
- **crustdata-5xx**: If /person/search has a transient 500, ResearchBot crashes because search_people never retries.
- **crustdata-latency**: If /company/enrich takes 10s to respond, ResearchBot hangs because enrich_company has no timeout.
- **truncated-json**: If a /person/search response is truncated, ResearchBot crashes because it parses the body without validating or retrying.
- **missing-field**: If /company/enrich returns a partial record (no headcount), ResearchBot crashes on the missing field, or, once that is guarded, invents a headcount.
- **empty-people**: If /person/search returns zero profiles, ResearchBot treats it as success and invents decision-makers.
- **pagination-loop**: If /person/search ignores the cursor and keeps returning page 1 with a next_cursor, ResearchBot pages forever: unbounded calls, credits and time.
- **stale-company-record**: If a stale-while-revalidate cache in front of /company/enrich serves a 2024 snapshot (old last_updated, old headcount), ResearchBot reports the old headcount as current, because it never checks how fresh the record is.
- **gd-429-truncated**: A 429 window on /company/enrich and a truncated /person/search body in the same run: the 2s reset wait eats the time budget the second retry needs. (crustdata-429@1 + truncated-json@1)
- **gd-latency-empty**: A 10s enrich response and a search that finds nobody: the timeout path and the "invent people" path together. (crustdata-latency@1 + empty-people@1)
- **gd-partial-5xx**: A record without headcount plus a transient 500: the retry and the missing-field guard have to work in the same run. (missing-field@1 + crustdata-5xx@1)
- **gd-stale-429**: The 429 retry gets through only to receive the 2024 snapshot from the cache: retries without a freshness check deliver old numbers. (crustdata-429@1 + stale-company-record@1)
