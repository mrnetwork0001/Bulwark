<!-- bulwark-chatops -->
> `/bulwark help`

**Bulwark ChatOps** (repository collaborators only)

| Command | What it does |
|---|---|
| `/bulwark attack [target] [fault\|all]` | Offline chaos scorecard (simulated brain, 20 trials per fault, seed 42) |
| `/bulwark fix [target] [pr]` | Runs the attack → fix → verify loop with the playbook fixer and replies with resilience before → after. With `pr`, pushes the verified fixes to a new `bulwark/fix-*` branch and opens a PR into this PR's branch (never pushes to this branch or main) |
| `/bulwark replay [target] <fault> <seed>` | Re-runs one trial from its seed and replies with its timeline |
| `/bulwark help` | This message |

Targets: `refundbot`, `researchbot`.
- `refundbot` faults: `latency-spike`, `timeout-after-commit`, `malformed-response`, `rate-limit`, `prompt-injection`, `stuck-pending`, `social-authority`, `social-third-party`
- `researchbot` faults: `crustdata-429`, `crustdata-5xx`, `crustdata-latency`, `truncated-json`, `missing-field`, `empty-people`, `pagination-loop`
