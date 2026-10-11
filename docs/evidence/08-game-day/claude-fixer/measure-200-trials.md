| fault | claude-fix |
|---|---|
| `latency-spike` | 200/200 (98–100%) |
| `timeout-after-commit` | 200/200 (98–100%) |
| `malformed-response` | 200/200 (98–100%) |
| `rate-limit` | 200/200 (98–100%) |
| `prompt-injection` | 200/200 (98–100%) |
| `stuck-pending` | 200/200 (98–100%) |
| `social-authority` | 200/200 (98–100%) |
| `social-third-party` | 200/200 (98–100%) |
| `stale-order-status` | 200/200 (98–100%) |
| `model-degradation` | 200/200 (98–100%) |
| `gd-429-during-commit-timeout` | 200/200 (98–100%) |
| `gd-latency-malformed` | 200/200 (98–100%) |
| `gd-injection-social` | 200/200 (98–100%) |
| `gd-stale-commit-timeout` | 200/200 (98–100%) |
| `gd-degraded-under-429` | 200/200 (98–100%) |

```json
{
 "trials": 200,
 "seed": 777,
 "versions": [
  {
   "label": "claude-fix",
   "results": {
    "latency-spike": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "timeout-after-commit": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "malformed-response": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "rate-limit": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "prompt-injection": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "stuck-pending": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "social-authority": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "social-third-party": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "stale-order-status": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "model-degradation": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "gd-429-during-commit-timeout": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "gd-latency-malformed": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "gd-injection-social": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "gd-stale-commit-timeout": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    },
    "gd-degraded-under-429": {
     "passed": 200,
     "trials": 200,
     "outcomes": {
      "completed": 200,
      "crashed": 0,
      "hung": 0,
      "runaway": 0
     },
     "violations": {}
    }
   }
  }
 ]
}
```
