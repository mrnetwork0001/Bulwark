# Bulwark — Claude Code Project Context

Bulwark is a chaos-engineering agent for AI agents, built for **neatHack** (Oct 10–12, 2026). Full plan: [PROJECT_SPEC.md](PROJECT_SPEC.md). Feature backlog: [docs/FEATURES.md](docs/FEATURES.md).

## Hard rules (disqualification risks)
- All code must be written **during the hackathon** (from Oct 10, 12:30 PM IST). The repo must be **public**, with commits dated Oct 10–12.
- The project **must use neatlogs, Entire and cfo.ai**. Every one of them must leave checkable evidence (see [docs/SUBMISSION_CHECKLIST.md](docs/SUBMISSION_CHECKLIST.md)).
- Submission window: **Mon Oct 12, 7:00–11:55 PM IST**, by quote-tweeting the official neatlogs post.

## Scope
All 20 features in [docs/FEATURES.md](docs/FEATURES.md) are committed scope. Build them in tier order (A → B → C) on top of the core loop, and update their status in that file as each one ships, with evidence captured.

## Working conventions
- Commit small and often. Commit history is evidence for the judges (dated commits plus Entire checkpoints).
- Entire must be enabled on this repo while building, so the checkpoints show we used it "to build and improve the agent".
- Every LLM and tool call in both Bulwark and the target agent must be traced with neatlogs.
- Never commit secrets. Keys go in `.env` (gitignored), and `.env.example` lists the names.
- Bulwark only attacks targets on its allowlist (`targets/`). It never pushes to `main`; it opens PRs.

## Repo layout (planned)
```
bulwark/            # the chaos agent (analyze → hypothesize → attack → observe → remediate → verify → commit)
  chaos/            # tool-call fault injection layer
  scorecard/        # trials, stats, before/after report
targets/refundbot/  # deliberately fragile demo agent (Dodo Payments refunds)
docs/               # submission, demo, build-in-public, business plan
```

## Stack
TypeScript/Node, Claude (Bulwark's reasoning), Amazon Bedrock (RefundBot's fallback model), neatlogs SDK, Entire (graph + checkpoints), GitHub via `gh`/Octokit.
