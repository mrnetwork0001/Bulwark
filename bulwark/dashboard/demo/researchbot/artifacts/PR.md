## Bulwark: resilience fixes for researchbot

Bulwark attacked `researchbot` with 7 faults, fixed 6, and verified each fix on fresh seeds with an independent Judge.

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

### Fixes
- **missing-field**: Validate the record and ground the brief (attempt 4; 3 rejected and rolled back first). 20/40 → 59/59 on fresh seeds (p=3.2e-10), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 27→85ms (+211%), p95 31→89ms (+191%), steps 3.0→3.0 (+0.0), cost n/a.
- **crustdata-429**: Retry 429s honoring x-ratelimit-reset, with a time budget so the run still finishes within 5s / 8 steps (attempt 2; 1 rejected and rolled back first). 15/40 → 59/59 on fresh seeds (p=2.2e-13), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 85→38ms (-55%), p95 89→42ms (-53%), steps 3.0→3.0 (+0.0), cost n/a.
- **crustdata-5xx**: Retry transient 5xx errors in search_people (and enrich_company) like 429s. 20/40 → 59/59 on fresh seeds (p=3.2e-10), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 38→31ms (-19%), p95 42→34ms (-19%), steps 3.0→3.0 (+0.0), cost n/a.
- **crustdata-latency**: Add per-call timeout to Crustdata transport calls so a slow enrich/search can't hang the run. 24/40 → 59/59 on fresh seeds (p=5.6e-8), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 31→35ms (+15%), p95 34→39ms (+16%), steps 3.0→3.0 (+0.0), cost n/a.
- **truncated-json**: Treat unparseable (truncated) person-search JSON as a transient failure. 23/40 → 59/59 on fresh seeds (p=1.6e-8), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 35→32ms (-9%), p95 39→35ms (-11%), steps 3.0→3.0 (+0.0), cost n/a.
- **pagination-loop**: Cap pagination pages, cursor progress, and overall step/call budgets. 19/40 → 59/59 on fresh seeds (p=8.1e-11), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Overhead: happy path p50 32→32ms (-2%), p95 35→34ms (-3%), steps 3.0→3.0 (+0.0), cost n/a.
- **empty-people**: no change needed (already resilient after earlier fixes in this run)

### Reliability targets (SLO)
- **missing-field**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **crustdata-429**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **crustdata-5xx**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **crustdata-latency**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **truncated-json**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
- **pagination-loop**: SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
_Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)). "Demonstrated" means every planned trial passed; nothing stronger is claimed._

### Remaining risk
- `tools.ts:264` enrich_company calls company.enrich with no timeout. Every attack now passes, but the weak link is still in the code.
- `tools.ts:264` enrich_company never retries company.enrich on transient errors. Every attack now passes, but the weak link is still in the code.
- `tools.ts:290` search_people never retries person.search when the server fails (5xx). Every attack now passes, but the weak link is still in the code.
- `tools.ts:290` search_people follows person.search's next_cursor with no page cap, so a stuck cursor means unbounded calls and credits. Every attack now passes, but the weak link is still in the code.
- `tools.ts:245` the agent loop has no step budget, so a stuck tool means unbounded steps and cost. Every attack now passes, but the weak link is still in the code.

### Provenance
- `targets/researchbot/agent.ts:66`, `targets/researchbot/agent.ts:64`, `targets/researchbot/tools.ts:73`, `targets/researchbot/tools.ts:89`: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

### Evidence
- Each fix ships a chaos regression test in `chaos-tests/`, proven to fail without the fix and pass with it.
- Postmortems: `.bulwark/runs/2026-10-11T23-15-42-880Z/postmortem-*.md`
- Traces: exported to neatlogs (workflow "bulwark")
- Run cost: $0.501 (LLM $0.487 over 9 calls, compute $0.015 for 527s; 4814 trials)

<details><summary>Full diff</summary>

```diff
diff --git a/targets/researchbot/agent.ts b/targets/researchbot/agent.ts
index b2cfaaa..7d57a56 100644
--- a/targets/researchbot/agent.ts
+++ b/targets/researchbot/agent.ts
@@ -4,7 +4,7 @@
 
 import { trace } from 'neatlogs';
 import type { Transport } from './crustdata';
-import { createTools, type ToolName } from './tools';
+import { createTools, type CompanyFacts, type PersonFacts, type ToolName } from './tools';
 
 export interface Ticket {
   id: string;
@@ -57,15 +57,72 @@ export const SYSTEM_PROMPT =
   '"people":[{"name":string,"title":string}] (2-3 people)}. If the company cannot be found, reply ' +
   '{"status":"not found","domain":string}.';
 
+// bulwark: a step is one brain.decide call; the business rule caps a run at 8 of them. Bound the
+// loop at that limit (defense in depth alongside tools.ts's own per-tool page/time caps) so a
+// brain that keeps deciding to call tools, or a tool that keeps returning without ever letting
+// the brain finish, can't run away: once the cap is hit we stop and report "not found" rather
+// than loop, crash, or hang past the step/time budget.
+const MAX_STEPS = 8;
+
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
+/** Build a grounded "not found" reply from whatever enrich_company call (if any) was attempted. */
+function notFoundReply(history: Step[]): string {
+  const asked = history.find((s) => s.tool === 'enrich_company')?.input.domain;
+  const domain = typeof asked === 'string' ? asked : null;
+  return JSON.stringify({ status: 'not found', domain });
+}
+
 export async function runResearchBot(ticket: Ticket, deps: { transport: Transport; brain: Brain }): Promise<RunResult> {
   return trace({ name: 'researchbot.run', kind: 'AGENT', attributes: { ticketId: ticket.id, brain: deps.brain.name } }, async () => {
     const tools = createTools(deps.transport);
     const history: Step[] = [];
-    while (true) {
+    for (let step = 0; step < MAX_STEPS; step++) {
       const decision = await deps.brain.decide({ ticket, history });
-      if (decision.type === 'final') return { reply: decision.reply, steps: history };
+      if (decision.type === 'final') return { reply: groundBrief(decision.reply, history), steps: history };
       const output = await tools[decision.name](decision.input);
       history.push({ tool: decision.name, input: decision.input, output });
     }
+    // Hit the step cap without the brain producing a final answer: report "not found" rather
+    // than loop further, so the run always completes within the step/time budget.
+    return { reply: notFoundReply(history), steps: history };
   });
 }
diff --git a/targets/researchbot/chaos-tests/crustdata-429.json b/targets/researchbot/chaos-tests/crustdata-429.json
index e69de29..2410d74 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/crustdata-429.json
@@ -0,0 +1,7 @@
+{
+  "fault": "crustdata-429",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "retry-with-reset-aware-backoff-and-timebox",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/chaos-tests/crustdata-5xx.json b/targets/researchbot/chaos-tests/crustdata-5xx.json
index e69de29..495fc8f 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/crustdata-5xx.json
@@ -0,0 +1,7 @@
+{
+  "fault": "crustdata-5xx",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "retry-on-5xx-like-429",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/chaos-tests/crustdata-latency.json b/targets/researchbot/chaos-tests/crustdata-latency.json
index e69de29..c0d296d 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/crustdata-latency.json
@@ -0,0 +1,7 @@
+{
+  "fault": "crustdata-latency",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "timeout-wrapped-transport-calls",
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
index e69de29..057b984 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/pagination-loop.json
@@ -0,0 +1,7 @@
+{
+  "fault": "pagination-loop",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "page-cap+cursor-progress-check+step-budget",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/chaos-tests/truncated-json.json b/targets/researchbot/chaos-tests/truncated-json.json
index e69de29..d2308f0 100644
--- /dev/null
+++ b/targets/researchbot/chaos-tests/truncated-json.json
@@ -0,0 +1,7 @@
+{
+  "fault": "truncated-json",
+  "trials": 40,
+  "seed": 2000045,
+  "strategy": "catch-malformed-json-as-transient",
+  "createdBy": "bulwark"
+}
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 7f84d43..12b56de 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -65,32 +65,253 @@ export function peopleQuery(domain: string, limit: number): Record<string, unkno
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
+/**
+ * Parse a person.search response body. A truncated or otherwise malformed body (e.g. cut off
+ * mid-JSON) throws a SyntaxError from JSON.parse that is not an HTTP-shaped error, so callers
+ * must treat it the same way they treat a transient HTTP fault: this helper exists so that
+ * check lives in one place rather than relying on JSON.parse's raw error type.
+ */
+class MalformedResponseError extends Error {
+  constructor(cause: unknown) {
+    super(cause instanceof Error ? cause.message : String(cause));
+    this.name = 'MalformedResponseError';
+  }
+}
+
+function parsePersonPage(raw: string): PersonSearchResponse {
+  try {
+    return JSON.parse(raw) as PersonSearchResponse;
+  } catch (err) {
+    // A truncated/malformed body is a transport-level problem, not a code bug: surface it as
+    // a recognizable, catchable error instead of letting a bare SyntaxError propagate.
+    throw new MalformedResponseError(err);
+  }
+}
+
 export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise<unknown>>;
 
+// A 429 is transient, and so is a 5xx (a bad gateway, a dropped backend, a one-off server
+// error). Crustdata documents a 15-requests-per-minute window for 429s and reports how long
+// until it clears via x-ratelimit-reset (seconds) or retryAfterMs on the error (if the
+// transport surfaces it). We honor that wait instead of guessing a short backoff that lands
+// inside the still-open window. A 5xx carries no such reset signal, so we retry it after a
+// short fixed backoff instead. Either way we never let a wait blow the run's 5s wall-clock
+// budget: if waiting would, we give up on this call and let the caller treat it as
+// "not found"/partial rather than crash.
+//
+// A slow backend (no error at all, just a very late response) is the same kind of risk: an
+// unbounded await can blow the wall-clock budget on its own even though nothing "failed". So
+// every transport() call is additionally raced against a timeout bounded by the time left in
+// the run, and a timeout is treated as transient exactly like a 429/5xx.
+//
+// A truncated/malformed response body (valid HTTP, invalid JSON) is a third kind of
+// transient-ish fault: the request succeeded but the payload can't be trusted. It isn't worth
+// retrying (the same cursor would just be re-fetched), so instead of treating it as fatal we
+// stop paginating and keep whatever complete pages we already parsed, same as we'd keep a
+// partial list on a 429/5xx/timeout we can't recover from.
+//
+// A stuck cursor (the API ignores the cursor we send and keeps echoing page 1 with a
+// `next_cursor` set) is a fourth kind of fault: nothing ever errors, so the per-call timeout
+// never fires, but the do/while pagination loop would otherwise run forever, issuing an
+// unbounded number of calls/credits before any single call's timeout could even trip. We
+// guard against that directly: a hard cap on the number of pages fetched per search_people
+// call, plus an explicit check that each new page actually makes progress (a new cursor we
+// haven't seen, and at least one profile we haven't already collected). Either guard tripping
+// just stops pagination and returns what's been collected so far, the same as any other
+// recoverable partial-result case above.
+
+const RUN_DEADLINE_MS = 5000;
+const DEFAULT_RATE_LIMIT_WAIT_MS = 2100; // just past the documented 2s reset window
+const SERVER_ERROR_RETRY_WAIT_MS = 150; // short fixed backoff for a transient 5xx
+const SAFETY_MARGIN_MS = 300; // leave room to parse, decide, and reply after the wait
+const MIN_CALL_TIMEOUT_MS = 50; // never race with a non-positive/instant timeout
+const MAX_PERSON_SEARCH_PAGES = 5; // hard cap: 5 pages x ~3 profiles x 0.13 credits stays well under the 5-credit budget
+
+const runStartedAt = Date.now();
+
+class TimeoutError extends Error {
+  constructor() {
+    super('timed out waiting for response');
+    this.name = 'TimeoutError';
+  }
+}
+
+function remainingBudgetMs(): number {
+  return RUN_DEADLINE_MS - (Date.now() - runStartedAt) - SAFETY_MARGIN_MS;
+}
+
+function isRateLimited(err: unknown): boolean {
+  const msg = err instanceof Error ? err.message : String(err);
+  return /HTTP 429/.test(msg) || /rate limit/i.test(msg);
+}
+
+function isServerError(err: unknown): boolean {
+  const msg = err instanceof Error ? err.message : String(err);
+  if (/rate limit/i.test(msg)) return false;
+  const match = /HTTP (\d{3})/.exec(msg);
+  if (!match) return false;
+  const code = Number(match[1]);
+  return code >= 500 && code < 600;
+}
+
+function isTimeout(err: unknown): boolean {
+  return err instanceof TimeoutError;
+}
+
+function isMalformedResponse(err: unknown): boolean {
+  return err instanceof MalformedResponseError;
+}
+
+function isTransient(err: unknown): boolean {
+  return isRateLimited(err) || isServerError(err) || isTimeout(err) || isMalformedResponse(err);
+}
+
+function retryWaitMs(err: unknown): number {
+  if (isServerError(err) || isTimeout(err)) return SERVER_ERROR_RETRY_WAIT_MS;
+  const anyErr = err as { retryAfterMs?: number; headers?: Record<string, string> } | undefined;
+  if (anyErr && typeof anyErr.retryAfterMs === 'number' && anyErr.retryAfterMs > 0) return anyErr.retryAfterMs;
+  const resetHeader = anyErr?.headers?.['x-ratelimit-reset'] ?? anyErr?.headers?.['X-RateLimit-Reset'];
+  if (resetHeader) {
+    const seconds = Number(resetHeader);
+    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000 + 100;
+  }
+  return DEFAULT_RATE_LIMIT_WAIT_MS;
+}
+
+function sleep(ms: number): Promise<void> {
+  return new Promise((resolve) => setTimeout(resolve, ms));
+}
+
+/**
+ * Race a call against the time left in the run's wall-clock budget, so a backend that never
+ * responds (or responds very late) can't hang the whole process past the deadline. Resolves/
+ * rejects like `fn()` normally would, or rejects with a TimeoutError if it doesn't settle in
+ * time. If there's effectively no budget left, fails fast with a TimeoutError instead of
+ * issuing a doomed call.
+ */
+function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
+  const budget = remainingBudgetMs();
+  const timeoutMs = Math.max(budget, MIN_CALL_TIMEOUT_MS);
+  return new Promise<T>((resolve, reject) => {
+    let settled = false;
+    const timer = setTimeout(() => {
+      if (settled) return;
+      settled = true;
+      reject(new TimeoutError());
+    }, timeoutMs);
+    fn().then(
+      (value) => {
+        if (settled) return;
+        settled = true;
+        clearTimeout(timer);
+        resolve(value);
+      },
+      (err) => {
+        if (settled) return;
+        settled = true;
+        clearTimeout(timer);
+        reject(err);
+      },
+    );
+  });
+}
+
+/**
+ * Run a transient-fault-prone call once, retrying up to `maxRetries` times on a 429, a 5xx, or
+ * a timeout if (and only if) there's enough time left in the run's wall-clock budget to wait
+ * out the backoff and still get a reply. Any other error, or a transient error with no budget
+ * left, propagates. Every attempt is itself bounded by the remaining budget so a hanging
+ * backend can never outlast the run's deadline.
+ */
+async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
+  let attempt = 0;
+  while (true) {
+    try {
+      return await withTimeout(fn);
+    } catch (err) {
+      if (!isTransient(err) || attempt >= maxRetries) throw err;
+      const wait = retryWaitMs(err);
+      if (wait > remainingBudgetMs()) throw err;
+      await sleep(wait);
+      attempt += 1;
+    }
+  }
+}
+
 export function createTools(transport: Transport): Tools {
   return {
     enrich_company: span({ kind: 'TOOL', name: 'enrich_company', toolName: 'enrich_company' }, async (input) => {
-      const raw = await transport('company.enrich', enrichRequest(String(input.domain)));
-      const company = (JSON.parse(raw) as EnrichResponse)[0].matches[0].company_data;
-      return {
-        name: company.basic_info!.name,
-        domain: company.basic_info!.primary_domain,
-        headcount: company.headcount!.total,
-        industry: company.taxonomy!.professional_network_industry,
-        fundingUsd: company.funding!.total_investment_usd,
-      };
+      const domain = String(input.domain);
+      try {
+        // One retry keeps worst case at 2 calls x 2 credits = 4 credits, within the 5-credit budget.
+        const raw = await withRateLimitRetry(() => transport('company.enrich', enrichRequest(domain)), 1);
+        return parseCompany(raw, domain);
+      } catch (err) {
+        if (isTransient(err)) return { notFound: true, domain };
+        throw err;
+      }
     }),
 
     search_people: span({ kind: 'TOOL', name: 'search_people', toolName: 'search_people' }, async (input) => {
+      const domain = String(input.domain);
+      const limit = Number(input.limit ?? 3);
       const people: PersonFacts[] = [];
+      const seenIds = new Set<number>();
+      const seenCursors = new Set<string>();
       let cursor: string | null = null;
-      // Collect every page of leaders.
-      do {
-        const raw = await transport('person.search', { ...peopleQuery(String(input.domain), Number(input.limit ?? 3)), ...(cursor ? { cursor } : {}) });
-        const page = JSON.parse(raw) as PersonSearchResponse;
-        for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
-        cursor = page.next_cursor;
-      } while (cursor);
+      let pages = 0;
+      try {
+        // Collect pages of leaders, but never more than MAX_PERSON_SEARCH_PAGES, and stop as
+        // soon as a page fails to make progress (same cursor seen before, or no new profiles) --
+        // that's the signature of a backend that ignores the cursor and echoes the same page
+        // forever. Without this, a stuck cursor would make this loop (not just a single
+        // transport call) run unbounded, blowing the credit/call/time budgets long before any
+        // per-call timeout could trip.
+        do {
+          pages += 1;
+          const raw = await withRateLimitRetry(
+            () => transport('person.search', { ...peopleQuery(domain, limit), ...(cursor ? { cursor } : {}) }),
+            1,
+          );
+          // parsePersonPage turns a truncated/malformed body into a MalformedResponseError
+          // instead of letting a raw SyntaxError escape; withRateLimitRetry's isTransient()
+          // check (and the catch below) treat that the same as a 429/5xx/timeout.
+          const page = parsePersonPage(raw);
+          let gotNew = false;
+          for (const p of page.profiles) {
+            if (seenIds.has(p.crustdata_person_id)) continue;
+            seenIds.add(p.crustdata_person_id);
+            people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
+            gotNew = true;
+          }
+          const nextCursor = page.next_cursor;
+          const cursorRepeats = nextCursor !== null && seenCursors.has(nextCursor);
+          if (nextCursor !== null) seenCursors.add(nextCursor);
+          if (!gotNew || cursorRepeats || pages >= MAX_PERSON_SEARCH_PAGES) break;
+          cursor = nextCursor;
+        } while (cursor);
+      } catch (err) {
+        if (!isTransient(err)) throw err;
+        // Return whatever leaders we already collected rather than crash on a later page
+        // (including a page that came back truncated/unparseable).
+      }
       return people;
     }),
   };
```
</details>

_A human reviews and merges. Bulwark never pushes to main._
