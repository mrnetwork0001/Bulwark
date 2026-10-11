# Bulwark demo film

A 2:18 film made with [Remotion](https://www.remotion.dev) for the neatHack judges: the problem (an agent that passes its tests and still refunds a customer twice), what Bulwark does about it (attack, fix, prove), and what makes it different. It stays under X's 2:20 cap for standard accounts.

The motif is Bulwark's own logo, the crenellated wall, built from bricks. Every attack knocks a brick out in alarm red. A fix the Judge rejects drops a brick in that wobbles and falls back out (the rollback). A fix the Judge accepts drops it back in, green and locked. When resilience reaches 100%, the wall is whole.

## What is real

- **The cold open** is a real trial, replayed from its seed: RefundBot, fault `timeout-after-commit`, seed `1286473109` (`npm run replay -- --fault timeout-after-commit --seed 1286473109 --json`, written to `src/data.json` by `scripts/data.mjs`). Every row on screen comes from that replay: the ticket, the event times (+1 ms, +6 ms, +1007 ms), the ~1001 ms timeout, the blind retry, refunds `rf_1` and `rf_2`, and the two broken rules ("ord_1001: refunded $98 of $49").
- **The numbers** come from the repo, and `scripts/data.mjs` checks each one against the file that states it before writing `src/data.json`:
  - RefundBot 56% → 100%, ResearchBot 49% → 100%, game day 43% → 100%, $553,438 → $0 at risk per 1,000 tickets (stated assumptions), 8 attempts with 3 rejected and rolled back, Fisher p < 10⁻⁶, self-chaos 11 injected and 11 recovered with 5 real bugs fixed (README "Results", `docs/evidence/07-self-chaos/result.json`).
  - The cfo.ai plan's ARR of $77k → $232k → $774k and cash-flow positive from 2028-11 (README, `docs/business/cfo-ai-plan.md`).
  - The 52,405 companies building AI agents (Crustdata, `docs/business/market-sizing.md`).
  - The 175 tests (`npm test`, run by `scripts/data.mjs`).
- **The live run** (scenes 4 to 7) was recorded from the real dashboard (`/app`) on a local server (`PORT=5410`, Chrome at 1600×900, device scale 2). The settings were target refundbot, seed 42, 20 trials per fault, SLO 95%, and Remember past fixes off. The fixer was the **playbook** (no LLM key on that server), so the run is deterministic. On camera, timeout-after-commit takes three attempts:
  1. Exponential backoff is rejected: 29/59 trials still refund twice.
  2. The idempotency key alone is rejected: 3/59 tickets get no reply.
  3. The idempotency key plus escalate is fixed: 59/59 on fresh seeds, SLO 95% demonstrated, and Guard proves the regression test.

  The whole run ends at 8 attempts, 3 rollbacks and 56% → 100%. The film plays parts of that recording at 0.7× to 1.5× speed to match the narration.
- **The trace diff** is the dashboard's "Compare with fix" view on seed 1286473109 from that same run. At step 13, before the fix a second $49 refund (rf_2) goes through; after the fix it never happens.
- **The landing dial** and the **researchbot target switch** are recordings of the same local server.
- **neatlogs:** the three screenshots of the team's own neatlogs project (Traces, Sessions, and one expanded Bulwark session with its phase traces) were taken by the user on Oct 11. Each was checked for API keys before use, and none shows one. The "OBSERVE read neatlogs trace e1954fb78c…: 6 spans, given to Blue" line comes from the live run's own timeline.
- **Entire:** the provenance card is the real output of `npm run provenance -- targets/refundbot/tools.ts:87`, and the status card is the first two lines of `entire status` in this worktree. The 74 pushed checkpoints figure is from the README.
- **cfo.ai:** recorded from the public read-only plan at https://app.cfo.ai/s/xAu-NTAidKxJcCm7. The share page's sign-in card and trial banner were dismissed before recording; they are viewer chrome, not the plan.
- **Narration, music and sound:** ElevenLabs. The narrator is **Lily** (`eleven_multilingual_v2`), chosen from an audition against Sarah and Alice (`scripts/audition.mjs`). The score was made with ElevenLabs Music and the 15 sound effects with sound generation.
- **Not shown on purpose:** Dodo Payments and AWS. RefundBot uses an in-memory payments sandbox, and Bulwark doesn't use AWS.

## Partner logos

Each logo was downloaded from the company's own website. None was redrawn.

| Logo | File | Source |
|---|---|---|
| neatlogs | `public/logos/neatlogs-wordmark.webp` | https://neatlogs.com/brand/neatlogs-wordmark.webp (the wordmark mask used by the neatlogs.com header) |
| Entire | `public/logos/entire.svg` | The inline header logo SVG on https://entire.io |
| cfo.ai | `public/logos/cfoai.svg` | The inline header logo SVG on https://cfo.ai (`aria-label="cfo.ai"`) |
| 0G | `public/logos/0g.svg` | 0G brand kit, https://0g.ai/brandkit → https://0g.ai/assets/681c472ba991e2e4ca164fe6_Black-OG-Logo.svg |
| Crustdata | `public/logos/crustdata.svg` | The header logo on https://crustdata.com (Framer layer "Crustdata-logo", an embedded SVG) |

Crustdata's wordmark is drawn in white for its dark site, so the film renders it monochrome, the same as the other logos.

## Build it

The ElevenLabs key is read at runtime from `/Users/mrnetwork/Syntura/video/.env` and is never stored here.

```
npm install
node scripts/data.mjs                         # real data from the repo -> src/data.json
npm run vo && npm run music && npm run sfx && npm run timing   # audio and timing (2:18 budget)
# footage: in the repo root, with .env copied in:
#   ZG_ROUTER_API_KEY= ANTHROPIC_API_KEY= PORT=5410 npm run dashboard   (playbook fixer)
npm run capture && npm run encode             # real footage -> public/footage, src/footage.json
node scripts/stills.mjs 120 1000 ...          # check stills -> out/stills (half scale)
npm run draft                                 # half-scale draft
sh scripts/render-final.sh                    # ProRes HQ 4K master -> H.264 4K ~45 Mbps + 1080p ~14 Mbps (-14 LUFS, TP <= -1 dBTP) + thumbnail
```

`script.json` holds every spoken line. `src/timing.json` (from `scripts/timing.mjs`) places each word on the frame where it is spoken, and the scenes animate on those words (`useRel(scene)("word")`).
