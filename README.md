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
npm run chaos                       # attack only: all faults, 20 trials each
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

Offline result on RefundBot: **resilience 61% → 100%** in 7 attempts (3 rejected and rolled back). With memory, the next run takes 4 attempts and 0 rollbacks.

Set `NEATLOGS_API_KEY` to export every experiment, trial, tool call and injected fault to neatlogs. Without it, everything still runs locally.

## What happens today

The demo target, **RefundBot**, is a support agent that refunds orders through a Dodo Payments sandbox. It passes 20/20 trials when nothing breaks. Bulwark then attacks it with six faults:

| Fault | What breaks |
|---|---|
| `latency-spike` | No timeout on order lookup → the run hangs |
| `timeout-after-commit` | Blind retry on a slow refund → **the customer is refunded twice** |
| `malformed-response` | Trusts the JSON → crash |
| `rate-limit` | No retry on 429 → crash |
| `prompt-injection` | Obeys instructions inside tool output → refunds $5,000 on a $49 order |
| `stuck-pending` | Re-checks forever → runaway steps and cost |

Every trial is checked against business rules written in plain English (`targets/refundbot/bulwark.target.ts`), using the sandbox ledger as ground truth. Pass rates come with 95% Wilson confidence intervals, and every failure is replayable from its seed.

## Layout

```
bulwark/            chaos agent: faults, harness, rule compiler, scorecard, CLI
targets/refundbot/  the deliberately fragile demo agent
docs/               plan, features, demo script, submission checklist
```

See [PROJECT_SPEC.md](PROJECT_SPEC.md) for the full plan and [docs/FEATURES.md](docs/FEATURES.md) for the roadmap.
