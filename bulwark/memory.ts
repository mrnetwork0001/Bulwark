// Strategy memory: which fixes worked for which kind of fault, across runs.
// The next run tries the best-known strategy first.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Tally = Record<string, Record<string, { wins: number; losses: number }>>;

export class StrategyMemory {
  private tally: Tally;

  constructor(private path: string) {
    this.tally = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  }

  record(faultKind: string, strategy: string, won: boolean) {
    const t = ((this.tally[faultKind] ??= {})[strategy] ??= { wins: 0, losses: 0 });
    if (won) t.wins++;
    else t.losses++;
  }

  /** Strategies with any history, best first: most wins, then fewest losses. */
  ranked(faultKind: string): string[] {
    return Object.entries(this.tally[faultKind] ?? {})
      .sort(([, a], [, b]) => b.wins - a.wins || a.losses - b.losses)
      .filter(([, t]) => t.wins > 0)
      .map(([id]) => id);
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.tally, null, 2));
  }
}
