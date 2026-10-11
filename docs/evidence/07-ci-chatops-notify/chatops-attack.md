<!-- bulwark-chatops -->
> `/bulwark attack researchbot crustdata-429`

### 💥 Bulwark scorecard: researchbot

**trials**: 20 · **seed**: 42 · **brain**: simulated · **date**: 2026-10-11T16:22:43.847Z

| Fault | Pass | 95% CI | Crashed | Hung | Runaway | p95 | Broken rules |
|---|---|---|---|---|---|---|---|
| baseline | 20/20 | 84%–100% | 0 | 0 | 0 | 36ms | — |
| crustdata-429 | 6/20 | 15%–52% | 14 | 0 | 0 | 43ms | Every ticket gets a brief or an explicit 'not found'. (14) |

## Hypotheses and replayable failures

- **baseline**: The agent works when nothing breaks.
- **crustdata-429**: If /company/enrich rate-limits (15 RPM), ResearchBot crashes because enrich_company never retries; a retry inside the 2s x-ratelimit-reset window fails again.
  - ✗ Every ticket gets a brief or an explicit 'not found'. → run crashed, no brief (seed 3675616634)


<sub>[Workflow run](https://github.com/OWNER/Bulwark/actions/runs/1)</sub>