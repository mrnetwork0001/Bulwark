<!-- bulwark-chatops -->
> `/bulwark fix researchbot pr`

### 🛡️ Bulwark fix: researchbot

**Resilience 49% → 100%** · fixed 5, unfixed 0, skipped 2 · 5 attempts, 0 rollbacks

- Fixed: `missing-field`, `crustdata-429`, `crustdata-latency`, `truncated-json`, `pagination-loop`
- Unfixed: none
- Top remaining risk: `agent.ts:104` the agent loop has no step budget, so a stuck tool means unbounded steps and cost
- Committed to branch `bulwark/fix-2026-10-11T16-24-34-692Z`
- This PR comes from a fork, so the fix branch was not pushed (a PR into a fork branch is not possible).

<sub>run `2026-10-11T16-24-34-692Z` · playbook fixer, simulated brain, no API keys · full report in the workflow artifact</sub>
