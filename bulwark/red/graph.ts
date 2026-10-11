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

type Runner = (args: string[], cwd: string) => { status: number | null; stdout: string; stderr: string };

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

  /** Ranked fix-site candidates for a plain-language description, in Entire's compact agent format. */
  search(query: string, topK = 3): string | null {
    const res = this.run(['search', '--query', query, '--repo', '.', '--top-k', String(topK), '--format', 'agent', '--profile', 'full'], this.repo);
    return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
  }
}
