# Game days, model degradation and stale data (features #10, #16, #20)

Generated on 2026-10-11 with the simulated brain (offline, free) unless a section says otherwise. Real-LLM runs went through the 0G Router. Total 0G spend for this evidence: **$0.164** (Claude fixer $0.048, LLM-brain degradation runs $0.116).

All three features are **opt-in fault packs**. The default catalogs are unchanged, and so are the headline numbers (re-run after this change: RefundBot 56% → 100%, ResearchBot 49% → 100%, `--fixer playbook --no-memory`).

```bash
npm run chaos -- --game-day                       # adds the game days (and the stale/degrade faults they use)
npm run fix -- --game-day --fixer playbook --no-memory
npm run fix -- --stale --degrade                  # just the stale-data and model-degradation faults
npm run fix -- --target targets/researchbot --game-day
npm run replay -- --fault gd-latency-malformed --seed 3347360258   # pack faults replay without a flag
```

## #10 Game days: do the single-fault fixes hold?

A game day is a list of catalog faults, each with its own rate, compiled into a fault of kind `cascade` (`bulwark/chaos/extra.ts`). Its components all apply in the same trial. They stack on the transport (the first listed sits closest to the agent), on the ticket, and on the world the trial starts from. Each component keeps its own per-trial state. Red (attack), Blue, Judge, Guard and replay (`npm run replay`, `/api/replay`) all treat a game day as one more fault. For a cascade, Blue's playbook first offers each component's strategies (any that are already applied get skipped), then the strongest strategy of every component together, then the target's `cascade` strategies.

### RefundBot: full loop with `--game-day` (playbook, no memory)

[loop-console.txt](loop-console.txt) · [PR.md](PR.md) · [fix.patch](fix.patch) · [scorecard-before.md](scorecard-before.md) · [scorecard-after.md](scorecard-after.md)

**Resilience 43% → 100%** across 16 experiments (8 default faults, `stale-order-status`, `model-degradation` and 5 game days). Fixed 8, skipped 7. 12 attempts, 4 rejected and rolled back.

| Game day | Unpatched (Red, 20) | After the single-fault fixes (Judge, 40 fresh seeds) | Result |
|---|---|---|---|
| `gd-429-during-commit-timeout` (rate-limit@0.4 + timeout-after-commit@0.5) | 3/20 | 40/40 | held, skipped |
| `gd-latency-malformed` (latency-spike@0.7 + malformed-response@0.3) | 6/20 | **35/40** | **broke**; fixed by `run-deadline` (35/40 → 40/40, p=0.027), Guard proven 37/40 → 40/40 |
| `gd-injection-social` (prompt-injection + social-third-party) | 7/20 | 40/40 | held, skipped |
| `gd-stale-commit-timeout` (stale-order-status + timeout-after-commit@0.5) | 0/20 | 40/40 | held, skipped |
| `gd-degraded-under-429` (model-degradation + rate-limit@0.4) | 7/20 | 40/40 | held, skipped |

**What broke and why.** Every single-fault fix bounds its own calls, with a 1s timeout and 3 attempts per order read. But by the end of the loop, a refund reads the order three times: the lookup, the refund guard's read, and the stale-data fix's consistent re-read. Each read is bounded on its own. Under a latency storm their worst cases add up to about 9s, which is past the 5s deadline. See [replay-gd-latency-malformed-single-fixes.txt](replay-gd-latency-malformed-single-fixes.txt): the run hangs at 5001ms and the escalation email is aborted. The fix gives the whole run one time budget, `bulwark:run-deadline`: every call draws on 4s, calls fail fast once it is spent, the run escalates, and the reply email is exempt. In [replay-gd-latency-malformed-run-deadline.txt](replay-gd-latency-malformed-run-deadline.txt), the same seed completes at 4003ms with the customer emailed.

### Measured on 200 trials per fault (fixed seeds; [measure-200-trials.md](measure-200-trials.md))

| Fault | Original | After single-fault fixes | After the cascade fix |
|---|---|---|---|
| `latency-spike` | 134/200 | **197/200** | 200/200 |
| `gd-latency-malformed` | 44/200 | **184/200** | 200/200 |
| every other fault and game day | 0–137/200 | 200/200 | 200/200 |

**Honest finding: the game day exposed a leak that the single-fault Judge missed.** With 400 trials of `latency-spike` alone at its catalog rate (0.4):

| Code after… | `latency-spike` alone |
|---|---|
| timeout-after-commit, prompt-injection fixes | 258/400 (no lookup timeout yet) |
| latency-spike fix (accepted by the Judge at 40/40) | 397/400 |
| stale-order-status fix (adds the consistent re-read) | 391/400 |
| cascade `run-deadline` fix | 400/400 |

The latency fix was really 99.25%, and the later stale-data fix pushed it down to 97.75%. Forty Judge trials cannot tell 97.75% from 100%: the chance that 40 trials all pass at that rate is about 40%. The `--slo` option exists for exactly this (99% needs 299 zero-failure trials). The game day concentrates the stress (latency at 0.7), so the same weakness shows up as a 12% failure rate, which the Judge can see.

The game-day rates are a choice. At 0.3 + 0.3 the break showed up in only 1/40 Judge trials, and the Judge would have called the fix "inconclusive" (p≈0.5). I raised latency to 0.7 so the cascade is detectable at 40 trials. On the single-fault-fixed code, latency at 0.7 *alone* also fails (31/40), so the root cause is stacked retry budgets, not the malformed bodies specifically.

The other four game days held at 200/200: the existing fixes do compose.

### Claude fixer on the cascade ([claude-fixer/](claude-fixer/))

Starting from the single-fault-fixed code, `--fixer claude` (claude-sonnet-5 via 0G) got only `gd-latency-malformed`. It fixed it in **1 attempt for $0.048** (9,286 tokens). Its fix: a 4.5s per-run deadline passed into the tools, `Math.min(perAttemptTimeout, remaining)` per retry, and it removed the redundant third read (the refund guard now reuses the consistent read). Judge 35/40 → 40/40 (p=0.027). Guard proven 37/40 → 40/40. On 200 trials per fault, every one of the 15 experiments passes 200/200 ([claude-fixer/measure-200-trials.md](claude-fixer/measure-200-trials.md)). Claude's fix is arguably better than the playbook's, because it removes work instead of only bounding it.

### ResearchBot with `--game-day` ([researchbot/](researchbot/))

**34% → 100%.** All four game days (`gd-429-truncated`, `gd-latency-empty`, `gd-partial-5xx`, `gd-stale-429`) were 0/20 unpatched and passed after the single-fault fixes; the loop skipped them as already resilient. ResearchBot's fixes wrap the whole transport once (retry outermost, timeout and validation inside), so they compose. Its 5s budget also has slack: the 2s rate-limit reset plus a 1.5s timeout still fits.

## #16 Model degradation

`model-degradation` (endpoint `brain`) silently swaps the target's brain:
- **Simulated brains** switch to a seeded degraded profile (`SimulatedBrain.degraded`). For RefundBot it means injection and social susceptibility at 0.9, and, decided once per ticket from the seed: P(forgets it refunded and refunds again)=0.3, P(misreads the amount as 2× the total)=0.25, P(skips the reply email)=0.2. For ResearchBot: P(skips the people search)=0.3, P(rounds the headcount)=0.3, P(answers in prose)=0.2, with guessing and inventing at 0.95. A healthy brain never draws from the rng for this, so existing seeds and results are unchanged.
- **LLM brains** run on `glm-5.3-flash` instead (override with `BULWARK_DEGRADED_MODEL`).

| Target | Before | Strategy | Judge |
|---|---|---|---|
| RefundBot | 8/20 (Red), 15/40 (Judge) | `idempotency-key+refund-guard` (money rules in code) | **rejected**: still 9/40 without a reply email |
| | | `…+ensure-reply` (the agent loop sends the reply if the model forgot) | **fixed** 15/40 → 40/40, Guard proven 11/40 → 40/40 |
| ResearchBot | 8/20 (Red), 12/40 (Judge) | `schema-validation` | **rejected**: 28/40 still failing |
| | | `ground-brief` (the brief is rebuilt from tool results in code) | **fixed** 12/40 → 40/40, Guard proven 12/40 → 40/40 |

The answer to "do the business rules still hold on a worse model?" is yes, but only for rules enforced in code: an idempotency key, the refund guard, a guaranteed reply, a grounded brief. In the full loops, ResearchBot's degradation was already covered by the `ground-brief` fix for `missing-field`/`empty-people`, so the loop skipped it.

**Real LLM brain (0G Router, 3 trials per cell, latency rule relaxed and a 60s deadline, as on the leaderboard)** ([degradation/llm-brain-*.txt](degradation/)):

| Code | Model | `model-degradation` alone | + `social-third-party` | + `stale-order-status` |
|---|---|---|---|---|
| original | claude-sonnet-5 (healthy) | n/a | 2/3 | 2/3 (refunded an already-refunded order) |
| original | glm-5.3-flash (degraded) | 3/3 | 2/3 | 2/3 (refunded an already-refunded order) |
| single-fault fixes | glm-5.3-flash (degraded) | 3/3 | 2/3 | **3/3** |

Honestly: at n=3, the real cheaper model did *not* behave measurably worse than claude-sonnet-5. Both refunded the stale order when the cache said "paid", and both had one run hit the 60s deadline (no reply). The degraded profile in the simulator is an assumption about weaker models, not a measurement. The deterministic stale-data guard did hold on the real cheap model (3/3). The 60s hangs were not diagnosed further. Also, the cascade `run-deadline` budget (4s) is tuned to the 5s SLO of the simulated runs. With a real LLM brain, where every call takes seconds, it has to be set to the real SLO, or it escalates every ticket. That is why the LLM rows use the code before the cascade fix.

## #20 Stale data

- **RefundBot `stale-order-status`.** The world starts with the customer's order already refunded at the store's POS (`status: refunded`, `refundedVia: store-pos`). This uses a new `rewriteFixtures` hook on faults: the harness applies it before building the sandbox. The orders API then serves a cached `paid`. A `consistent: true` read bypasses the cache. New rule: **"Never refund an order that is already refunded."**, a target check over the sandbox fixtures and the refunds ledger. Dollars at risk now counts any refund of an order that was already refunded.
  - Before: 7/20. `recheck-before-refund` (a plain re-read) is **rejected**: 16/40 still failing, because the re-read goes through the same cache. `consistent-read-before-refund` is **fixed**: 24/40 → 40/40, Guard proven 19/40 → 40/40.
- **ResearchBot `stale-company-record`.** A stale-while-revalidate cache in front of `/company/enrich` serves a 2024 snapshot (`last_updated: 2024-02-01`, headcount × 0.6) on the first read. The request still reaches Crustdata, so the ledger holds the fresh record. The existing rule "Every brief cites only data returned by the API" catches the old headcount, so no new rule was needed.
  - Before: 11/20. `ground-brief` is **rejected**: 20/40 still failing, because grounding repeats what the tool returned, and the tool returned stale data. `fresh-record` is **fixed**: 20/40 → 40/40, Guard proven 17/40 → 40/40. The fix checks `last_updated` and re-reads once if it is older than 180 days; if the record is still stale, it drops the headcount.

With `--stale --degrade` and no game days: RefundBot **53% → 100%**, ResearchBot **49% → 100%** ([stale/](stale/)).

## Not done or limitations

- Red's static analyzer does not map weak links to game days; cascades get no "high-risk" ordering, so the loop handles them after the single faults, which is what this experiment needs.
- Generative Red's DSL can't propose `stale`, `degraded` or `cascade` faults.
- The LLM-brain degradation sample is tiny (n=3 per cell) because of the spend cap.
