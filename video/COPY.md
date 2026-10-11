# Bulwark demo film: post copy

Length 2:18 (137.9 s), under X's 2:20 cap for standard accounts. Upload `bulwark-demo-1080p.mp4`.

## X post (quote-tweet of the official neatlogs post; 278 characters as X counts them)

Your agent passes every test, then refunds a customer twice.

Bulwark is chaos engineering for AI agents: it breaks your agent first, writes the fix, and keeps it only when a Judge proves it.

RefundBot 56% → 100%

#neatHack with neatlogs, Entire, cfo.ai
github.com/mrnetwork0001/Bulwark

## YouTube

**Title:** Bulwark: chaos engineering for AI agents (break it first) | #neatHack 2026

**Description:**

Your agent passes its tests. Then a refund commits, the reply is slow, the agent retries blindly, and pays twice: $98 on a $49 order. That's a real trial, replayed from its seed.

Bulwark breaks your agent before your users do. Red attacks it in a sandbox with real-world faults. Blue writes a fix. An independent Judge re-runs every attack on seeds Blue never saw, and rejected fixes roll back to a checkpoint. Guard proves the regression test.

- RefundBot: 56% → 100% of trials keep every business rule, in 8 attempts with 3 rejected and rolled back
- $553,438 → $0 at risk per 1,000 tickets (stated assumptions)
- SLO 95% demonstrated with 59/59 zero-failure trials; Fisher p < 10⁻⁶
- ResearchBot on real Crustdata data: 49% → 100%. Game day (several faults at once): 43% → 100%
- Self-chaos: 11 faults injected into Bulwark itself, 11 recovered, 5 real bugs fixed

Built during #neatHack (Oct 10 to 12, 2026) with neatlogs (a session per run, a trace per phase, failing traces read back before every fix), Entire (checkpoints and bug provenance) and cfo.ai (the business plan), plus 0G Compute and Crustdata.

Code: https://github.com/mrnetwork0001/Bulwark
cfo.ai plan (read-only): https://app.cfo.ai/s/xAu-NTAidKxJcCm7

Chapters
0:00 A real trial: $98 refunded on a $49 order
0:16 No crash, no failing test: 56%
0:29 Bulwark breaks it first
0:43 Red attacks
0:55 The Judge rejects a fix and rolls back
1:06 59/59 on fresh seeds, and the trace diff
1:22 56% → 100%, $553k → $0
1:35 neatlogs, Entire, cfo.ai
1:51 Any agent, many faults, even itself
2:07 Break it first
