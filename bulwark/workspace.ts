// Sandboxed copies of the target's source. Every fix attempt is materialized in
// its own directory, so a bad patch can never touch the original code, and a
// rejected attempt is thrown away by simply not using its directory again.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** File contents keyed by path relative to the target directory. */
export type Files = Record<string, string>;

export function readFiles(dir: string, paths: string[]): Files {
  const files: Files = {};
  for (const p of paths) if (existsSync(join(dir, p))) files[p] = readFileSync(join(dir, p), 'utf8');
  return files;
}

export class Workspace {
  constructor(
    /** Where attempt directories live, e.g. .bulwark/runs/<id>/ws */
    public root: string,
    /** The pristine target directory every attempt starts from. */
    public sourceDir: string,
  ) {
    mkdirSync(root, { recursive: true });
  }

  /** Copies the pristine target, then overlays `files`. Returns the new directory. */
  materialize(label: string, files: Files): string {
    const dir = join(this.root, label);
    rmSync(dir, { recursive: true, force: true });
    cpSync(this.sourceDir, dir, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  }
}

/** Unified diff between two file sets, with paths shown relative to the target. */
export function diffFiles(before: Files, after: Files, prefix = ''): string {
  const tmp = mkdtempSync(join(tmpdir(), 'bulwark-diff-'));
  try {
    const out: string[] = [];
    for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (before[path] === after[path]) continue;
      const a = join(tmp, 'a');
      const b = join(tmp, 'b');
      writeFileSync(a, before[path] ?? '');
      writeFileSync(b, after[path] ?? '');
      const res = spawnSync('git', ['diff', '--no-index', '--no-color', '-U3', a, b], { encoding: 'utf8' });
      const name = prefix + path;
      out.push(
        res.stdout
          .replace(/^diff --git .*$/m, `diff --git a/${name} b/${name}`)
          .replace(/^--- .*$/m, path in before ? `--- a/${name}` : '--- /dev/null')
          .replace(/^\+\+\+ .*$/m, path in after ? `+++ b/${name}` : '+++ /dev/null')
          .replace(/^(new|deleted) file mode .*\n/m, ''),
      );
    }
    return out.join('');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}
