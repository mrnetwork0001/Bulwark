// Bug provenance: trace a line of the target's code back to the AI coding
// session, prompt and Entire checkpoint that introduced it.
//
// Resolution order, best evidence first:
//   1. `entire why <file>:<line> --json`: Entire's own line attribution. When the
//      blamed commit carries an `Entire-Checkpoint:` trailer, this names the
//      checkpoint, session, agent, model and prompt.
//   2. `git blame --porcelain` → the commit's `Entire-Checkpoint:` trailer → the
//      checkpoint ref's metadata (refs/entire/checkpoints/<shard>/<id>). Same
//      answer as (1), for when the Entire CLI isn't installed.
//   3. Transcript match: commits made before Entire's git hooks were enabled have
//      no trailer, but `entire` can import earlier sessions. If an imported
//      session's transcript wrote this exact line to this file before the commit,
//      that session and prompt are named, marked as a transcript match.
//   4. Plain git blame (commit, author, date, subject), with the reason no
//      checkpoint was found.
// Nothing here is guessed: every field comes from git, the Entire CLI or an
// Entire checkpoint ref, and a missing link is reported as missing.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface Provenance {
  /** Repo-relative path and line that was traced. */
  file: string;
  line: number;
  /** 'entire': an Entire checkpoint/session is linked; 'git': blame only; 'unavailable': not even git. */
  source: 'entire' | 'git' | 'unavailable';
  /** How the Entire link was made: the commit's checkpoint trailer, or a line-text match in an imported transcript. */
  match?: 'checkpoint' | 'transcript';
  commit?: string;
  author?: string;
  /** Author date, ISO 8601. */
  date?: string;
  subject?: string;
  checkpointId?: string;
  sessionId?: string;
  agent?: string;
  model?: string;
  prompt?: string;
  /** For transcript matches: when the session wrote the line. */
  writtenAt?: string;
  /** Why the answer is degraded (no checkpoint, Entire missing, uncommitted line...). */
  note?: string;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The executable wasn't found. */
  missing?: boolean;
}
export type Runner = (cmd: string, args: string[], cwd: string) => RunResult;

export const defaultRunner: Runner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 30_000 });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '').trim() || (r.error ? String(r.error.message) : ''),
    missing: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  };
};

export interface ProvenanceOptions {
  run?: Runner;
  /** Entire executable; defaults to $ENTIRE_BIN, then `entire` on PATH, then ~/.local/bin/entire. */
  entireBin?: string;
  /** Directory to resolve `file` from and run git in (default: process.cwd()). */
  cwd?: string;
  /** Skip the transcript match (step 3). */
  transcripts?: boolean;
}

const ZERO_SHA = /^0+$/;
const short = (sha?: string) => sha?.slice(0, 7);

function entireCandidates(opts: ProvenanceOptions): string[] {
  if (opts.entireBin) return [opts.entireBin];
  if (process.env.ENTIRE_BIN) return [process.env.ENTIRE_BIN];
  const local = join(homedir(), '.local', 'bin', 'entire');
  return opts.run || !existsSync(local) ? ['entire'] : ['entire', local];
}

// ---- Parsers (pure; unit-tested) ----

export interface BlameInfo {
  commit: string;
  author: string;
  date: string;
  subject: string;
  content: string;
}

/** Parses `git blame --porcelain -L n,n` output for a single line. */
export function parseBlamePorcelain(out: string): BlameInfo | undefined {
  const lines = out.split('\n');
  const head = lines[0]?.match(/^([0-9a-f]{40}) \d+ \d+/);
  if (!head) return undefined;
  const field = (k: string) => lines.find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? '';
  const time = Number(field('author-time'));
  return {
    commit: head[1],
    author: field('author'),
    date: Number.isFinite(time) && time > 0 ? new Date(time * 1000).toISOString() : '',
    subject: field('summary'),
    content: lines.find((l) => l.startsWith('\t'))?.slice(1) ?? '',
  };
}

/** Extracts the `Entire-Checkpoint:` trailer value(s) from a commit message. */
export function parseCheckpointTrailer(message: string): string | undefined {
  const all = [...message.matchAll(/^Entire-Checkpoint:\s*([0-9A-Za-z]+)\s*$/gm)].map((m) => m[1]);
  return all.at(-1);
}

/** Checkpoint refs are sharded by the id's last two characters: refs/entire/checkpoints/1C/01M4…1C. */
export function checkpointRef(id: string): string {
  return `refs/entire/checkpoints/${id.slice(-2)}/${id}`;
}

export interface WhyLine {
  commit?: string;
  author?: string;
  date?: string;
  authorship?: string;
  checkpointId?: string;
  sessionId?: string;
  agent?: string;
  model?: string;
  prompt?: string;
}

/** Parses `entire why <file>:<line> --json` (Entire CLI 0.11). */
export function parseEntireWhy(json: string): WhyLine | undefined {
  let d: any;
  try {
    d = JSON.parse(json);
  } catch {
    return undefined;
  }
  const l = d?.line;
  if (!l || typeof l !== 'object') return undefined;
  const c = l.checkpoint_id ? (d.checkpoints?.[l.checkpoint_id] ?? {}) : {};
  return {
    commit: l.commit_sha,
    author: l.author,
    date: l.author_time,
    authorship: l.authorship,
    checkpointId: l.checkpoint_id ?? undefined,
    sessionId: l.session_id ?? c.session_id,
    agent: l.agent ?? c.agent,
    model: l.model ?? c.model,
    prompt: l.prompt ?? c.prompt,
  };
}

export interface SessionMeta {
  checkpointId: string;
  sessionId?: string;
  agent?: string;
  model?: string;
  createdAt?: string;
  transcriptStart?: number;
}

/** Parses a checkpoint's per-session metadata.json (`0/metadata.json` in the ref's tree). */
export function parseSessionMetadata(json: string): SessionMeta | undefined {
  try {
    const d = JSON.parse(json);
    if (!d?.checkpoint_id) return undefined;
    return {
      checkpointId: d.checkpoint_id,
      sessionId: d.session_id,
      agent: d.agent,
      model: d.model,
      createdAt: d.created_at,
      transcriptStart: typeof d.checkpoint_transcript_start === 'number' ? d.checkpoint_transcript_start : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface TranscriptWrite {
  /** 0-based line index in the transcript JSONL. */
  index: number;
  timestamp: string;
  tool: string;
}

/**
 * Finds the agent's file writes in a Claude Code transcript (JSONL) that put
 * `content` (one line of code, compared trimmed) into a file ending in `repoPath`.
 */
export function findTranscriptWrites(jsonl: string, repoPath: string, content: string): TranscriptWrite[] {
  const needle = content.trim();
  if (needle.length < 8) return []; // too generic to attribute ("}", "});")
  const suffix = '/' + repoPath.replace(/^\/+/, '');
  const out: TranscriptWrite[] = [];
  jsonl.split('\n').forEach((raw, index) => {
    if (!raw.includes('tool_use') || !raw.includes(suffix)) return;
    let d: any;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    const blocks = Array.isArray(d?.message?.content) ? d.message.content : [];
    for (const b of blocks) {
      if (b?.type !== 'tool_use' || typeof b.input?.file_path !== 'string' || !b.input.file_path.endsWith(suffix)) continue;
      const i = b.input;
      const written = [i.content, i.new_string, ...(Array.isArray(i.edits) ? i.edits.map((e: any) => e?.new_string) : [])]
        .filter((s): s is string => typeof s === 'string')
        .join('\n');
      if (written.split('\n').some((l) => l.trim() === needle)) out.push({ index, timestamp: d.timestamp ?? '', tool: b.name });
    }
  });
  return out;
}

/** One-line, readable version of a prompt (drops pasted blocks and image markers). */
export function promptHeadline(prompt: string | undefined, max = 90): string | undefined {
  if (!prompt) return undefined;
  const text = prompt
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, ' [pasted text] ')
    .replace(/\[Image: source: [^\]]*\]/g, ' [image] ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ---- Resolution ----

interface CheckpointData extends SessionMeta {
  ref: string;
  prompt?: string;
}

class Repo {
  private checkpointsCache?: CheckpointData[];
  private transcriptCache = new Map<string, string>();
  constructor(
    readonly root: string,
    readonly run: Runner,
  ) {}

  git(args: string[]): RunResult {
    return this.run('git', args, this.root);
  }

  show(rev: string, path: string): string | undefined {
    const r = this.git(['show', `${rev}:${path}`]);
    return r.ok ? r.stdout : undefined;
  }

  checkpoint(id: string): CheckpointData | undefined {
    const ref = checkpointRef(id);
    const meta = parseSessionMetadata(this.show(ref, '0/metadata.json') ?? '');
    if (!meta) return undefined;
    return { ...meta, ref, prompt: this.show(ref, '0/prompt.txt')?.trim() || undefined };
  }

  checkpoints(): CheckpointData[] {
    if (this.checkpointsCache) return this.checkpointsCache;
    const r = this.git(['for-each-ref', '--format=%(refname)', 'refs/entire/checkpoints/']);
    const ids = r.ok ? r.stdout.split('\n').map((l) => l.trim().split('/').pop()!).filter(Boolean) : [];
    this.checkpointsCache = ids.map((id) => this.checkpoint(id)).filter((c): c is CheckpointData => !!c);
    return this.checkpointsCache;
  }

  /** The most complete transcript of a session: the one in its latest checkpoint. */
  transcript(sessionId: string): string {
    if (!this.transcriptCache.has(sessionId)) {
      const latest = this.checkpoints()
        .filter((c) => c.sessionId === sessionId)
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
        .at(-1);
      this.transcriptCache.set(sessionId, latest ? (this.show(latest.ref, '0/full.jsonl') ?? '') : '');
    }
    return this.transcriptCache.get(sessionId)!;
  }
}

const repos = new Map<string, Repo>();

function openRepo(dir: string, run: Runner): Repo | string {
  const r = run('git', ['rev-parse', '--show-toplevel'], dir);
  if (r.missing) return 'git is not installed';
  if (!r.ok) return `not a git repository (${dir})`;
  const root = r.stdout.trim();
  if (run !== defaultRunner) return new Repo(root, run);
  if (!repos.has(root)) repos.set(root, new Repo(root, run));
  return repos.get(root)!;
}

type WhyResult = { line?: WhyLine; note?: string };

function entireWhy(repo: Repo, file: string, line: number, opts: ProvenanceOptions): WhyResult {
  for (const bin of entireCandidates(opts)) {
    const r = repo.run(bin, ['why', `${file}:${line}`, '--json'], repo.root);
    if (r.missing) continue;
    if (!r.ok) return { note: `entire why failed: ${r.stderr.split('\n')[0] || 'unknown error'}` };
    const parsed = parseEntireWhy(r.stdout);
    return parsed ? { line: parsed } : { note: 'entire why returned output Bulwark could not parse' };
  }
  return { note: 'Entire CLI not installed' };
}

/** Step 3: an imported session whose transcript wrote this exact line before the commit. */
function transcriptMatch(repo: Repo, file: string, blame: BlameInfo): Omit<Provenance, 'file' | 'line'> | undefined {
  const cps = repo.checkpoints();
  const commitTime = Date.parse(blame.date);
  if (!cps.length || !Number.isFinite(commitTime)) return undefined;
  // The write must land between the parent commit and this commit.
  const parent = repo.git(['log', '-1', '--format=%aI', `${blame.commit}^`]);
  const after = parent.ok && parent.stdout.trim() ? Date.parse(parent.stdout.trim()) : 0;

  let best: { cp: CheckpointData; write: TranscriptWrite } | undefined;
  for (const sessionId of new Set(cps.map((c) => c.sessionId).filter((s): s is string => !!s))) {
    const writes = findTranscriptWrites(repo.transcript(sessionId), file, blame.content).filter((w) => {
      const t = Date.parse(w.timestamp);
      return Number.isFinite(t) && t <= commitTime && t > after;
    });
    const w = writes.at(-1);
    if (!w) continue;
    // The checkpoint whose transcript scope contains the write: the last one starting at or before it.
    const cp = cps
      .filter((c) => c.sessionId === sessionId && c.transcriptStart !== undefined && c.transcriptStart <= w.index)
      .sort((a, b) => a.transcriptStart! - b.transcriptStart!)
      .at(-1);
    if (cp && (!best || w.timestamp > best.write.timestamp)) best = { cp, write: w };
  }
  if (!best) return undefined;
  return {
    source: 'entire',
    match: 'transcript',
    checkpointId: best.cp.checkpointId,
    sessionId: best.cp.sessionId,
    agent: best.cp.agent,
    model: best.cp.model,
    prompt: best.cp.prompt,
    writtenAt: best.write.timestamp,
    note: `commit ${short(blame.commit)} predates Entire's commit hooks (no Entire-Checkpoint trailer); matched by line text in the session transcript Entire imported (${best.write.tool} at ${best.write.timestamp})`,
  };
}

/** Traces one line back to the commit, and where possible the AI session and prompt, that introduced it. */
export function traceLine(file: string, line: number, opts: ProvenanceOptions = {}): Provenance {
  const run = opts.run ?? defaultRunner;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  const repo = openRepo(dirname(abs), run);
  if (typeof repo === 'string') return { file, line, source: 'unavailable', note: repo };
  const rel = relative(repo.root, abs).split('\\').join('/');
  const base = { file: rel, line };

  const why = entireWhy(repo, rel, line, opts);
  const subjectOf = (sha: string) => {
    const r = repo.git(['log', '-1', '--format=%s', sha]);
    return r.ok ? r.stdout.trim() : undefined;
  };

  // 1. Entire's own attribution, linked to a checkpoint.
  if (why.line?.checkpointId && why.line.commit) {
    const w = why.line;
    return { ...base, source: 'entire', match: 'checkpoint', commit: w.commit, author: w.author, date: w.date, subject: subjectOf(w.commit!), checkpointId: w.checkpointId, sessionId: w.sessionId, agent: w.agent, model: w.model, prompt: w.prompt };
  }

  const b = repo.git(['blame', '--porcelain', '-L', `${line},${line}`, '--', rel]);
  const blame = b.ok ? parseBlamePorcelain(b.stdout) : undefined;
  if (!blame) return { ...base, source: 'unavailable', note: `git blame failed: ${b.stderr.split('\n')[0] || 'no output'}` };
  if (ZERO_SHA.test(blame.commit)) return { ...base, source: 'unavailable', note: 'line is not committed yet' };
  const gitInfo = { ...base, commit: blame.commit, author: blame.author, date: blame.date, subject: blame.subject };

  // 2. The commit's checkpoint trailer, read straight from the checkpoint ref.
  const msg = repo.git(['log', '-1', '--format=%B', blame.commit]);
  const trailer = msg.ok ? parseCheckpointTrailer(msg.stdout) : undefined;
  if (trailer) {
    const cp = repo.checkpoint(trailer);
    if (cp) return { ...gitInfo, source: 'entire', match: 'checkpoint', checkpointId: trailer, sessionId: cp.sessionId, agent: cp.agent, model: cp.model, prompt: cp.prompt };
    return { ...gitInfo, source: 'entire', match: 'checkpoint', checkpointId: trailer, note: `checkpoint ref ${checkpointRef(trailer)} is not in this clone (fetch refs/entire/* to see the session)` };
  }

  // 3. An imported session that wrote this line.
  if (opts.transcripts !== false) {
    const t = transcriptMatch(repo, rel, blame);
    if (t) return { ...gitInfo, ...t };
  }

  // 4. Git only.
  const reason = `commit ${short(blame.commit)} has no Entire-Checkpoint trailer and no Entire session transcript wrote this line`;
  return { ...gitInfo, source: 'git', note: why.note ? `${reason} (${why.note})` : reason };
}

/** Traces many file:line pairs, once each. */
export function traceLines(locs: { file: string; line: number }[], opts: ProvenanceOptions = {}): Map<string, Provenance> {
  const out = new Map<string, Provenance>();
  for (const { file, line } of locs) {
    const key = `${file}:${line}`;
    if (!out.has(key)) out.set(key, traceLine(file, line, opts));
  }
  return out;
}

/** Human-readable one-liner for postmortems: "introduced in `cf0ceac` by …". */
export function describeProvenance(p: Provenance): string {
  if (p.source === 'unavailable') return `provenance unavailable: ${p.note}`;
  const day = p.date ? `, ${p.date.slice(0, 10)}` : '';
  if (p.source === 'git') {
    const subject = p.subject ? ` "${p.subject.length > 60 ? `${p.subject.slice(0, 59)}…` : p.subject}"` : '';
    return `introduced in \`${short(p.commit)}\`${subject} by ${p.author}${day}; no Entire session linked: ${p.note}`;
  }
  const who = p.agent ?? 'an AI agent';
  const session = p.sessionId ? ` session \`${p.sessionId.slice(0, 8)}\`` : '';
  const prompt = promptHeadline(p.prompt, 70) ? `, prompt "${promptHeadline(p.prompt, 70)}"` : '';
  const via =
    p.match === 'transcript'
      ? `Entire checkpoint \`${p.checkpointId}\`, matched in the imported transcript; the commit predates Entire trailers`
      : `Entire checkpoint \`${p.checkpointId}\``;
  const extra = p.note && p.match !== 'transcript' ? `; ${p.note}` : '';
  return `introduced in \`${short(p.commit)}\`${day} by ${who}${session}${prompt} (${via})${extra}`;
}

/** Groups provenance by origin for a short summary: one line per commit/session. */
export function summarizeProvenance(list: Provenance[]): string[] {
  const groups = new Map<string, Provenance[]>();
  for (const p of list) {
    const key = [p.source, p.commit, p.checkpointId, p.source === 'entire' ? '' : p.note].join('|');
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()].map((g) => `${g.map((p) => `\`${p.file}:${p.line}\``).join(', ')}: ${describeProvenance(g[0])}`);
}

/**
 * Traces every finding's line (files relative to `targetDir`) and attaches the
 * result as `finding.provenance`. Returns the distinct provenance records.
 * Never throws: provenance is evidence, not a reason to fail a run.
 * Set BULWARK_PROVENANCE=0 to skip.
 */
export function attachProvenance<F extends { file: string; line: number; provenance?: Provenance }>(
  findings: F[],
  targetDir: string,
  opts: ProvenanceOptions = {},
): Provenance[] {
  if (process.env.BULWARK_PROVENANCE === '0') return [];
  try {
    const traced = traceLines(findings.map((f) => ({ file: join(targetDir, f.file), line: f.line })), opts);
    for (const f of findings) f.provenance = traced.get(`${join(targetDir, f.file)}:${f.line}`);
    return [...traced.values()];
  } catch (e) {
    const note = `provenance failed: ${e instanceof Error ? e.message : String(e)}`;
    for (const f of findings) f.provenance = { file: join(targetDir, f.file), line: f.line, source: 'unavailable', note };
    return [];
  }
}
