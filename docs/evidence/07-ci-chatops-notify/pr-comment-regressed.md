<!-- bulwark-ci-scorecard -->
## 🛡️ Bulwark chaos scorecard ❌

Offline chaos run (simulated brain, 20 trials per fault, seed 42, no API keys) compared against each target's committed `resilience-baseline.json`.

### researchbot

![researchbot resilience](https://img.shields.io/badge/researchbot%20resilience-49%25-red) ❌ Resilience dropped below the committed baseline: 49% vs 100%.

| Fault | Pass | Baseline | 95% CI | Crashed | Hung | Runaway | Change |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 20/20 | 84%–100% | 0 | 0 | 0 | · |
| crustdata-429 | 6/20 | 20/20 | 15%–52% | 14 | 0 | 0 | 🔻 regressed |
| crustdata-5xx | 8/20 | 20/20 | 22%–61% | 12 | 0 | 0 | 🔻 regressed |
| crustdata-latency | 9/20 | 20/20 | 26%–66% | 0 | 11 | 0 | 🔻 regressed |
| truncated-json | 9/20 | 20/20 | 26%–66% | 11 | 0 | 0 | 🔻 regressed |
| missing-field | 8/20 | 20/20 | 22%–61% | 12 | 0 | 0 | 🔻 regressed |
| empty-people | 11/20 | 20/20 | 34%–74% | 0 | 0 | 0 | 🔻 regressed |
| pagination-loop | 7/20 | 20/20 | 18%–57% | 0 | 13 | 0 | 🔻 regressed |

**Why the check failed**
- crustdata-429: 6/20 passed, baseline 20/20
- crustdata-5xx: 8/20 passed, baseline 20/20
- crustdata-latency: 9/20 passed, baseline 20/20
- truncated-json: 9/20 passed, baseline 20/20
- missing-field: 8/20 passed, baseline 20/20
- empty-people: 11/20 passed, baseline 20/20
- pagination-loop: 7/20 passed, baseline 20/20

<sub>[Workflow run and scorecard artifact](https://github.com/OWNER/Bulwark/actions/runs/123) · Comment `/bulwark help` for ChatOps commands. To accept a new resilience level, run `npm run ci:scorecard -- --target <name> --update-baseline` and commit the baseline.</sub>
