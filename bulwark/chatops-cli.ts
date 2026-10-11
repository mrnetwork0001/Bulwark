// npm run chatops -- [--out .bulwark/chatops/reply.md]
//
// Runs one `/bulwark …` PR-comment command (see bulwark/chatops.ts) and writes
// the markdown reply for the workflow to post. Untrusted inputs arrive only as
// environment variables, never on a command line:
//   BULWARK_COMMENT_BODY                 the comment text
//   BULWARK_COMMENT_AUTHOR_ASSOCIATION   OWNER | MEMBER | COLLABORATOR (anything else is refused)
//   BULWARK_PR_HEAD_REF, BULWARK_PR_BASE_REF, BULWARK_PR_IS_FORK   for `fix … pr`
//   BULWARK_RUN_URL                      link back to the workflow run
// Commands run via spawn with argv arrays (shell: false). No reply file is
// written when the comment holds no /bulwark command.

import './env';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { faultsFor } from './chaos/faults';
import { commandArgv, describe, helpText, isAllowedAuthor, parseCommand, renderFixReply, renderReplayReply, safeFixBranch, wrapReply, type ChatCommand, type ChatContext } from './chatops';
import { describeEvent, type ReplayResult } from './replay';
import { listTargets } from './target';

const TIMEOUT_MS = 25 * 60_000;

function run(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: (res.stderr ?? '') + (res.error ? String(res.error) : '') };
}

const tail = (s: string, n = 30) => s.trim().split('\n').slice(-n).join('\n');
const failed = (what: string, r: { stdout: string; stderr: string }) => `❌ ${what} failed.\n\n\`\`\`\n${tail(r.stderr || r.stdout)}\n\`\`\``;

function execute(cmd: ChatCommand, ctx: ChatContext): string {
  const argv = commandArgv(cmd);
  if (cmd.kind === 'help' || !argv) return helpText(ctx);
  console.log(`chatops: /bulwark ${describe(cmd)} → npm ${argv.join(' ')}`);
  const r = run('npm', argv);

  if (cmd.kind === 'attack') {
    if (!r.ok) return failed('The chaos run', r);
    const dir = /Scorecard written to (\S+?)\/?$/m.exec(r.stdout)?.[1];
    const md = dir && existsSync(join(dir, 'scorecard.md')) ? readFileSync(join(dir, 'scorecard.md'), 'utf8') : undefined;
    return md ? md.replace(/^# Bulwark scorecard/m, '### 💥 Bulwark scorecard') : `\`\`\`\n${tail(r.stdout, 40)}\n\`\`\``;
  }

  if (cmd.kind === 'replay') {
    if (!r.ok) return failed('The replay', r);
    const json = r.stdout.slice(r.stdout.indexOf('{'));
    const rep = JSON.parse(json) as ReplayResult;
    return renderReplayReply(rep, rep.timeline.map((e) => `${String(e.t).padStart(6)}ms  ${describeEvent(e)}`));
  }

  // fix
  if (!r.ok) return failed('The Bulwark loop', r);
  const latest = JSON.parse(readFileSync(join('.bulwark', 'latest.json'), 'utf8')) as { runId: string; dir: string };
  const summary = JSON.parse(readFileSync(join(latest.dir, 'summary.json'), 'utf8'));
  if (!cmd.pr) return renderFixReply(summary);
  if (!summary.fixed.length) return renderFixReply(summary, { note: 'No verified fixes, so no branch or PR was created.' });

  const branch = `bulwark/fix-${summary.runId}`;
  const head = process.env.BULWARK_PR_HEAD_REF ?? '';
  const base = process.env.BULWARK_PR_BASE_REF ?? '';
  if (!safeFixBranch(branch, [head, base])) return renderFixReply(summary, { note: `Refused to push \`${branch}\`: not a bulwark/fix-* branch, or it would overwrite this PR's branch or main.` });
  if (process.env.BULWARK_PR_IS_FORK === 'true') return renderFixReply(summary, { branch, note: 'This PR comes from a fork, so the fix branch was not pushed (a PR into a fork branch is not possible).' });
  const push = run('git', ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  if (!push.ok) return renderFixReply(summary, { branch, note: `git push failed: ${tail(push.stderr, 3)}` });
  // Into the PR's own branch, so the diff shows only Bulwark's fixes; main is never touched.
  const prArgs = ['pr', 'create', '--head', branch, '--title', `Bulwark: resilience fixes for ${summary.target}`, '--body-file', summary.artifacts.pr, ...(head ? ['--base', head] : [])];
  const pr = run('gh', prArgs);
  return renderFixReply(summary, pr.ok ? { branch, pr: pr.stdout.trim() } : { branch, note: `gh pr create failed: ${tail(pr.stderr, 3)}` });
}

function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: join('.bulwark', 'chatops', 'reply.md') } } });
  const ctx: ChatContext = { targets: listTargets(), faults: (t) => faultsFor(t).map((f) => f.id) };
  const parsed = parseCommand(process.env.BULWARK_COMMENT_BODY ?? '', ctx);
  if (!parsed) return console.log('chatops: no /bulwark command in the comment');
  mkdirSync(dirname(values.out!), { recursive: true });
  const runUrl = process.env.BULWARK_RUN_URL;

  let reply: string;
  if (!isAllowedAuthor(process.env.BULWARK_COMMENT_AUTHOR_ASSOCIATION)) {
    reply = wrapReply(undefined, '🔒 Only repository owners, members and collaborators can run Bulwark commands.', runUrl);
  } else if (!parsed.ok) {
    reply = wrapReply(undefined, `⚠️ ${parsed.error}\n\nComment \`/bulwark help\` for usage.`, runUrl);
  } else {
    let body: string;
    try {
      body = execute(parsed.command, ctx);
    } catch (err) {
      body = `❌ ${err instanceof Error ? err.message : String(err)}`;
    }
    reply = wrapReply(parsed.command, body, runUrl);
  }
  // GitHub comments cap at 65,536 characters.
  writeFileSync(values.out!, reply.length > 60_000 ? reply.slice(0, 60_000) + '\n\n… (truncated; see the workflow artifact)\n' : reply);
  console.log(`chatops: reply written to ${values.out}`);
}

main();
