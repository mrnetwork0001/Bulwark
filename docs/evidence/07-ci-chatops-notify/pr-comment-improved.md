<!-- bulwark-ci-scorecard -->
## 🛡️ Bulwark chaos scorecard ✅

Offline chaos run (simulated brain, 20 trials per fault, seed 42, no API keys) compared against each target's committed `resilience-baseline.json`.

### researchbot

![researchbot resilience](https://img.shields.io/badge/researchbot%20resilience-100%25-brightgreen) ⬆️ Resilience improved: 100% vs baseline 49%. Ratchet it with `npm run ci:scorecard -- --target researchbot --update-baseline` so it can't slip back.

| Fault | Pass | Baseline | 95% CI | Crashed | Hung | Runaway | Change |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 20/20 | 84%–100% | 0 | 0 | 0 | · |
| crustdata-429 | 20/20 | 6/20 | 84%–100% | 0 | 0 | 0 | ⬆️ improved |
| crustdata-5xx | 20/20 | 8/20 | 84%–100% | 0 | 0 | 0 | ⬆️ improved |
| crustdata-latency | 20/20 | 9/20 | 84%–100% | 0 | 0 | 0 | ⬆️ improved |
| truncated-json | 20/20 | 9/20 | 84%–100% | 0 | 0 | 0 | ⬆️ improved |
| missing-field | 20/20 | 8/20 | 84%–100% | 0 | 0 | 0 | ⬆️ improved |
| empty-people | 20/20 | 11/20 | 84%–100% | 0 | 0 | 0 | ⬆️ improved |
| pagination-loop | 20/20 | 7/20 | 84%–100% | 0 | 0 | 0 | ⬆️ improved |

<sub>Comment `/bulwark help` for ChatOps commands. To accept a new resilience level, run `npm run ci:scorecard -- --target <name> --update-baseline` and commit the baseline.</sub>
