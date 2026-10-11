## Bulwark: resilience fixes for researchbot

Bulwark attacked `researchbot` with 12 faults, fixed 6, and verified each fix on fresh seeds with an independent Judge.

| Fault | Before | After | After 95% CI |
|---|---|---|---|
| baseline | 20/20 | 20/20 | 84%–100% |
| crustdata-429 | 6/20 | 20/20 | 84%–100% |
| crustdata-5xx | 8/20 | 20/20 | 84%–100% |
| crustdata-latency | 9/20 | 20/20 | 84%–100% |
| truncated-json | 9/20 | 20/20 | 84%–100% |
| missing-field | 8/20 | 20/20 | 84%–100% |
| empty-people | 11/20 | 20/20 | 84%–100% |
| pagination-loop | 7/20 | 20/20 | 84%–100% |
| stale-company-record | 11/20 | 20/20 | 84%–100% |
| gd-429-truncated | 0/20 | 20/20 | 84%–100% |
| gd-latency-empty | 0/20 | 20/20 | 84%–100% |
| gd-partial-5xx | 0/20 | 20/20 | 84%–100% |
| gd-stale-429 | 0/20 | 20/20 | 84%–100% |

### Fixes
- **missing-field**: Validate the record and ground the brief (attempt 2; 1 rejected and rolled back first). 20/40 → 40/40 on fresh seeds (p=3.9e-8), no regressions. Overhead: happy path p50 39→24ms (-38%), p95 46→27ms (-41%), steps 3.0→3.0 (+0.0), cost n/a.
- **crustdata-429**: Retry, honouring the rate-limit reset header (attempt 2; 1 rejected and rolled back first). 15/40 → 40/40 on fresh seeds (p=1.1e-10), no regressions. Overhead: happy path p50 24→27ms (+11%), p95 27→29ms (+5%), steps 3.0→3.0 (+0.0), cost n/a.
- **crustdata-latency**: Timeout on every Crustdata call. 24/40 → 40/40 on fresh seeds (p=2.3e-6), no regressions. Overhead: happy path p50 27→35ms (+29%), p95 29→37ms (+28%), steps 3.0→3.0 (+0.0), cost n/a.
- **truncated-json**: Validate the body, then retry. 23/40 → 40/40 on fresh seeds (p=8.7e-7), no regressions. Overhead: happy path p50 35→39ms (+14%), p95 37→43ms (+15%), steps 3.0→3.0 (+0.0), cost n/a.
- **pagination-loop**: Cursor cap + dedupe (bounds credits per brief) (attempt 2; 1 rejected and rolled back first). 19/40 → 40/40 on fresh seeds (p=1.3e-8), no regressions. Overhead: happy path p50 39→33ms (-15%), p95 43→37ms (-12%), steps 3.0→3.0 (+0.0), cost n/a.
- **stale-company-record**: Check the record is fresh. 20/40 → 40/40 on fresh seeds (p=3.9e-8), no regressions. Overhead: happy path p50 33→43ms (+28%), p95 37→46ms (+23%), steps 3.0→3.0 (+0.0), cost n/a.
- **empty-people**: no change needed (already resilient after earlier fixes in this run)
- **crustdata-5xx**: no change needed (already resilient after earlier fixes in this run)
- **gd-429-truncated**: no change needed (already resilient after earlier fixes in this run)
- **gd-latency-empty**: no change needed (already resilient after earlier fixes in this run)
- **gd-partial-5xx**: no change needed (already resilient after earlier fixes in this run)
- **gd-stale-429**: no change needed (already resilient after earlier fixes in this run)

### Remaining risk
- `agent.ts:104` the agent loop has no step budget, so a stuck tool means unbounded steps and cost. Every attack now passes, but the weak link is still in the code.

### Provenance
- `targets/researchbot/agent.ts:66`, `targets/researchbot/agent.ts:64`, `targets/researchbot/tools.ts:73`, `targets/researchbot/tools.ts:89`: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

### Evidence
- Each fix ships a chaos regression test in `chaos-tests/`, proven to fail without the fix and pass with it.
- Postmortems: `.bulwark/runs/2026-10-11T16-31-26-812Z/postmortem-*.md`
- Traces: local only (set NEATLOGS_API_KEY to export)
- Run cost: $0.0020 (LLM $0 over 0 calls, compute $0.0020 for 71s; 6200 trials)

<details><summary>Full diff</summary>

```diff
diff --git a/targets/researchbot/agent.ts b/targets/researchbot/agent.ts
index b2cfaaa..7aa03e4 100644
--- a/targets/researchbot/agent.ts
+++ b/targets/researchbot/agent.ts
@@ -4,7 +4,7 @@
 
 import { trace } from 'neatlogs';
 import type { Transport } from './crustdata';
-import { createTools, type ToolName } from './tools';
+import { createTools, type CompanyFacts, type PersonFacts, type ToolName } from './tools';
 
 export interface Ticket {
   id: string;
@@ -57,13 +57,53 @@ export const SYSTEM_PROMPT =
   '"people":[{"name":string,"title":string}] (2-3 people)}. If the company cannot be found, reply ' +
   '{"status":"not found","domain":string}.';
 
+// bulwark:grounded: the brief may only state what a tool returned. It is rebuilt from the tool
+// results: values the API didn't return become null, people the search never returned are dropped
+// (each person once), and no company means an explicit "not found".
+function groundBrief(reply: string, history: Step[]): string {
+  const company = history
+    .filter((s) => s.tool === 'enrich_company')
+    .map((s) => s.output as (Partial<CompanyFacts> & { notFound?: boolean }) | undefined)
+    .at(-1);
+  const asked = history.find((s) => s.tool === 'enrich_company')?.input.domain;
+  const domain = company?.domain ?? (typeof asked === 'string' ? asked : null);
+  if (!company || company.notFound || typeof company.name !== 'string') return JSON.stringify({ status: 'not found', domain });
+  const found = new Map<string, PersonFacts>();
+  for (const s of history) {
+    if (s.tool !== 'search_people' || !Array.isArray(s.output)) continue;
+    for (const p of s.output as PersonFacts[]) if (!found.has(p.name)) found.set(p.name, p);
+  }
+  let claimed: { name?: string }[] = [];
+  try {
+    const brief = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
+    if (Array.isArray(brief.people)) claimed = brief.people;
+  } catch {
+    // not JSON: keep no people rather than guess
+  }
+  const people = [...new Set(claimed.map((p) => p?.name))]
+    .flatMap((name) => {
+      const p = name ? found.get(name) : undefined;
+      return p ? [{ name: p.name, title: p.title }] : [];
+    })
+    .slice(0, 3);
+  return JSON.stringify({
+    status: 'ok',
+    name: company.name,
+    domain: company.domain ?? domain,
+    headcount: company.headcount ?? null,
+    industry: company.industry ?? null,
+    fundingUsd: company.fundingUsd ?? null,
+    people,
+  });
+}
+
 export async function runResearchBot(ticket: Ticket, deps: { transport: Transport; brain: Brain }): Promise<RunResult> {
   return trace({ name: 'researchbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } }, async () => {
     const tools = createTools(deps.transport);
     const history: Step[] = [];
     while (true) {
       const decision = await deps.brain.decide({ ticket, history });
-      if (decision.type === 'final') return { reply: decision.reply, steps: history };
+      if (decision.type === 'final') return { reply: groundBrief(decision.reply, history), steps: history };
       const output = await tools[decision.name](decision.input);
       history.push({ tool: decision.name, input: decision.input, output });
     }
diff --git a/targets/researchbot/chaos-tests/crustdata-429.json b/targets/researchbot/chaos-tests/crustdata-429.json
index e69de29..364d6fb 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/crustdata-429.json
@@ -0,0 +1,7 @@
+{
+  "fault": "crustdata-429",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "retry-after",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/chaos-tests/crustdata-latency.json b/targets/researchbot/chaos-tests/crustdata-latency.json
index e69de29..df589d8 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/crustdata-latency.json
@@ -0,0 +1,7 @@
+{
+  "fault": "crustdata-latency",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "timeout",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/chaos-tests/missing-field.json b/targets/researchbot/chaos-tests/missing-field.json
index e69de29..f6af038 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/missing-field.json
@@ -0,0 +1,7 @@
+{
+  "fault": "missing-field",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "schema-validation+ground-brief",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/chaos-tests/pagination-loop.json b/targets/researchbot/chaos-tests/pagination-loop.json
index e69de29..3d36336 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/pagination-loop.json
@@ -0,0 +1,7 @@
+{
+  "fault": "pagination-loop",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "cursor-cap",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/chaos-tests/stale-company-record.json b/targets/researchbot/chaos-tests/stale-company-record.json
index e69de29..9b15ac8 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/stale-company-record.json
@@ -0,0 +1,7 @@
+{
+  "fault": "stale-company-record",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "fresh-record",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/chaos-tests/truncated-json.json b/targets/researchbot/chaos-tests/truncated-json.json
index e69de29..f7390ee 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/truncated-json.json
@@ -0,0 +1,7 @@
+{
+  "fault": "truncated-json",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "valid-json+retry",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 7f84d43..fa9079d 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -65,32 +65,128 @@ export function peopleQuery(domain: string, limit: number): Record<string, unkno
   };
 }
 
+// bulwark:schema: a missing section becomes null instead of a crash; no match is an explicit "not found"
+function parseCompany(raw: string, domain: string): CompanyFacts | { notFound: true; domain: string } {
+  const body = JSON.parse(raw) as EnrichResponse;
+  const data = Array.isArray(body) ? body[0]?.matches?.[0]?.company_data : undefined;
+  const name = data?.basic_info?.name;
+  if (!data || typeof name !== 'string') return { notFound: true, domain };
+  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
+  const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
+  return {
+    name,
+    domain: str(data.basic_info?.primary_domain) ?? domain,
+    headcount: num(data.headcount?.total),
+    industry: str(data.taxonomy?.professional_network_industry),
+    fundingUsd: num(data.funding?.total_investment_usd),
+  };
+}
+
+const CALL_ATTEMPTS = 4;
+
+// bulwark:retry-transient: 429s, 5xx, timeouts and unreadable bodies are retried; other 4xx are not
+function withRetry(transport: Transport): Transport {
+  return async (endpoint, payload) => {
+    let lastErr: unknown;
+    for (let i = 0; i < CALL_ATTEMPTS; i++) {
+      try {
+        return await transport(endpoint, payload);
+      } catch (err) {
+        lastErr = err;
+        const status = (err as { status?: number }).status;
+        if (status !== undefined && status !== 429 && status < 500) throw err;
+        if (i < CALL_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, retryDelayMs(err, i)));
+      }
+    }
+    throw lastErr;
+  };
+}
+
+function retryDelayMs(err: unknown, attempt: number): number {
+  // bulwark:rate-limit-reset: a 429 says when capacity frees up (x-ratelimit-reset / Retry-After, in seconds); wait that long
+  const headers = (err as { headers?: Record<string, string> }).headers ?? {};
+  const reset = Number(headers['x-ratelimit-reset'] ?? headers['retry-after']);
+  return Number.isFinite(reset) && reset > 0 ? reset * 1000 + 50 : 100 * 2 ** attempt;
+}
+
+const CALL_TIMEOUT_MS = 1500;
+
+// bulwark:call-timeout: no Crustdata call may hang the run
+function withTimeout(transport: Transport, ms: number): Transport {
+  return (endpoint, payload) =>
+    new Promise((resolve, reject) => {
+      const t = setTimeout(() => reject(new Error(`${endpoint} timed out after ${ms}ms`)), ms);
+      transport(endpoint, payload).then(
+        (v) => (clearTimeout(t), resolve(v)),
+        (e) => (clearTimeout(t), reject(e)),
+      );
+    });
+}
+
+// bulwark:valid-json: a cut-off body is a failed call (retried), not something to parse
+function requireJson(transport: Transport): Transport {
+  return async (endpoint, payload) => {
+    const raw = await transport(endpoint, payload);
+    JSON.parse(raw);
+    return raw;
+  };
+}
+
+const MAX_PAGES = 2;
+
+const MAX_RECORD_AGE_DAYS = 180;
+
+// bulwark:fresh-record: a company record last updated more than MAX_RECORD_AGE_DAYS ago came from a stale
+// cache. Fetch it again (the cache revalidates); if it is still stale, drop the headcount it can't vouch for.
+function requireFresh(transport: Transport): Transport {
+  const stale = (raw: string) => {
+    try {
+      const body = JSON.parse(raw) as EnrichResponse;
+      return (Array.isArray(body) ? body : []).some((e) =>
+        (e?.matches ?? []).some((m) => {
+          const updated = Date.parse(String((m?.company_data as { last_updated?: string } | undefined)?.last_updated ?? ''));
+          return Number.isFinite(updated) && Date.now() - updated > MAX_RECORD_AGE_DAYS * 86_400_000;
+        }),
+      );
+    } catch {
+      return false;
+    }
+  };
+  return async (endpoint, payload) => {
+    let raw = await transport(endpoint, payload);
+    if (endpoint !== 'company.enrich' || !stale(raw)) return raw;
+    raw = await transport(endpoint, payload);
+    if (!stale(raw)) return raw;
+    const body = JSON.parse(raw) as EnrichResponse;
+    for (const e of body) for (const m of e.matches ?? []) if (m.company_data) delete m.company_data.headcount;
+    return JSON.stringify(body);
+  };
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
 export function createTools(transport: Transport): Tools {
+  transport = requireFresh(transport);
+  transport = requireJson(transport);
+  transport = withTimeout(transport, CALL_TIMEOUT_MS);
+  transport = withRetry(transport);
   return {
     enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
       const raw = await transport('company.enrich', enrichRequest(String(input.domain)));
-      const company = (JSON.parse(raw) as EnrichResponse)[0].matches[0].company_data;
-      return {
-        name: company.basic_info!.name,
-        domain: company.basic_info!.primary_domain,
-        headcount: company.headcount!.total,
-        industry: company.taxonomy!.professional_network_industry,
-        fundingUsd: company.funding!.total_investment_usd,
-      };
+      return parseCompany(raw, String(input.domain));
     }),
 
     search_people: span({ kind: 'TOOL', name: 'search_people', toolName: 'search_people' }, async (input) => {
       const people: PersonFacts[] = [];
       let cursor: string | null = null;
-      // Collect every page of leaders.
+      let pages = 0;
+      // bulwark:cursor-cap: at most MAX_PAGES pages (each page costs credits), and each person once
       do {
         const raw = await transport('person.search', { ...peopleQuery(String(input.domain), Number(input.limit ?? 3)), ...(cursor ? { cursor } : {}) });
         const page = JSON.parse(raw) as PersonSearchResponse;
-        for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
+        for (const p of page.profiles) if (!people.some((x) => x.id === p.crustdata_person_id)) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
         cursor = page.next_cursor;
-      } while (cursor);
+      } while (cursor && ++pages < MAX_PAGES);
       return people;
     }),
   };
```
</details>

_A human reviews and merges. Bulwark never pushes to main._
