# Crustdata and ResearchBot

ResearchBot (`targets/researchbot/`) is Bulwark's second demo target. It is a small research agent that answers "Brief me on `<domain>` and its key decision-makers" with a JSON company brief. It calls the real [Crustdata](https://docs.crustdata.com) API for company and people data. It exists to show that Bulwark is not hard-wired to RefundBot (feature #18). It also brings real-API failure modes: rate limits, empty results, partial records, slow responses, 5xx errors, cut-off bodies and stuck pagination.

## The API (as documented, version 2025-11-01)

| | |
|---|---|
| Base URL | `https://api.crustdata.com` |
| Auth | `authorization: Bearer <CRUSTDATA_API_KEY>`, plus `x-api-version: 2025-11-01` and `content-type: application/json` |
| Errors | `400` invalid request, `401` bad key, `402` out of credits (terminal, never retry), `403` endpoint not enabled, `404`, `429` rate limited, `500` "try again later". The body is `{"error":{"type","message","metadata"}}`. |
| Rate limits | Per endpoint, per key, on a sliding window. `/company/enrich` allows 15 RPM and `/person/search` allows 30 RPM. Every response carries `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` (seconds until capacity frees up). On a 429, the docs say to wait `x-ratelimit-reset` seconds before retrying. |
| Cost | Every response carries `x-credits-used`. Free endpoints: `GET /account/credits`, `GET /account/endpoints` (your prices and limits), `/company/identify`, and autocomplete. |

### What ResearchBot calls

**`POST /company/enrich`**: tool `enrich_company`, endpoint `company.enrich`

```json
{ "domains": ["retool.com"], "fields": ["basic_info", "headcount", "funding", "taxonomy"] }
```

The response is a top-level array with one entry per identifier: `[{ matched_on, match_type, matches: [{ confidence_score, company_data }] }]`. `matches` is empty when nothing matched (200, not 404). The brief reads `basic_info.name`, `basic_info.primary_domain`, `headcount.total`, `taxonomy.professional_network_industry` and `funding.total_investment_usd`. The price list says 2 credits per record whatever sections you ask for, except `technographics`, which costs +2. In practice notion.so cost 6 credits: it matched 3 records.

**`POST /person/search`**: tool `search_people`, endpoint `person.search`

```json
{
  "filters": { "op": "and", "conditions": [
    { "field": "experience.employment_details.current.company_website_domain", "type": "=", "value": "retool.com" },
    { "field": "experience.employment_details.current.seniority_level", "type": "in", "value": ["CXO", "Vice President"] } ] },
  "fields": ["basic_profile.name", "basic_profile.current_title"],
  "sorts": [{ "field": "crustdata_person_id", "order": "asc" }],
  "limit": 3
}
```

The response is `{ profiles: [{ crustdata_person_id, basic_profile: { name, current_title } }], next_cursor, total_count }`. Send `next_cursor` back as `cursor` to get the next page. Each result costs 0.03 credits, plus 0.1 for filtering on the experience group. Requesting only basic-profile fields adds nothing. That makes 0.39 credits for 3 people, which matches the `x-credits-used: 0.39` we measured.

There is no separate news endpoint. News is a `fields` group on company enrich, so ResearchBot doesn't need a `get_company_news` tool.

## Credit cost

| | Credits |
|---|---|
| One real ResearchBot brief (1 enrich + 1 search page) | **2.39** (measured: 2 + 0.39) |
| Recording all four cassettes (retool.com, stripe.com, figma.com, notion.so) | **13.17** in total, over two record runs (2.39 + 10.78, summed from `x-credits-used`; the balance went from 5191.30 to 5178.13) |
| Every chaos trial, Judge run, replay and test | **0**. They replay the cassettes |

The hackathon budget is 5,000 credits. Bulwark spends credits only when you explicitly re-record.

## How Bulwark uses it: record once, replay forever

`CrustdataCassette` (`targets/researchbot/crustdata.ts`) is ResearchBot's sandbox, the equivalent of RefundBot's payments sandbox.

- **Record mode** (`npm run record:crustdata -- --record`) runs only with `CRUSTDATA_API_KEY` set and the explicit `--record` flag. It sends the exact requests ResearchBot sends (`enrichRequest`, `peopleQuery` from `tools.ts`) for a few well-known companies. It saves the real responses, status codes and `x-credits-used` to `targets/researchbot/cassettes/<domain>.json` and checks the balance before and after via the free `/account/credits` endpoint. A `--max-credits` cap (default 40) stops it early. Companies already recorded are kept, not re-bought (use `--force` to re-record). The script warns when a company lacks a field the brief needs; notion.so comes back with no leaders and no funding, a real empty case.
- **Replay mode** (every trial) serves the recorded responses by request key: endpoint plus canonical JSON, so field order doesn't matter. It compresses latency to about 2ms. A request with no recording is answered the way the API answers no match: empty `matches`, no profiles, and a cursor past the recorded pages ends pagination. It charges 0 credits.
- **The ledger**: every call goes into `sandbox.calls` with its request, status, real `creditsUsed` and response. It is exposed to Bulwark as the effect key `apiCalls`, which is how the rules are checked:
  - *Every brief cites only data returned by the API.* Each fact in the brief must equal a value in an enrich or search response in the ledger. The ledger records what the server sent, before any fault.
  - *Never report a person without a source record.* Every person named must appear in a `/person/search` response.
  - *Never spend more than 5 API credits per brief.* Sum of `creditsUsed`.
- `manifest.json` says whether the cassettes are real (`"synthetic": false`, as committed) or hand-written, which company the demo ticket asks about (`primary`), and the credits spent recording.

The cassettes hold public company data (Crustdata responses for retool.com, stripe.com, figma.com and notion.so) and are committed. The API key is never written anywhere but `.env`.

## ResearchBot's fault catalog (`bulwark/chaos/research.ts`)

| Fault | Kind | What happens on the wire | What breaks | Winning fix (playbook) |
|---|---|---|---|---|
| `crustdata-429` | rate-limit | `/company/enrich` returns 429 with `x-ratelimit-reset: 2` for a 2s window | no retry, so it crashes. A 100/200/400ms backoff retries inside the window and is **rejected** | retry that waits `x-ratelimit-reset` (or `retry-after`) |
| `crustdata-5xx` | server-error | one 500 on `/person/search` | no retry, so it crashes | retry transient errors with backoff (4xx are not retried) |
| `crustdata-latency` | latency | `/company/enrich` answers after 10s (billed) | no timeout, so it hangs | 1.5s timeout per call, then retry |
| `truncated-json` | malformed | `/person/search` body cut in half | trusts the JSON, so it crashes. A plain retry never sees it and is **rejected** | validate the body at the transport, then retry |
| `missing-field` | partial | company record without `headcount` | `TypeError`. Once guarded, the model **guesses** a headcount, so schema validation alone is **rejected** | schema validation plus a grounded brief |
| `empty-people` | empty | `/person/search` finds nobody | the model **invents** decision-makers. Retrying the search is **rejected** | grounded brief (only people the API returned) |
| `pagination-loop` | loop | server ignores `cursor`, always page 1 plus a `next_cursor` | unbounded paging: about 2,000 calls and 800+ credits in 5s, hung. A step budget is **rejected** (the loop is inside one tool call) | cursor cap (2 pages) plus dedupe |

Before → after (playbook fixer, offline, `--no-memory`): **49% → 100%**, 8 attempts, 3 rejected and rolled back. See [evidence/06-researchbot](evidence/06-researchbot/).
