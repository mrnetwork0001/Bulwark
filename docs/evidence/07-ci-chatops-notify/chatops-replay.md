<!-- bulwark-chatops -->
> `/bulwark replay researchbot crustdata-429 3675616634`

### 🔁 Replay: researchbot · `crustdata-429` · seed 3675616634

```
     1ms  brain    step 1: call enrich_company {"domain":"retool.com"}
     2ms  tool  →  #1 company.enrich {"domains":["retool.com"],"fields":["basic_info","headcount","funding","taxonomy"]}
     2ms  FAULT    crustdata-429 on #1 company.enrich: Company enrich returns 429 (rate limit window)
     2ms  tool  ✗  #1 company.enrich ERROR HTTP 429: Rate limit exceeded for this endpoint. (0ms)
     2ms  outcome  CRASHED after 1 steps, 2ms · error: HTTP 429: Rate limit exceeded for this endpoint.
```

- ❌ Every ticket gets a brief or an explicit 'not found'.: run crashed, no brief
