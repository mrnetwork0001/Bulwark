// Checkpoints: the exact state of the target's source before each fix attempt,
// plus why it was taken. A rejected fix is undone by restoring the last
// checkpoint, never by trying to "un-edit" a bad patch.
//
// Stored locally under .bulwark/runs/<id>/checkpoints/. Entire checkpoints are
// layered on top once the Entire CLI is installed (see PROJECT_SPEC.md §8).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from 'neatlogs';
import type { Files } from './workspace';

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  meta: Record<string, unknown>;
}

export class CheckpointStore {
  private count = 0;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(label: string, files: Files, meta: Record<string, unknown> = {}): Checkpoint {
    const id = `ckpt-${String(++this.count).padStart(3, '0')}`;
    const cp: Checkpoint = { id, label, createdAt: new Date().toISOString(), meta };
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify({ ...cp, files }, null, 2));
    log('checkpoint saved: {id} ({label})', { id, label });
    return cp;
  }

  restore(id: string): Files {
    const { files, label } = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8'));
    log('checkpoint restored: {id} ({label})', { id, label, level: 'warn' });
    return files as Files;
  }
}
