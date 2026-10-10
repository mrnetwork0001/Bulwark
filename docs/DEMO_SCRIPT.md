# Demo Video Script (20% of the score) — target 3:00, hard cap 4:00

Record by **Mon ~5 PM IST**. Use a screen recorder at 1080p, with zoom-ins on traces. Keep a backup recording of each segment in case a live run misbehaves.

| Time | Segment | On screen | Voiceover gist |
|---|---|---|---|
| 0:00–0:20 | Hook | RefundBot refunds a customer **twice** | "This agent passes all its tests. It also just refunded a customer twice." |
| 0:20–0:40 | Pitch | Title card + one-line pitch | "Bulwark attacks your AI agents in a sandbox, fixes what breaks, and proves the fix." |
| 0:40–1:00 | Analyze | `entire-graph` output, risky tool calls ranked | Entire maps the repo and finds the weak links |
| 1:00–1:30 | Attack + observe | Fault injected, RefundBot's neatlogs traces turn red | 20 trials, failures classified from the traces |
| 1:30–2:05 | Remediate + **recover** | Fix #1 fails verification → Entire checkpoint restore → fix #2 passes | The agent recovers from its own mistakes |
| 2:05–2:30 | Proof | Scorecard before/after + side-by-side traces + the opened PR | Numbers judges can check |
| 2:30–2:50 | Business | cfo.ai plan: price, cost per experiment, runway | The cost of one incident vs Bulwark per year |
| 2:50–3:00 | Close | Repo URL, #neatHack | "Agents you can trust to run without you watching." |

## Must explicitly show (judges score tool usage via the video)
- [ ] A neatlogs span tree of Bulwark's own loop
- [ ] neatlogs traces of the target, before vs after
- [ ] An Entire checkpoint being restored + `entire-graph` output
- [ ] The cfo.ai business plan
