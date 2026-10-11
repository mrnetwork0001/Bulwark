# How Bulwark uses neatlogs

Bulwark **writes** every run to neatlogs, and Blue **reads** a failing trial's trace back before it proposes a fix. This page covers both directions, what we measured about trace finalization (checked Oct 11 2026), and the commands to verify each claim.

## Writing

`bulwark/tracing.ts` initializes the neatlogs SDK (`neatlogs@1.1.28`) when `NEATLOGS_API_KEY` is set. Without the key, spans are still created but nothing is exported.

| What | Where | neatlogs shape |
|---|---|---|
| Each loop phase: `1 red: analyze code`, `2 red: attack scorecard BEFORE`, `judge: measure unpatched code`, `3 blue: propose fix …`, `4 judge: verify …`, `5 guard: …`, `6 red: attack scorecard AFTER`, `observe: replay failing … trial` | `bulwark/loop/orchestrator.ts` (`phase()`) | Root `WORKFLOW` trace. One neatlogs session per run (`bulwark-<runId>`, feature `bulwark-loop`). |
| Each experiment (one fault × N trials) | `bulwark/scorecard.ts` | `WORKFLOW` span `experiment: <fault>` |
| A sample of trials, 2 per experiment by default (`BULWARK_TRACE_SAMPLE`) | `bulwark/harness.ts` | `CHAIN` span `bulwark.trial` with `fault` and `seed` attributes. The other trials run `untraced()` and are masked out, so thousands of trials don't overflow the SDK's export queue. |
| RefundBot's tool calls | `targets/refundbot/tools.ts` | `TOOL` spans (`lookup_order`, `issue_refund`, `send_email`, `search_policy`) |
| RefundBot's and Blue's LLM calls | `targets/refundbot/brains.ts` (`wrapAnthropic`), `bulwark/blue/fixer.ts` | `LLM` spans, plus an `AGENT` span `blue.llm-propose` |

A traced trial records its trace id on the observation (`TrialObservation.traceId`). The trial span sits inside its phase's root trace, so this is the phase trace's id. Scorecard examples carry it (`examples[].traceId`), preferring a traced failing trial over an untraced one. It also shows up in each postmortem's replay lines.

## Reading

`bulwark/observe/neatlogs.ts` reads `GET https://ingest.neatlogs.com/api/traces/v3/<traceId>` with `x-api-key: $NEATLOGS_API_KEY`. It handles the same states as the SDK's own `neatlogs doctor --probe` read-back:

| Response | Meaning | Bulwark |
|---|---|---|
| `200` with `spans` | finalized | **read** |
| `202`, `finalizationStatus: "pending"`, `spans: []` | received, not finalized yet | keep polling |
| `404 Trace not found` | not visible yet (or never ingested) | keep polling |
| `409`, `finalizationStatus: "dlq"`, `"Trace processing failed"` | neatlogs gave up on the trace | **unavailable**, stop |
| `401` / `403` | key rejected | **unavailable**, stop |

A phase trace holds every fault's sampled trials, so `focusTrial()` narrows the read-back to the `bulwark.trial` span with the right seed and its descendants. `summarizeTrace()` lists detections first, then each span's `node_type`, `node_name`, `status`, `duration_ms`, tool input, output and `error_type: error_message`.

### The observe step (before Blue proposes a fix)

`bulwark/observe/evidence.ts`, called from the orchestrator once per fault:

1. **Candidates, oldest first.**
   - The previous run's traced failing trials for this fault, used only if that run attacked exactly this code. `summary.json` stores a `targetHash` of the target's files, and trials replay deterministically from their seed, so this is the same failure, and its trace has had minutes to finalize.
   - This run's BEFORE scorecard (it ran earliest).
   - The Judge's baseline.
   - If no sampled trial of this run failed, one failing seed is replayed traced, as its own `observe: replay …` trace, and flushed.
2. **Bounded wait.** A previous-run trace gets one check. The first trace from this run gets the wait budget: `--neatlogs-wait <seconds>` (default 20; `BULWARK_NEATLOGS_WAIT_MS` also works; `0` disables reading). A trace already pending for an earlier fault gets one re-check, not another full wait. The loop never waits longer than the budget, and never throws.
3. **Blue gets the digest** as `FixContext.neatlogsEvidence`. The Claude fixer's prompt then has a section "## What neatlogs recorded for a failing trial".
4. **Every step is reported.** An `observe` event `{ fault, traceId, seed, source, status: read|pending|unavailable, spans, detections, waitedMs, reason }` goes to the CLI and the dashboard stream. Each postmortem gets a "## What neatlogs recorded" line, one of:
   - "Diagnosed from neatlogs trace `<id>` (N spans, M detections; …)"
   - "neatlogs trace `<id>` not finalized in time (…); used local evidence."
   - "neatlogs read-back unavailable (NEATLOGS_API_KEY not set); used local evidence."
5. **End of run.** Traces that were still pending get one more check. A trace that finalized in the meantime is recorded as "finalized only after Blue ran (N spans, M detections); Blue used local evidence". The run log prints `neatlogs read-back: X/Y failing-trial traces read`.

## Finalization: what we measured (Oct 11 2026, ~04:10–04:40 UTC)

**What makes a trace finalize.** The SDK ends a trace by emitting an internal `neatlogs.trace.complete` marker span once the root span has ended and passed the mask (`CompletionMarkerSpanProcessor` in `node_modules/neatlogs/dist/index.mjs`). The marker is a child of the root, and it carries the root's session attributes. neatlogs' pipeline then runs its stages (`kafka_published → pii_dispatch → pii_redaction → storage_consumer → raw_durable → root_resolution → simplification → finalized`, listed in `cli.mjs`). The SDK's doctor gives the whole round trip 48 s and polls every 1 s. We checked the export side with an HTTP preload: every probe's single `POST /v1/traces` returned `200`, and the SDK reported 0 queue drops and 0 export failures. The trace is a single root, since a non-root `kind` such as `CHAIN` gets no auto-root when it is already the top span. On our side the trace is complete when it leaves the process.

**What happened on neatlogs' side:**

| Trace | Shape | Outcome |
|---|---|---|
| 12 small probes `bulwark-readback-probe-*` | `CHAIN` root; `WORKFLOW` root; `WORKFLOW` root with a `sessionId`; Bulwark's shape (session `WORKFLOW` → `WORKFLOW` → `CHAIN` trial → `TOOL`). Each sent from a process that called `shutdown()`, `flush()` and stayed alive, or flushed, waited 6 s and then shut down. | **2 finalized** (both `WORKFLOW` root, no session, `shutdown()`): `200` at the first poll, ≤13 s and ≤119 s after sending. **4 dead-lettered**: `202 pending`, then `409 dlq` after 156–252 s. **6 never became visible**: `404` for the whole poll window (8–25 min). |
| `neatlogs doctor --probe` (the SDK's own 4-span fixture), run twice | doctor's fixture | **Both failed** with `TRACE_READBACK_TIMEOUT` after 48 s. The first one's trace was still `404` 28 min later. |
| Real Bulwark phase traces (3 runs) | `2 red: attack scorecard BEFORE`, `judge: measure unpatched code` | BEFORE traces `94766c1c…` and `b76f0ea4…`: `202 pending`, then **`409 dlq` at ~260 s**. Judge traces `82baaceb…` and `61503b16…`: `404` at 20 s and still `404` minutes later. |

No shape, session setting or process lifetime finalized reliably. Successes and failures happened with identical code, and the SDK's own doctor fails the same way. So the cause is on the neatlogs ingestion side for this project, not Bulwark's trace shape. A trace can still show up in the neatlogs UI while it is pending, because the `202` body already carries its `name` and `createdAt`. Showing up is not the same as finalized.

**Design consequence.** When a trace finalizes (≈10–15 s in the good cases), the default 20 s budget reads it mid-run, and Blue diagnoses from it. When neatlogs is slow, Bulwark doesn't block. It falls back to local evidence, says so in the postmortem, re-checks at the end of the run, and on the next run reads the previous run's trace for the same code and seed first. Today every real Bulwark trace hit the fallback. The fallback is what you will see until neatlogs' finalizer recovers. The read path itself is proven against the probes that did finalize (below).

## Verify it yourself

```bash
# The read path, against a probe trace that finalized:
npm run readback -- 11fa0cc26f19df37456a24ae21668c55 --wait 0
#   → read (HTTP 200) … 2 spans: tool_call lookup_order status=SUCCESS input=ord_1 output={"id":"ord_1","total":49}

# The latest run's traced failing trials, with each one's live state (read / pending + HTTP 202/404 / dlq):
npm run readback
npm run readback -- --run <runId> --wait 60

# The SDK's own end-to-end check (fails with TRACE_READBACK_TIMEOUT while neatlogs isn't finalizing):
node --env-file=.env node_modules/neatlogs/dist/cli.mjs doctor --probe --json

# The raw API:
curl -s -H "x-api-key: $NEATLOGS_API_KEY" https://ingest.neatlogs.com/api/traces/v3/<traceId>

# The loop with read-back (look for OBSERVE lines and "neatlogs read-back: X/Y"):
npm run fix -- --fixer claude --fault timeout-after-commit --max-attempts 1
npm run fix -- --fixer playbook --neatlogs-wait 60            # longer budget
NEATLOGS_API_KEY= npm run fix -- --fixer playbook --no-memory  # no key → "unavailable", nothing blocks
grep -A1 "What neatlogs recorded" .bulwark/runs/*/postmortem-*.md | tail

npm test   # tests/observe.test.ts: polling states, trial focus, digest, fallbacks (mocked fetch)
```
