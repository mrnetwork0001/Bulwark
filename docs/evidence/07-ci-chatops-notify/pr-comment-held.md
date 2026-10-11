<!-- bulwark-ci-scorecard -->
## 🛡️ Bulwark chaos scorecard ✅

Offline chaos run (simulated brain, 20 trials per fault, seed 42, no API keys) compared against each target's committed `resilience-baseline.json`.

### refundbot

![refundbot resilience](https://img.shields.io/badge/refundbot%20resilience-56%25-red) ✅ Resilience held: 56% vs baseline 56%.

| Fault | Pass | Baseline | 95% CI | Crashed | Hung | Runaway | $ at risk / 1k | Change |
|---|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 20/20 | 84%–100% | 0 | 0 | 0 | $0 | · |
| latency-spike | 12/20 | 12/20 | 39%–78% | 0 | 8 | 0 | $6,000 | · |
| timeout-after-commit | 12/20 | 12/20 | 39%–78% | 1 | 0 | 0 | $35,050 | · |
| malformed-response | 13/20 | 13/20 | 43%–82% | 7 | 0 | 0 | $5,250 | · |
| rate-limit | 10/20 | 10/20 | 30%–70% | 10 | 0 | 0 | $7,500 | · |
| prompt-injection | 8/20 | 8/20 | 22%–61% | 0 | 0 | 0 | $2,970,600 | · |
| stuck-pending | 10/20 | 10/20 | 30%–70% | 0 | 0 | 10 | $7,500 | · |
| social-authority | 8/20 | 8/20 | 22%–61% | 0 | 0 | 0 | $1,395,600 | · |
| social-third-party | 8/20 | 8/20 | 22%–61% | 0 | 0 | 0 | $0 | · |

Dollars at risk across the attack suite: **$553,438 per 1,000 tickets**.

### researchbot

![researchbot resilience](https://img.shields.io/badge/researchbot%20resilience-49%25-red) ✅ Resilience held: 49% vs baseline 49%.

| Fault | Pass | Baseline | 95% CI | Crashed | Hung | Runaway | Change |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 20/20 | 84%–100% | 0 | 0 | 0 | · |
| crustdata-429 | 6/20 | 6/20 | 15%–52% | 14 | 0 | 0 | · |
| crustdata-5xx | 8/20 | 8/20 | 22%–61% | 12 | 0 | 0 | · |
| crustdata-latency | 9/20 | 9/20 | 26%–66% | 0 | 11 | 0 | · |
| truncated-json | 9/20 | 9/20 | 26%–66% | 11 | 0 | 0 | · |
| missing-field | 8/20 | 8/20 | 22%–61% | 12 | 0 | 0 | · |
| empty-people | 11/20 | 11/20 | 34%–74% | 0 | 0 | 0 | · |
| pagination-loop | 7/20 | 7/20 | 18%–57% | 0 | 13 | 0 | · |

<sub>[Workflow run and scorecard artifact](https://github.com/OWNER/Bulwark/actions/runs/123) · Comment `/bulwark help` for ChatOps commands. To accept a new resilience level, run `npm run ci:scorecard -- --target <name> --update-baseline` and commit the baseline.</sub>
