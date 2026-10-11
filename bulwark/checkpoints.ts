// Checkpoints: the exact state of the target's source before each fix attempt,
// plus why it was taken. A rejected fix is undone by restoring the last
// checkpoint, never by trying to "un-edit" a bad patch.
//
// Stored locally under .bulwark/runs/<id>/checkpoints/. Entire checkpoints are
// layered on top once the Entire CLI is installed (see PROJECT_SPEC.md §8).

import { createHash } from 'node:crypto';
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

export interface Restored {
  files: Files;
  /** Set when the checkpoint file was missing or corrupt and the in-memory copy was used instead. */
  issue?: string;
}

const digest = (files: Files) => createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

export class CheckpointStore {
  private count = 0;
  /** What each checkpoint held, kept in memory too, so a damaged file never loses the state. */
  private copies = new Map<string, { files: Files; sha256: string }>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  pathOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  save(label: string, files: Files, meta: Record<string, unknown> = {}): Checkpoint {
    const id = `ckpt-${String(++this.count).padStart(3, '0')}`;
    const cp: Checkpoint = { id, label, createdAt: new Date().toISOString(), meta };
    const sha256 = digest(files);
    this.copies.set(id, { files: { ...files }, sha256 });
    writeFileSync(this.pathOf(id), JSON.stringify({ ...cp, sha256, files }, null, 2));
    log('checkpoint saved: {id} ({label})', { id, label });
    return cp;
  }

  /**
   * Restores a checkpoint, verifying the file (parses, has files, matches its checksum). A missing
   * or corrupt file falls back to the in-memory copy and says so; only if neither exists does it throw.
   */
  restoreVerified(id: string): Restored {
    let issue: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(this.pathOf(id), 'utf8')) as { files?: Files; label?: string; sha256?: string };
      if (!raw || typeof raw.files !== 'object' || raw.files === null) throw new Error('no files in checkpoint');
      if (raw.sha256 && digest(raw.files) !== raw.sha256) throw new Error('checksum mismatch');
      log('checkpoint restored: {id} ({label})', { id, label: raw.label, level: 'warn' });
      return { files: raw.files };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      issue = code === 'ENOENT' ? 'checkpoint file missing' : `checkpoint file corrupt (${err instanceof Error ? err.message.split('\n')[0].slice(0, 120) : err})`;
    }
    const copy = this.copies.get(id);
    if (!copy || digest(copy.files) !== copy.sha256) throw new Error(`cannot restore ${id}: ${issue}, and no intact in-memory copy`);
    log('checkpoint {id}: {issue}; restored the in-memory copy', { id, issue, level: 'warn' });
    return { files: { ...copy.files }, issue };
  }

  restore(id: string): Files {
    return this.restoreVerified(id).files;
  }
}
