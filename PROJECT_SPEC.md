# Bulwark: Chaos Engineering for AI Agents

**Target Event**: neatHack AI Agent Hackathon (Oct 10–12, 2026, online, one track)
**Goal**: 1st Place
**Submission**: Mon Oct 12, 7:00–11:55 PM IST, by quote-tweeting the official neatlogs post (team, name, project, public repo, demo video)

> **Rule reminder**: code must be written during the hackathon (starts Oct 10, 12:30 PM IST). The repo must be public, with commits dated during the event. This spec is planning only.

## 1. The Core Concept

**Bulwark is an agent that makes other AI agents trustworthy.** It attacks a target agent in a sandbox: tool timeouts, 429 rate limits, malformed tool output, LLM provider outages, duplicate webhooks. It watches the target fail through its neatlogs traces, writes a resilience patch, and proves the patch works by re-running the same attack many times. Then it opens a PR with before/after traces and a resilience score.

The hackathon tagline is *"Build agents you'd trust to run without you watching."* Bulwark is the tool that **earns** that trust for any agent.

### Why agents, not generic microservices (the pivot)
- **The judges' world**: neatlogs sells "find the code behind a failure, then compare runs to verify your fix". Bulwark automates exactly that loop, so the judges will get it immediately.
- **neatlogs becomes the agent's eyes, not just a logger**: Bulwark *reads* the target agent's traces to observe failures. Most teams will only *write* traces.
- **The evidence requirements are built in**: "a run before your change and a run after it, with the numbers you compared" is literally what Bulwark produces.
- **More original**: Gremlin and Steadybit already do chaos engineering for infrastructure. Doing it for LLM agents, with fixes written automatically, is new.
- **No AWS infrastructure needed for the demo**: faults are injected at the tool-call layer, so it can be demoed reliably and cheaply.

## 2. The Demo Target: "RefundBot"

A small, deliberately fragile support agent for a store that uses **Dodo Payments** (hackathon partner) in test mode or behind a mock. Tools: `lookup_order`, `issue_refund`, `send_email`, `search_policy`.

Planted weaknesses, each mapped to a fault and a fix:

| Weakness | Fault Bulwark injects | Observed failure | Fix Bulwark writes |
|---|---|---|---|
| No timeout on `lookup_order` | 10s latency | Run hangs or dies | Timeout + retry with backoff + graceful message |
| Naive retry on `issue_refund` | Timeout after the call succeeded | **Customer refunded twice** | Idempotency key (headline demo moment) |
| Trusts tool JSON | Malformed / truncated response | Crash or hallucinated amount | Schema validation + re-ask |
| Single LLM provider | Provider 5xx / 429 | Whole agent down | Fallback model (e.g., Bedrock) + circuit breaker |
| Unbounded loop | Tool keeps returning "pending" | Token and cost blowup | Step and budget caps |

The double-refund scenario is the story for the demo video: a "harmless" retry that costs real money.

## 3. The Agent Loop

1. **Analyze**: run `entire-graph` on the target repo. Find tool calls and outbound I/O, then rank them by risk (no timeout, side effects, no validation).
2. **Hypothesize**: the LLM proposes a ranked list of experiments, e.g. "If `issue_refund` times out after committing, the retry will double-charge."
3. **Attack**: the chaos layer wraps the target's tools and injects the fault. It runs N trials (e.g., 20) for statistical evidence, not a single anecdote.
4. **Observe**: pull the target's neatlogs traces. Classify each failure as crash, hang, wrong side effect, wrong answer, or cost blowup.
5. **Remediate**: save an Entire checkpoint, then write the patch.
6. **Verify**: run the target's existing tests, then re-run the same N trials. If the score doesn't improve or the tests fail, **restore the checkpoint** and try a different strategy. Capped at K attempts.
7. **Guard**: add a chaos regression test to the target repo so the fix can't silently regress.
8. **Commit**: open a PR containing the diff, a before/after resilience scorecard, neatlogs trace links, and the Entire checkpoint.

## 4. Features That Win Points (mapped to judging)

> **Committed scope**: all 20 unique features in [docs/FEATURES.md](docs/FEATURES.md) will be built, in tier order A → B → C, with a status tracker there. The items below show how they map to the judging criteria.

### The agent (30%)
- **Resilience Scorecard**: per fault, success rate before → after, p95 latency, cost per run, and side-effect violations (e.g., 7/20 double refunds → 0/20).
- **Real recovery, on camera**: at least one fault where Bulwark's first fix fails verification, it rolls back via checkpoint, and it succeeds on attempt 2. Choose a fault where this happens naturally, such as one where a naive retry makes the double refund *worse*.
- **Persistent state**: experiment history (what was tried, what failed, why) survives restarts, so Bulwark never repeats a failed strategy.
- **Safety rails** (the "trust" theme): an allowlist of sandbox targets only, a blast-radius config, a budget cap per run, and a human merges the PR. Bulwark never pushes to main.

### Use of neatlogs, Entire, cfo.ai (25%). Use them deeply, not cosmetically
- **neatlogs (both directions)**:
  - Trace Bulwark's own loop as a span tree (hypothesis → attack → observe → patch → verify, with retries).
  - Trace the target agent too, and have Bulwark **query those traces** to observe failures. neatlogs lists an MCP server and SDKs, so check whether the API/MCP allows reading traces.
  - Use neatlogs to debug Bulwark itself during the build, and keep a before/after trace of Bulwark improving.
- **Entire (two of the five judges are from Entire)**:
  - Use `entire-graph` as Bulwark's weak-link finder, and show the graph output.
  - Save a checkpoint per fix attempt, restore on failed verification, and attach the checkpoint to the PR.
  - **Turn on Entire for the Bulwark repo itself while building with Claude Code.** The rules say to "use neatlogs and Entire to *build and improve* your agent", so the commit history should show checkpoints throughout.
- **cfo.ai**: a business plan for Bulwark as B2B SaaS for teams shipping agents. Inputs: cost per experiment (tokens + compute, measured from neatlogs), price tiers (e.g., per agent per month), runway. The ROI argument: one double-refund incident or one agent outage costs more than a year of Bulwark. Put the real measured cost per run into the model.

### Demo video (20%)
- About 3 minutes: (1) RefundBot double-refunds a customer live; (2) Bulwark finds it, attacks, patches, fails once, rolls back, fixes; (3) scorecard and PR; (4) 20s each on the neatlogs trace, Entire checkpoint/graph, and cfo.ai plan.
- A split screen showing the target's red traces turning green is the money shot.

### Building in public (15%). Plan this, don't improvise it
- Post on X with #neatHack at least 3–4 times a day: kickoff idea, first trace screenshot, first double refund caught, first auto-fix, the "it failed and rolled back" clip, scorecard.
- Tag @neatlogs, Entire and cfo.ai. Quote-tweet early (they engage with the first 50).
- Optional: a short public build log in the repo README.

### Usefulness & originality (10%)
- The pitch: "Unit tests check that your agent works. Bulwark checks that it *keeps working when the world breaks*."

## 5. Evidence Checklist (the submission must link each)
- [ ] Before/after neatlogs traces + scorecard numbers
- [ ] neatlogs trace links/screenshots (Bulwark's own loop + the target's)
- [ ] `entire-graph` output + checkpoints in the repo
- [ ] cfo.ai business plan (pricing, costs, revenue, runway)
- [ ] A run where an action failed and what the agent did next (checkpoint rollback)
- [ ] #neatHack posts
- [ ] Public repo with commits dated Oct 10–12

## 6. Tech Stack
- **TypeScript/Node** for both Bulwark and RefundBot (same repo: `/bulwark`, `/targets/refundbot`).
- **LLM**: Claude for Bulwark's reasoning and patching. Amazon Bedrock as RefundBot's fallback model (a natural AWS tie-in, using credits).
- **Chaos layer**: an in-process tool wrapper (fault injection by config). Optional stretch: Toxiproxy for network faults, AWS FIS only if time allows.
- **PRs**: GitHub via `gh` / Octokit.
- **UI (stretch)**: a minimal live dashboard showing the experiment queue, scorecard and trace links. It helps the video a lot.

## 7. Scope Plan (48 hours)
- **Day 1 (Sat)**: repo + Entire enabled; RefundBot with neatlogs tracing; chaos wrapper with 2 faults; first "before" traces. Post progress.
- **Day 2 (Sun)**: Bulwark loop end to end on the timeout fault, then the double refund; checkpoint rollback; scorecard; PR creation. Attend office hours to confirm the neatlogs trace-read API.
- **Day 3 (Mon)**: the remaining faults; cfo.ai plan from real numbers; dashboard polish; record the video by about 5 PM IST; submit early in the 7:00 PM window.

**Feature order**: core loop → Tier A (Sat night–Sun) → Tier B (Sun–Mon morning) → Tier C (Mon, until the video freeze at ~5 PM IST). See [docs/FEATURES.md](docs/FEATURES.md).

**If behind schedule, drop from the end** (Tier C, then Tier B). **Never cut**: before/after evidence, checkpoint rollback, the cfo.ai plan, Tier A.

## 8. Open Questions to Verify at Kickoff
- Does neatlogs expose an API/MCP to *read* traces programmatically? (Fallback: Bulwark also records the target's run results locally.)
- How do Entire checkpoints integrate programmatically (CLI vs SDK), and what exactly does `entire-graph` output?
- What does the FAQ "What can I build beforehand?" allow? Can the target-agent scaffold be prepared early?
- Are there team-size rules?
