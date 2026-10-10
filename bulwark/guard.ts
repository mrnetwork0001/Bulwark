// Guard: every accepted fix ships with a chaos regression test, and the test is
// itself proven: it must fail on the un-fixed code and pass on the fixed code.
// A test that passes either way protects nothing.

import { getFault } from './chaos/faults';
import { runExperiment, type ExperimentOptions, type ExperimentResult } from './scorecard';
import type { BulwarkTarget } from './target';
import type { Files } from './workspace';

export interface ChaosSpec {
  fault: string;
  trials: number;
  seed: number;
  strategy: string;
  createdBy: 'bulwark';
}

export const specPath = (fault: string) => `chaos-tests/${fault}.json`;

export function withSpec(files: Files, spec: ChaosSpec): Files {
  return { ...files, [specPath(spec.fault)]: JSON.stringify(spec, null, 2) + '\n' };
}

export interface MutationCheck {
  ok: boolean;
  unfixed: ExperimentResult;
  fixed: ExperimentResult;
}

export async function mutationCheck(
  spec: ChaosSpec,
  unfixed: BulwarkTarget,
  fixed: BulwarkTarget,
  base: ExperimentOptions,
): Promise<MutationCheck> {
  const opts = { ...base, trials: spec.trials, seed: spec.seed, onTrial: undefined };
  const fault = getFault(spec.fault);
  const [u, f] = await Promise.all([runExperiment(unfixed, fault, opts), runExperiment(fixed, fault, opts)]);
  return { ok: u.passed < u.trials && f.passed === f.trials, unfixed: u, fixed: f };
}
