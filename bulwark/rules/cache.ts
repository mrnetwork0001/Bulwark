// The on-disk cache of LLM-compiled rules, keyed by target and exact rule text.
// Two places are read: the local cache (.bulwark/compiled-rules.json, written on
// every compile) and the target's committed lockfile (targets/<name>/compiled-rules.json),
// so a fresh checkout runs the same checks without an LLM key, and reruns cost nothing.
// Kept free of heavy imports: the scorecard reads it on every experiment.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pred } from './dsl';

export const DSL_VERSION = 1;
export const CACHE_PATH = join('.bulwark', 'compiled-rules.json');
/** The committed lockfile next to a target's rules, so a fresh checkout needs no LLM key. */
export const lockfilePath = (target: string) => join('targets', target, 'compiled-rules.json');

export interface SelfTest {
  samples: number;
  baselineSamples: number;
  baselinePassed: number;
  faultedSamples: number;
  /** Faulted trials this check flags (real failures it catches in the sample). */
  faultedFlagged: number;
  counterexampleRejected: boolean;
  counterexampleDetail?: string;
}

export interface LlmCompiledRule {
  target: string;
  rule: string;
  dslVersion: number;
  check: Pred;
  /** Explained back from the DSL, not from Claude's own words. */
  how: string;
  /** Claude's one-line reading of the rule. */
  intent: string;
  counterexample: unknown;
  selfTest: SelfTest;
  model: string;
  compiledAt: string;
}

interface CacheFile {
  version: number;
  rules: Record<string, LlmCompiledRule>;
}

export const cacheKey = (target: string, rule: string) => `${target}::${createHash('sha256').update(rule.trim()).digest('hex').slice(0, 16)}`;

const memo = new Map<string, { mtimeMs: number; file: CacheFile }>();

function readCache(path: string): CacheFile {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const hit = memo.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.file;
    const file = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
    if (!file || typeof file !== 'object' || typeof file.rules !== 'object') throw new Error('bad cache');
    memo.set(path, { mtimeMs, file });
    return file;
  } catch {
    return { version: DSL_VERSION, rules: {} };
  }
}

/** Every target lockfile on the allowlist directory (targets/<name>/compiled-rules.json). */
function allLockfiles(): string[] {
  try {
    return readdirSync('targets')
      .map((d) => lockfilePath(d))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

/**
 * A cached LLM-compiled rule for this exact rule text: the local cache first, then the target's
 * lockfile. Callers that don't name the target (older code paths) match on rule text across all
 * lockfiles; rule texts are a target's own sentences, so a hit there is the same rule.
 */
export function lookupCompiled(target: string | undefined, rule: string, paths?: string[]): LlmCompiledRule | undefined {
  const files = paths ?? [CACHE_PATH, ...(target ? [lockfilePath(target)] : allLockfiles())];
  for (const p of files) {
    if (!existsSync(p)) continue;
    const rules = readCache(p).rules;
    const hit = target ? rules[cacheKey(target, rule)] : Object.values(rules).find((r) => r?.rule === rule);
    if (hit && hit.rule === rule && hit.dslVersion === DSL_VERSION) return hit;
  }
  return undefined;
}

export function saveCompiled(entries: LlmCompiledRule[], path = CACHE_PATH): void {
  const file = existsSync(path) ? readCache(path) : { version: DSL_VERSION, rules: {} };
  const next: CacheFile = { version: DSL_VERSION, rules: { ...file.rules } };
  for (const e of entries) next.rules[cacheKey(e.target, e.rule)] = e;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  memo.delete(path);
}

