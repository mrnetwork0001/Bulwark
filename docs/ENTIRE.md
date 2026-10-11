# How Bulwark uses Entire

Bulwark uses [Entire](https://docs.entire.io/overview) in two ways:

1. **While we build Bulwark.** Entire is enabled on this repo for Claude Code. Each commit made during an agent session gets an `Entire-Checkpoint: <id>` trailer, and the session (prompt, transcript, subagent transcripts, token usage) is stored as a git ref `refs/entire/checkpoints/<shard>/<id>`.
2. **Inside Bulwark's reports (feature #22, bug provenance).** Red's analyzer finds weak links at a file and line. Bulwark traces each line back to the commit that introduced it, and through Entire to the AI coding session, prompt and checkpoint behind that commit. The result is shown in the postmortem, the PR body, the CLI output and the live `analyze` event.

## Verify it yourself

Run these from the repo root. Entire CLI 0.11.4 is installed at `~/.local/bin/entire`.

```bash
entire status                          # enabled, agent "Claude Code", active session
entire status --json
entire checkpoint list                 # checkpoints on this branch (imported history + new ones)
git for-each-ref refs/entire/          # the checkpoint refs themselves
git log --format='%h %s%n  %(trailers:key=Entire-Checkpoint)' | head -20   # which commits carry a trailer

entire why docs/FEATURES.md:63 --json            # a line written in a checkpointed session
entire checkpoint explain 01M4MGGKEQXJR07RTC3SAJQ3P8 --short

npm run provenance -- targets/refundbot/tools.ts:87   # Bulwark's provenance for one line
npm run provenance -- --target targets/refundbot      # ...for every weak link Red finds
npm run provenance -- targets/refundbot/tools.ts:87 --json
npm run fix -- --fixer playbook                       # provenance appears under RED and in .bulwark/runs/<id>/PR.md
```

Checkpoint refs are local unless pushed (`checkpoint_push_disabled` is true in `entire status --json`). A fresh clone of the GitHub repo has the `Entire-Checkpoint:` trailers in its commit messages but not the session data. Run `git fetch origin 'refs/entire/*:refs/entire/*'` after the refs are pushed.

## How provenance is resolved

`bulwark/provenance/entire.ts` takes a repo-relative `file:line` and tries each source in order, using the best evidence it finds:

| Step | Source | What it gives |
|---|---|---|
| 1 | `entire why <file>:<line> --json` | Entire's own line attribution. When the blamed commit has a checkpoint: checkpoint, session, agent, model and prompt. |
| 2 | `git blame --porcelain` → the commit's `Entire-Checkpoint:` trailer → `refs/entire/checkpoints/<id[-2:]>/<id>`:`0/metadata.json` and `0/prompt.txt` | The same answer without the Entire CLI. |
| 2b | the checkpoint's `tasks/<id>/agent-*.jsonl` and `task.json` | When the checkpoint has no prompt because subagents did the work: the subagent task whose transcript wrote this exact line. |
| 3 | Transcript match in imported sessions | For commits made before Entire's hooks were installed. If a session that Entire imported has a `Write`/`Edit` tool call that put this exact line (compared trimmed) into this file after the parent commit and before this commit, Bulwark names that session and the prompt of the checkpoint whose transcript holds the write. This is labelled `match: transcript`. |
| 4 | Plain `git blame` | Commit, author, date and subject, plus the reason no session was linked. |

Every step degrades without crashing. If Entire isn't installed, the repo has no checkpoints, the line is uncommitted, or the file is outside git, the record says so in `note`, and the loop carries on. Set `BULWARK_PROVENANCE=0` to skip provenance entirely.

Each `Provenance` record has: `source` (`entire` | `git` | `unavailable`), `match` (`checkpoint` | `transcript`), `commit`, `author`, `date`, `subject`, `checkpointId`, `sessionId`, `agent`, `model`, `prompt`, `task`, `writtenAt` and `note`.

## What is real today (checked Oct 11 2026)

- **Commits before `e44db55` have no checkpoint trailer.** Entire was enabled at `e44db55`. Entire also imported this project's earlier Claude Code session (`8cdad8b4…`) as 19 `import` checkpoints. All of them are attached to `5ad8d7f`, the HEAD at import time, not to the commits that wrote the code. So `entire why targets/refundbot/tools.ts:87` reports the line as `[HU]` (no checkpoint) at `cf0ceac`.
- **Bulwark's transcript match recovers the real session for RefundBot's weak links.** The imported transcript in checkpoint `01M4JHF2GWEP2029BVPZ8A9WQ1` (prompt "start building something for this app", 09:14Z) contains the `Write` of `targets/refundbot/tools.ts` at 09:17:08Z. That write includes line 87 verbatim, and it happened 3 minutes before commit `cf0ceac` (09:20:18Z). All seven RefundBot findings (`tools.ts:79`, `:87`, `:101` and `agent.ts:56`) resolve this way. They are reported as `match: transcript` and are never presented as a trailer link.
- **The exact checkpoint path is real.**
  - `docs/FEATURES.md:63` (the Tier D section) resolves through `entire why` to checkpoint `01M4MGGKEQXJR07RTC3SAJQ3P8` on commit `e44db55`, with its session and prompt.
  - The feature's own commit, `752c56e`, was made from a Claude Code subagent. Entire's `prepare-commit-msg` hook added `Entire-Checkpoint: 01M4MH8FJRZJJ7TFJQB0Y6S14V`, and the post-commit hook wrote `refs/entire/checkpoints/4V/01M4MH8FJRZJJ7TFJQB0Y6S14V`. That checkpoint has no top-level prompt (the work was done by subagents). Bulwark reads the subagent transcripts stored in it and names the task that wrote the line: `npm run provenance -- bulwark/provenance/entire.ts:1` → "via subagent task "Entire bug provenance"". Entire marks this link `session_fallback` (the new file isn't in the checkpoint's `files_touched`), and Bulwark says so.
- **Some lines fall back to git.** For example, `bulwark/report/reports.ts:9` (commit `ae0406c`) has no trailer, and no imported transcript wrote that exact line. That work was done by subagents, whose transcripts were not part of the import. Bulwark reports the commit, author and date, and says no session could be linked.
- **The residual findings in the PR body ("Remaining risk") get no provenance.** They point at the patched copy in `.bulwark/runs/<id>/ws`, which is not committed.
