// Red agent, step 1: read the target's source and find the weak links, i.e. tool
// calls that can't survive the faults in the catalog. Each finding names the
// file, line and the fault that should trigger it, so every attack starts from
// a hypothesis grounded in the code rather than a random guess.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAULTS, type FaultKind } from '../chaos/faults';
import type { Provenance } from '../provenance/entire';
import type { BulwarkTarget } from '../target';

export interface Finding {
  kind: FaultKind;
  severity: 'high' | 'medium';
  file: string;
  line: number;
  tool?: string;
  why: string;
  faults: string[];
  /** Who introduced this line: commit, and the Entire session/prompt when known (bulwark/provenance). */
  provenance?: Provenance;
}

const WRITE_ENDPOINT = /\.(create|send)$/;

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function faultsFor(kind: FaultKind, endpoint?: string): string[] {
  return FAULTS.filter((f) => f.kind === kind && (!endpoint || f.endpoint === endpoint)).map((f) => f.id);
}

export function analyzeTarget(dir: string, target: BulwarkTarget): Finding[] {
  const findings: Finding[] = [];

  for (const file of target.editableFiles) {
    const src = readFileSync(join(dir, file), 'utf8');

    // Tool definitions: span({ kind: 'TOOL', name: '<tool>' ... }) up to the next tool.
    const toolStarts = [...src.matchAll(/span\(\{ kind: 'TOOL', name: '(\w+)'/g)];
    toolStarts.forEach((m, i) => {
      const start = m.index!;
      const body = src.slice(start, toolStarts[i + 1]?.index ?? src.length);
      const tool = m[1];
      const calls = [...body.matchAll(/transport\('([\w.]+)'/g)];
      if (calls.length === 0) return;
      // The tool's primary call is the one that writes, if any; otherwise its first call.
      const primary = calls.find((c) => WRITE_ENDPOINT.test(c[1])) ?? calls[0];
      const endpoint = primary[1];
      const line = lineOf(src, start + primary.index!);
      const writes = WRITE_ENDPOINT.test(endpoint);
      const add = (kind: FaultKind, severity: Finding['severity'], why: string) => {
        const faults = faultsFor(kind, endpoint);
        if (faults.length) findings.push({ kind, severity, file, line, tool, why, faults });
      };

      if (!/withTimeout\(/.test(body)) add('latency', 'medium', `${tool} calls ${endpoint} with no timeout`);
      if (!/withRetry\(/.test(body)) add('rate-limit', 'medium', `${tool} never retries ${endpoint} on transient errors`);
      if (/JSON\.parse\(/.test(body) && !/validate|parse[A-Z]\w*\(/.test(body)) {
        add('malformed', 'medium', `${tool} trusts the JSON from ${endpoint} without validating it`);
      }
      if (writes && /withRetry\(/.test(body) && !/idempotencyKey/.test(body)) {
        add('commit-timeout', 'high', `${tool} retries a money-moving call (${endpoint}) without an idempotency key`);
      }
      if (/\)\.text\)?;/.test(body) && !/sanitize/i.test(body)) {
        add('injection', 'high', `${tool} passes raw text from ${endpoint} to the model, so injected instructions reach it`);
      }
      if (writes && /amount/.test(body) && !/order\.total/.test(body)) {
        for (const f of faultsFor('injection')) {
          findings.push({
            kind: 'injection',
            severity: 'high',
            file,
            line,
            tool,
            why: `${tool} moves money without checking the amount against the order total`,
            faults: [f],
          });
        }
      }
      // Social engineering arrives in the ticket, so the fault isn't tied to this endpoint.
      if (writes && /amount/.test(body) && !/customerEmail/.test(body)) {
        const faults = faultsFor('social');
        if (faults.length) {
          findings.push({
            kind: 'social',
            severity: 'high',
            file,
            line,
            tool,
            why: `${tool} moves money without checking that the order belongs to the ticket's customer, so a persuasive customer can redirect it`,
            faults,
          });
        }
      }
    });

    const loop = src.match(/while \(true\)/);
    if (loop && !/MAX_STEPS/.test(src)) {
      findings.push({
        kind: 'loop',
        severity: 'medium',
        file,
        line: lineOf(src, loop.index!),
        why: 'the agent loop has no step budget, so a stuck tool means unbounded steps and cost',
        faults: faultsFor('loop'),
      });
    }
  }

  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}
