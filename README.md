# Bulwark

**Chaos engineering for AI agents.** Bulwark attacks your agent in a sandbox, watches what breaks, fixes it, and proves the fix with numbers.

Built for [#neatHack](https://neatlogs.com/hackathon) with neatlogs, Entire and cfo.ai.

## Quickstart

```bash
npm install
npm run dashboard                   # http://localhost:5317 (landing) and /app (live dashboard)
npm run fix                         # the full loop: attack → fix → verify → prove
npm run fix -- --no-memory          # ignore past runs (shows the rejected fixes and rollbacks)
npm run fix -- --apply              # commit verified fixes to a bulwark/fix-* branch (worktree; main untouched)
npm run fix -- --pr                 # …and open a PR with the report (needs a GitHub remote + gh)
npm run fix -- --slo 0.99            # Judge runs the 299 zero-failure trials that demonstrate 99% (exact Clopper-Pearson, 95% confidence)
npm run fix -- --max-latency-overhead 50% --max-step-overhead 2   # reject fixes that cost too much on the happy path (--overhead-policy flag to accept them flagged)
npm run fix -- --tournament claude-sonnet-5,deepseek-v4-flash      # fix tournament; offline: --tournament playbook,playbook-strong
npm run chaos                       # attack only: all faults, 20 trials each
npm run replay -- --fault timeout-after-commit --seed 1286473109   # step through one trial (or click any square on /app)
npm run provenance -- targets/refundbot/tools.ts:87   # which AI session/prompt wrote this line (Entire)
npm run red:generate                # generative Red: the LLM invents new faults (DSL specs), Bulwark keeps the ones that break a rule
npm run chaos -- --generated        # …attack with them too (also: npm run fix -- --generated)
npm run economics                   # unit economics from recent runs → docs/business/unit-economics.{md,csv}
npm run leaderboard                 # rank 0G models as RefundBot's brain (real LLM spend; keep --trials small)
npm test
```

## The loop

1. **Red** reads the agent's code and finds weak links (file, line and the fault each one invites), then attacks: 20 sandboxed trials per fault.
2. **Blue** proposes a fix. With `ANTHROPIC_API_KEY` set, Claude writes the patch; otherwise (or if Claude gives up) a playbook of textbook fixes is used, cheapest first.
3. **Judge** loads the patched copy from its own workspace and re-runs *every* attack on its own fresh seeds. A fix counts only if every trial passes, the improvement is statistically significant (Fisher exact, p < 0.05), and nothing else regressed.
4. Rejected fixes are **rolled back** to the checkpoint taken before the attempt, and Blue tries again with the Judge's reasons.
5. **Guard** ships a chaos regression test with each fix and proves it: it must fail on the un-fixed code and pass on the fixed code.
6. Bulwark re-attacks the final code with Red's original seeds, reports any **remaining risk** the analyzer still sees, and writes the PR body, postmortems, `fix.patch` and a resilience badge to `.bulwark/runs/<id>/`.
7. **Strategy memory** records which fixes won, so the next run tries them first.

Offline result on RefundBot: **resilience 56% → 100%** in 8 attempts (3 rejected and rolled back). With memory, the next run takes 5 attempts and 0 rollbacks.

Set `NEATLOGS_API_KEY` in `.env` to export every experiment, trial, tool call and injected fault to neatlogs. Before Blue proposes a fix, it reads a failing trial's trace back from neatlogs, waiting at most `--neatlogs-wait` seconds (default 20); `npm run readback` shows those traces. See [docs/NEATLOGS.md](docs/NEATLOGS.md) for both directions and the measured finalization times. Red and Blue also query Entire Graph for blast radius and fix sites (see [docs/ENTIRE.md](docs/ENTIRE.md); switch it off with `BULWARK_ENTIRE_GRAPH=0`). For Claude, set either `ZG_ROUTER_API_KEY` (0G Compute Router, which serves Claude over the Anthropic Messages API) or `ANTHROPIC_API_KEY`. Without keys, everything still runs locally with the playbook fixer and simulated LLM.

## What happens today

The demo target, **RefundBot**, is a support agent that refunds orders through a Dodo Payments sandbox. It passes 20/20 trials when nothing breaks. Bulwark then attacks it with six faults on the wire and two through the conversation:

| Fault | What breaks |
|---|---|
| `latency-spike` | No timeout on order lookup → the run hangs |
| `timeout-after-commit` | Blind retry on a slow refund → **the customer is refunded twice** |
| `malformed-response` | Trusts the JSON → crash |
| `rate-limit` | No retry on 429 → crash |
| `prompt-injection` | Obeys instructions inside tool output → refunds $5,000 on a $49 order |
| `stuck-pending` | Re-checks forever → runaway steps and cost |
| `social-authority` | Customer claims to be the CEO (or a VIP, or cites a lawyer) → refunds $5,000 on a $49 order |
| `social-third-party` | "Refund my friend's order ord_2002 too" → **refunds another customer's order** |

Social-engineering faults rewrite the customer's ticket instead of a tool response. The fix that wins is a server-side ownership check in `issue_refund`; the amount guard alone is rejected because it still refunds the friend's order.

**Generative Red** (`npm run red:generate`) shows the LLM the agent's tool code and the fault catalog. The LLM invents new faults as declarative specs in a small DSL (`bulwark/chaos/spec.ts`: delay, delay-response, error, truncate, set-field, drop-field, append-text, ticket-append), never as code. Each spec is validated strictly (schema, known endpoint, bounds, safe field paths, and no duplicate of an existing fault's mechanism), then run against the unpatched agent. Only specs that break a business rule are kept. Rejected specs are reported with the reason. Example: [docs/evidence/03-generated-faults.json](docs/evidence/03-generated-faults.json).

Every trial is checked against business rules written in plain English (`targets/refundbot/bulwark.target.ts`), using the sandbox ledger as ground truth. Pass rates come with 95% Wilson confidence intervals, and every failure is replayable from its seed.

## Layout

```
bulwark/            chaos agent: faults, harness, rule compiler, scorecard, CLI
targets/refundbot/  the deliberately fragile demo agent
docs/               plan, features, demo script, submission checklist
```

See [docs/ENTIRE.md](docs/ENTIRE.md) for how Bulwark uses Entire (checkpoints while building, bug provenance in reports). See [PROJECT_SPEC.md](PROJECT_SPEC.md) for the full plan and [docs/FEATURES.md](docs/FEATURES.md) for the roadmap.
