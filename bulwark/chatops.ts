// ChatOps: `/bulwark …` commands in PR comments. This module only parses and
// validates; it never runs anything. Comment text is untrusted: every token must
// be a plain name, targets must be on the allowlist and faults in that target's
// catalog, and the result is an argv array (no shell ever sees the comment).
//
//   /bulwark help
//   /bulwark attack [target] [fault|all]      offline chaos scorecard
//   /bulwark fix [target] [pr]                playbook loop; "pr" pushes verified fixes to bulwark/fix-* and opens a PR
//   /bulwark replay [target] <fault> <seed>   one trial's timeline

export type ChatCommand =
  | { kind: 'help' }
  | { kind: 'attack'; target: string; fault: string }
  | { kind: 'fix'; target: string; pr: boolean }
  | { kind: 'replay'; target: string; fault: string; seed: number };

export interface ChatContext {
  /** Allowlisted target names (directories under targets/ with a bulwark.target.ts). */
  targets: string[];
  /** Fault ids in a target's catalog. */
  faults: (target: string) => string[];
  defaultTarget?: string;
}

export type ParseResult = { ok: true; command: ChatCommand } | { ok: false; error: string };

/** Only people with write access can make the bot run code and push branches. */
export const ALLOWED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;
export const isAllowedAuthor = (association: string | undefined) => (ALLOWED_ASSOCIATIONS as readonly string[]).includes(association ?? '');

const TOKEN = /^[A-Za-z0-9][\w.-]{0,63}$/;
const MAX_LINE = 200;
export const REPLY_MARKER = '<!-- bulwark-chatops -->';

/**
 * Finds the first line that starts with `/bulwark` and parses it. Returns null
 * when the comment has no command at all (the bot stays quiet).
 */
export function parseCommand(body: string, ctx: ChatContext): ParseResult | null {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\/bulwark(\s|$)/i.test(l));
  if (line === undefined) return null;
  if (line.length > MAX_LINE) return fail('command is too long');
  const [, ...tokens] = line.split(/\s+/);
  if (tokens.some((t) => !TOKEN.test(t))) return fail('arguments must be plain names or numbers (letters, digits, ".", "_", "-")');
  const [verb = 'help', ...args] = tokens;
  const defaultTarget = ctx.defaultTarget ?? (ctx.targets.includes('refundbot') ? 'refundbot' : ctx.targets[0]);
  const isTarget = (t: string | undefined) => !!t && ctx.targets.includes(t);
  const checkFault = (target: string, fault: string, allowAll: boolean): string | undefined => {
    if (allowAll && fault === 'all') return undefined;
    if (fault === 'baseline' && !allowAll) return undefined;
    return ctx.faults(target).includes(fault) ? undefined : `unknown fault "${fault}" for ${target}. Known: ${ctx.faults(target).join(', ')}`;
  };

  switch (verb.toLowerCase()) {
    case 'help':
      return args.length ? fail('help takes no arguments') : ok({ kind: 'help' });

    case 'attack': {
      if (args.length > 2) return fail('usage: /bulwark attack [target] [fault|all]');
      let target = defaultTarget;
      let rest = args;
      if (isTarget(args[0])) [target, ...rest] = args;
      else if (args.length === 2) return fail(`unknown target "${args[0]}". Allowed: ${ctx.targets.join(', ')}`);
      if (!target) return fail('no targets on the allowlist');
      const fault = rest[0] ?? 'all';
      const bad = checkFault(target, fault, true);
      return bad ? fail(bad) : ok({ kind: 'attack', target, fault });
    }

    case 'fix': {
      if (args.length > 2) return fail('usage: /bulwark fix [target] [pr]');
      let target = defaultTarget;
      let rest = args;
      if (isTarget(args[0])) [target, ...rest] = args;
      if (!target) return fail('no targets on the allowlist');
      if (rest.length > 1 || (rest[0] !== undefined && rest[0].toLowerCase() !== 'pr')) {
        return fail(isTarget(args[0]) || args[0]?.toLowerCase() === 'pr' ? 'usage: /bulwark fix [target] [pr]' : `unknown target "${args[0]}". Allowed: ${ctx.targets.join(', ')}`);
      }
      return ok({ kind: 'fix', target, pr: rest[0]?.toLowerCase() === 'pr' });
    }

    case 'replay': {
      let target = defaultTarget;
      let rest = args;
      if (args.length === 3) {
        if (!isTarget(args[0])) return fail(`unknown target "${args[0]}". Allowed: ${ctx.targets.join(', ')}`);
        [target, ...rest] = args;
      }
      if (rest.length !== 2) return fail('usage: /bulwark replay [target] <fault> <seed>');
      if (!target) return fail('no targets on the allowlist');
      const [fault, seedText] = rest;
      const bad = checkFault(target, fault, false);
      if (bad) return fail(bad);
      if (!/^\d{1,10}$/.test(seedText) || Number(seedText) > 0xffffffff) return fail('seed must be a whole number between 0 and 4294967295');
      return ok({ kind: 'replay', target, fault, seed: Number(seedText) });
    }

    default:
      return fail('unknown command. Try `/bulwark help`');
  }
}

const ok = (command: ChatCommand): ParseResult => ({ ok: true, command });
const fail = (error: string): ParseResult => ({ ok: false, error });

/**
 * The npm invocation for a command, as an argv array for spawn (shell: false).
 * Every value in it has already been validated by parseCommand.
 */
export function commandArgv(cmd: ChatCommand): string[] | null {
  switch (cmd.kind) {
    case 'help':
      return null;
    case 'attack':
      return ['run', '--silent', 'chaos', '--', '--target', `targets/${cmd.target}`, '--fault', cmd.fault, '--trials', '20', '--seed', '42', '--brain', 'simulated'];
    case 'fix':
      return ['run', '--silent', 'fix', '--', '--target', `targets/${cmd.target}`, '--fixer', 'playbook', '--neatlogs-wait', '0', ...(cmd.pr ? ['--apply'] : [])];
    case 'replay':
      return ['run', '--silent', 'replay', '--', '--target', cmd.target, '--fault', cmd.fault, '--seed', String(cmd.seed), '--json'];
  }
}

/** A branch ChatOps may push: only Bulwark's own fix branches, never the PR's head or the default branch. */
export function safeFixBranch(branch: string, protectedRefs: string[]): boolean {
  if (!/^bulwark\/fix-[\w-]{1,100}$/.test(branch)) return false;
  return !protectedRefs.filter(Boolean).some((r) => r.replace(/^refs\/heads\//, '') === branch) && branch !== 'main' && branch !== 'master';
}

export function helpText(ctx: ChatContext): string {
  return [
    '**Bulwark ChatOps** (repository collaborators only)',
    '',
    '| Command | What it does |',
    '|---|---|',
    '| `/bulwark attack [target] [fault\\|all]` | Offline chaos scorecard (simulated brain, 20 trials per fault, seed 42) |',
    '| `/bulwark fix [target] [pr]` | Runs the attack → fix → verify loop with the playbook fixer and replies with resilience before → after. With `pr`, pushes the verified fixes to a new `bulwark/fix-*` branch and opens a PR into this PR\'s branch (never pushes to this branch or main) |',
    '| `/bulwark replay [target] <fault> <seed>` | Re-runs one trial from its seed and replies with its timeline |',
    '| `/bulwark help` | This message |',
    '',
    `Targets: ${ctx.targets.map((t) => `\`${t}\``).join(', ')}.`,
    ...ctx.targets.map((t) => `- \`${t}\` faults: ${ctx.faults(t).map((f) => `\`${f}\``).join(', ')}`),
  ].join('\n');
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The reply to a `/bulwark fix`, from the run's summary. */
export function renderFixReply(s: {
  target: string;
  runId: string;
  overallBefore: number;
  overallAfter: number;
  fixed: string[];
  unfixed: string[];
  skipped: string[];
  attempts: number;
  rollbacks: number;
  residual: { file: string; line: number; why: string }[];
}, extra: { pr?: string; branch?: string; note?: string } = {}): string {
  return [
    `### 🛡️ Bulwark fix: ${s.target}`,
    '',
    `**Resilience ${pct(s.overallBefore)} → ${pct(s.overallAfter)}** · fixed ${s.fixed.length}, unfixed ${s.unfixed.length}, skipped ${s.skipped.length} · ${s.attempts} attempts, ${s.rollbacks} rollbacks`,
    '',
    `- Fixed: ${s.fixed.map((f) => `\`${f}\``).join(', ') || 'none'}`,
    `- Unfixed: ${s.unfixed.map((f) => `\`${f}\``).join(', ') || 'none'}`,
    ...(s.residual.length ? [`- Top remaining risk: \`${s.residual[0].file}:${s.residual[0].line}\` ${s.residual[0].why}`] : []),
    ...(extra.pr ? [`- Pull request with the verified fixes: ${extra.pr} (branch \`${extra.branch}\`)`] : extra.branch ? [`- Committed to branch \`${extra.branch}\``] : []),
    ...(extra.note ? [`- ${extra.note}`] : []),
    '',
    `<sub>run \`${s.runId}\` · playbook fixer, simulated brain, no API keys · full report in the workflow artifact</sub>`,
  ].join('\n');
}

/** The reply to a `/bulwark replay`, from the replay JSON and one described line per event. */
export function renderReplayReply(r: { target: string; fault: string; seed: number; broken: { rule: string; detail?: string }[] }, lines: string[]): string {
  const MAX = 80;
  return [
    `### 🔁 Replay: ${r.target} · \`${r.fault}\` · seed ${r.seed}`,
    '',
    '```',
    ...lines.slice(0, MAX),
    ...(lines.length > MAX ? [`… ${lines.length - MAX} more events`] : []),
    '```',
    '',
    r.broken.length ? r.broken.map((b) => `- ❌ ${b.rule}${b.detail ? `: ${b.detail}` : ''}`).join('\n') : '✅ Every rule held.',
  ].join('\n');
}

/** Wraps any reply with the marker and the command that produced it. */
export function wrapReply(cmd: ChatCommand | undefined, body: string, runUrl?: string): string {
  const shown = cmd ? `\`/bulwark ${describe(cmd)}\`` : '`/bulwark`';
  return [REPLY_MARKER, `> ${shown}`, '', body, '', ...(runUrl ? [`<sub>[Workflow run](${runUrl})</sub>`] : [])].join('\n');
}

export function describe(cmd: ChatCommand): string {
  switch (cmd.kind) {
    case 'help':
      return 'help';
    case 'attack':
      return `attack ${cmd.target} ${cmd.fault}`;
    case 'fix':
      return `fix ${cmd.target}${cmd.pr ? ' pr' : ''}`;
    case 'replay':
      return `replay ${cmd.target} ${cmd.fault} ${cmd.seed}`;
  }
}
