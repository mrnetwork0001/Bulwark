# How Bulwark uses Entire

Bulwark uses [Entire](https://docs.entire.io/overview) in three ways (the third, Entire Graph, is described at the end):

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

## Entire Graph in the loop (Red blast radius, Blue fix sites)

The `entire graph` plugin (v0.4.0, `~/.local/bin/entire graph`) is a local code graph with no network egress. Bulwark calls it through `bulwark/red/graph.ts`:

- **Red, analyze step.** For each weak link, `entire graph impact --symbol <file>:<line> --format json --exclude-tests --depth 2` returns the enclosing symbol and its callers. Bulwark keeps code callers only (doc and evidence mentions are dropped) and attaches them to the finding as `blast: { focus, callers }`. The blast radius is shown in the CLI under each finding, in each postmortem's "Weak links found in the code" section, and in the live `analyze` event. For RefundBot it reads `createTools (function, targets/refundbot/tools.ts:76) ← 1 caller: runRefundBot (targets/refundbot/agent.ts:54)`. RefundBot's tools are closures inside `createTools`, so every tool finding resolves to that function. That is the real enclosing symbol.
- **Blue, before each fault.** `entire graph search --query "<fault hypothesis>" --format json --profile full` ranks fix sites. The graph indexes the whole repo, including Bulwark itself, so Bulwark keeps only hits inside the target and passes the top 3 (with their source) to the Claude fixer as "## Where Entire Graph says to look". For `timeout-after-commit`, the top hit is `targets/refundbot/tools.ts:51-59 withTimeout`.
- **Against the committed target, not the patched copy.** The loop's patched code lives in `.bulwark/runs/<id>/ws/`, which is gitignored and outside the tree the graph indexes. Graph queries therefore run against the original target in the repo (`targets/refundbot`), from the repo root.
- **Never blocks.** If the plugin isn't installed, `entire graph version` fails, and the loop logs "Entire Graph not available" and carries on with static analysis only. Any failed query returns nothing. Set `BULWARK_ENTIRE_GRAPH=0` to switch it off.

Verify it yourself:

```bash
entire graph version                                                     # v0.4.0
entire graph impact --symbol targets/refundbot/tools.ts:87 --repo . --exclude-tests --depth 2 --format text
entire graph search --repo . --query "If a refund succeeds but the response is slow, the blind retry refunds the customer twice." --top-k 8 --format agent --profile full
npm run fix -- --fixer playbook --fault timeout-after-commit --max-attempts 1   # "blast radius (Entire Graph)" under each RED finding
BULWARK_ENTIRE_GRAPH=0 npm run fix -- --fixer playbook --fault timeout-after-commit --max-attempts 1   # same run, graph switched off
grep -A1 "Blast radius (Entire Graph)" .bulwark/runs/*/postmortem-timeout-after-commit.md | tail -3
```

## Publishing checkpoints safely

Entire redacts secrets in transcript text, but images pasted into a session (screenshots) are stored as base64 and can show things like API keys. Before pushing checkpoints, run the sanitizer: it replaces every image with a placeholder, scrubs any `.env` secret values, and recomputes `content_hash.txt`. Checkpoint ids stay the same, so commit trailers still resolve.

```bash
python3 scripts/sanitize-entire-checkpoints.py            # rewrite local refs/entire/*, then self-check
python3 scripts/sanitize-entire-checkpoints.py --check    # must print "0 unsafe" before you push
git push --force origin 'refs/entire/*:refs/entire/*'
```

Automatic checkpoint pushing is off (`push_sessions: false` in `.entire/settings.json`), so checkpoints only leave this machine through that command.
