# Postmortem: truncated-json

**Run** 2026-10-11T23-15-42-880Z · **Status** ✅ fixed and verified

## Hypothesis
If a /person/search response is truncated, ResearchBot crashes because it parses the body without validating or retrying.

## Blast radius (before)
23/40 trials passed (95% CI 42%–71%).
Outcomes: 23 completed, 17 crashed. Broken rules: 17× Every ticket gets a brief or an explicit 'not found'.
- Replay: seed 2936708545 → Every ticket gets a brief or an explicit 'not found'. (run crashed, no brief), neatlogs trace `3bf5206f64a763737ec474ac01eae030`

## Weak links found in the code
- `tools.ts:89` search_people trusts the JSON from person.search without validating it
  - Blast radius (Entire Graph): createTools (function, targets/researchbot/tools.ts:70) ← 1 caller: runResearchBot (targets/researchbot/agent.ts:62)
  - Provenance: introduced in `6b1e432`, 2026-10-11 by Claude Code session `8cdad8b4`, prompt "lets build all. of these and be sure it works: [pasted text] deploy m…" (Entire checkpoint `01M4MXYM7XTXW4A808VVD1DX3C`); Entire linked this line by session, not by the checkpoint's files_touched

## What neatlogs recorded
Diagnosed from neatlogs trace 3bf5206f64a763737ec474ac01eae030 (4 spans, 3 detections; failing trial seed 2936708545 from the Judge's baseline).

## Attempts

### ✅ Attempt 1: Treat unparseable (truncated) person-search JSON as a transient failure (`catch-malformed-json-as-transient`, by claude-sonnet-5)
Root cause: search_people's pagination loop does `JSON.parse(raw)` on the person.search response body with no error handling. A truncated body throws a SyntaxError that is not an Error our isTransient() check recognizes (it only looks for HTTP 429/5xx/timeout message patterns), so the catch block's `if (!isTransient(err)) throw err;` re-throws it, and the uncaught SyntaxError propagates out of runResearchBot and crashes the run. That matches the evidence exactly: "SyntaxError: Expected ':' after property name in JSON" killing the run after 2 steps.

The fix treats a malformed/truncated JSON body from person.search the same way the code already treats a transient HTTP fault: catch the parse error for the current page, stop paginating, and return whatever leader profiles were already collected from prior pages (or an empty list if this was the first page) rather than crash. This mirrors the existing resilience pattern used for 429/5xx/timeout (collect-what-we-have-and-move-on) instead of inventing new behavior, keeps groundBrief's "only cite what a tool actually returned" guarantee intact (we never fabricate people or titles - we only stop reading a corrupted page), and still lets the run finish with a brief or an explicit not-found rather than hang or crash. enrich_company's parseCompany is unaffected since the fault/evidence is specific to person.search; no change was needed there.

I did not change retry/backoff semantics, credit budgets, or the grounding logic in agent.ts, since those already correctly handle "fewer people than hoped" and "no company found" cases - the only gap was the unguarded JSON.parse on a truncated person-search body.

Checkpoint before attempt: `ckpt-009`. Judge: **fixed**. 23/40 → 59/59 on fresh seeds (p=1.6e-8), no regressions; SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence.
Overhead: happy path p50 35→32ms (-9%), p95 39→35ms (-11%), steps 3.0→3.0 (+0.0), cost n/a.


## Root cause and fix
Root cause: search_people's pagination loop does `JSON.parse(raw)` on the person.search response body with no error handling. A truncated body throws a SyntaxError that is not an Error our isTransient() check recognizes (it only looks for HTTP 429/5xx/timeout message patterns), so the catch block's `if (!isTransient(err)) throw err;` re-throws it, and the uncaught SyntaxError propagates out of runResearchBot and crashes the run. That matches the evidence exactly: "SyntaxError: Expected ':' after property name in JSON" killing the run after 2 steps.

The fix treats a malformed/truncated JSON body from person.search the same way the code already treats a transient HTTP fault: catch the parse error for the current page, stop paginating, and return whatever leader profiles were already collected from prior pages (or an empty list if this was the first page) rather than crash. This mirrors the existing resilience pattern used for 429/5xx/timeout (collect-what-we-have-and-move-on) instead of inventing new behavior, keeps groundBrief's "only cite what a tool actually returned" guarantee intact (we never fabricate people or titles - we only stop reading a corrupted page), and still lets the run finish with a brief or an explicit not-found rather than hang or crash. enrich_company's parseCompany is unaffected since the fault/evidence is specific to person.search; no change was needed there.

I did not change retry/backoff semantics, credit budgets, or the grounding logic in agent.ts, since those already correctly handle "fewer people than hoped" and "no company found" cases - the only gap was the unguarded JSON.parse on a truncated person-search body.

```diff
diff --git a/targets/researchbot/tools.ts b/targets/researchbot/tools.ts
index 6cb8362..fb50579 100644
--- a/targets/researchbot/tools.ts
+++ b/targets/researchbot/tools.ts
@@ -82,6 +82,29 @@ function parseCompany(raw: string, domain: string): CompanyFacts | { notFound: t
   };
 }
 
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
 
 // A 429 is transient, and so is a 5xx (a bad gateway, a dropped backend, a one-off server
@@ -97,6 +120,12 @@ export type Tools = Record<ToolName, (input: Record<string, unknown>) => Promise
 // unbounded await can blow the wall-clock budget on its own even though nothing "failed". So
 // every transport() call is additionally raced against a timeout bounded by the time left in
 // the run, and a timeout is treated as transient exactly like a 429/5xx.
+//
+// A truncated/malformed response body (valid HTTP, invalid JSON) is a third kind of
+// transient-ish fault: the request succeeded but the payload can't be trusted. It isn't worth
+// retrying (the same cursor would just be re-fetched), so instead of treating it as fatal we
+// stop paginating and keep whatever complete pages we already parsed, same as we'd keep a
+// partial list on a 429/5xx/timeout we can't recover from.
 
 const RUN_DEADLINE_MS = 5000;
 const DEFAULT_RATE_LIMIT_WAIT_MS = 2100; // just past the documented 2s reset window
@@ -135,8 +164,12 @@ function isTimeout(err: unknown): boolean {
   return err instanceof TimeoutError;
 }
 
+function isMalformedResponse(err: unknown): boolean {
+  return err instanceof MalformedResponseError;
+}
+
 function isTransient(err: unknown): boolean {
-  return isRateLimited(err) || isServerError(err) || isTimeout(err);
+  return isRateLimited(err) || isServerError(err) || isTimeout(err) || isMalformedResponse(err);
 }
 
 function retryWaitMs(err: unknown): number {
@@ -237,13 +270,17 @@ export function createTools(transport: Transport): Tools {
             () => transport('person.search', { ...peopleQuery(domain, limit), ...(cursor ? { cursor } : {}) }),
             1,
           );
-          const page = JSON.parse(raw) as PersonSearchResponse;
+          // parsePersonPage turns a truncated/malformed body into a MalformedResponseError
+          // instead of letting a raw SyntaxError escape; withRateLimitRetry's isTransient()
+          // check (and the catch below) treat that the same as a 429/5xx/timeout.
+          const page = parsePersonPage(raw);
           for (const p of page.profiles) people.push({ id: p.crustdata_person_id, name: p.basic_profile.name, title: p.basic_profile.current_title ?? '' });
           cursor = page.next_cursor;
         } while (cursor);
       } catch (err) {
         if (!isTransient(err)) throw err;
-        // Return whatever leaders we already collected rather than crash on a later page.
+        // Return whatever leaders we already collected rather than crash on a later page
+        // (including a page that came back truncated/unparseable).
       }
       return people;
     }),
```

## Reliability target
SLO 95% demonstrated: 59/59 passed, so the pass rate is ≥ 95.05% at 95% confidence. Method: exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target)).

## Overhead
Compared with the unpatched code on the no-fault baseline (40 runs): happy path p50 35→32ms (-9%), p95 39→35ms (-11%), steps 3.0→3.0 (+0.0), cost n/a.
Under truncated-json (informational, not budgeted): p50 126→152ms, avg steps 2.6→3.0.


## Proof the regression test guards the fix
With the fix removed: 17/40 passed. With the fix: 40/40 passed. ✅ The test catches the bug.
