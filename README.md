# Bulwark

**Chaos engineering for AI agents.** Bulwark attacks your agent in a sandbox, watches what breaks, fixes it, and proves the fix with numbers.

Built for [#neatHack](https://neatlogs.com/hackathon) with neatlogs, Entire and cfo.ai.

## Quickstart

```bash
npm install
npm run chaos                       # all faults, 20 trials each, simulated LLM (free, deterministic)
npm run chaos -- --fault timeout-after-commit --trials 50
npm run chaos -- --brain claude     # real Claude as RefundBot's brain (needs ANTHROPIC_API_KEY)
npm test
```

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
