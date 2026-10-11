// Entire Graph: a local, no-egress code graph (the `entire graph` plugin for the
// Entire CLI). Red uses it to measure each weak link's blast radius (who calls
// it, what co-changes with it), and Blue uses it to locate fix sites from the
// fault's hypothesis. Every call is best-effort: without the plugin, Bulwark
// falls back to its own static analysis.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENTIRE = process.env.ENTIRE_BIN || 'entire';
const PATH_WITH_LOCAL_BIN = `${join(homedir(), '.local', 'bin')}:${process.env.PATH ?? ''}`;

export interface GraphSymbol {
  name: string;
  kind: string;
  file: string;
  line?: number;
}

export interface BlastRadius {
  focus: GraphSymbol;
  /** Code that calls the weak link (doc and evidence mentions excluded). */
  callers: GraphSymbol[];
  callees: GraphSymbol[];
}

export type Runner = (args: string[], cwd: string) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: Runner = (args, cwd) => {
  const res = spawnSync(ENTIRE, ['graph', ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: PATH_WITH_LOCAL_BIN } });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? (res.error ? String(res.error) : '') };
};

const CODE_KINDS = new Set(['function', 'method', 'class', 'interface', 'type', 'variable', 'constant', 'property']);

function toSymbol(e: { name?: string; kind?: string; file_path?: string; start_line?: number }, line?: number): GraphSymbol {
  return { name: e.name ?? '?', kind: e.kind ?? '?', file: e.file_path ?? '?', line: line ?? e.start_line };
}

export class EntireGraph {
  constructor(
    private repo: string,
    private run: Runner = defaultRunner,
  ) {}

  available(): boolean {
    return this.run(['version'], this.repo).status === 0;
  }

  /** Blast radius of the symbol enclosing `file:line`, or null if the graph can't answer. */
  impact(file: string, line: number): BlastRadius | null {
    const res = this.run(['impact', '--symbol', `${file}:${line}`, '--repo', '.', '--format', 'json', '--exclude-tests', '--depth', '2'], this.repo);
    if (res.status !== 0) return null;
    try {
      const j = JSON.parse(res.stdout);
      if (!j.focus) return null;
      const pick = (section: { entries?: { endpoint: Record<string, unknown>; call_site?: { file_path?: string; line?: number } }[] } | undefined) =>
        (section?.entries ?? [])
          .filter((e) => CODE_KINDS.has(String(e.endpoint.kind)))
          .map((e) => toSymbol(e.endpoint as never, e.call_site?.line));
      return { focus: toSymbol(j.focus), callers: pick(j.callers), callees: pick(j.callees) };
    } catch {
      return null;
    }
  }

  /**
   * Ranked fix-site candidates for a plain-language description. `under` keeps only hits inside
   * that directory (the graph indexes the whole repo, Bulwark included, and Blue may only edit the
   * target). Returns a compact list of `file:start-end symbol` headers, each with the hit's source.
   */
  search(query: string, topK = 3, under?: string): string | null {
    // Ask for extra hits so filtering to the target still leaves topK.
    const res = this.run(['search', '--query', query, '--repo', '.', '--top-k', String(under ? topK * 4 : topK), '--format', 'json', '--profile', 'full'], this.repo);
    if (res.status !== 0) return null;
    try {
      const prefix = under ? `${under.replace(/\/$/, '')}/` : '';
      const hits = ((JSON.parse(res.stdout).results ?? []) as SearchHit[]).filter((h) => !prefix || h.file_path?.startsWith(prefix)).slice(0, topK);
      if (!hits.length) return null;
      return hits
        .map((h, i) => {
          // Blue has the full files; the snippet only has to show where. Long hits are clipped.
          const lines = (h.snippet ?? '').trimEnd().split('\n');
          const body = lines.length > 20 ? [...lines.slice(0, 20), `  … (${lines.length - 20} more lines)`].join('\n') : lines.join('\n');
          return `${i + 1}. ${h.file_path}:${h.start_line}-${h.end_line}${h.symbol_name ? ` ${h.symbol_name}` : ''} (score ${Number(h.score ?? 0).toFixed(1)})\n${body}`;
        })
        .join('\n\n');
    } catch {
      return null;
    }
  }
}

interface SearchHit {
  file_path?: string;
  start_line?: number;
  end_line?: number;
  symbol_name?: string;
  score?: number;
  snippet?: string;
}

/** The graph Bulwark uses, or undefined when switched off (BULWARK_ENTIRE_GRAPH=0) or the plugin isn't installed. */
export function graphFor(repo: string, run?: Runner): EntireGraph | undefined {
  if (process.env.BULWARK_ENTIRE_GRAPH === '0') return undefined;
  const g = new EntireGraph(repo, run);
  return g.available() ? g : undefined;
}

/**
 * Attaches each finding's blast radius (Finding.blast). `targetRel` is the target's path from the
 * graph's repo root, since findings name files relative to the target. One query per distinct line.
 */
export function attachBlast(findings: { file: string; line: number; blast?: Pick<BlastRadius, 'focus' | 'callers'> }[], graph: EntireGraph | undefined, targetRel: string): number {
  if (!graph) return 0;
  const cache = new Map<string, BlastRadius | null>();
  let n = 0;
  for (const f of findings) {
    const at = `${targetRel ? `${targetRel}/` : ''}${f.file}:${f.line}`;
    if (!cache.has(at)) cache.set(at, graph.impact(at.slice(0, at.lastIndexOf(':')), f.line));
    const b = cache.get(at);
    if (b) {
      f.blast = { focus: b.focus, callers: b.callers };
      n++;
    }
  }
  return n;
}

/** One line for reports, e.g. "createTools (function, tools.ts:76) ← 1 caller: runRefundBot (agent.ts:54)". */
export function describeBlast(b: Pick<BlastRadius, 'focus' | 'callers'>, max = 4): string {
  const at = (s: GraphSymbol) => `${s.file}${s.line ? `:${s.line}` : ''}`;
  const callers = b.callers.slice(0, max).map((c) => `${c.name} (${at(c)})`);
  const more = b.callers.length > max ? `, +${b.callers.length - max} more` : '';
  return `${b.focus.name} (${b.focus.kind}, ${at(b.focus)}) ← ${b.callers.length} caller${b.callers.length === 1 ? '' : 's'}${callers.length ? `: ${callers.join(', ')}${more}` : ''}`;
}
