// Runs the chaos regression tests Bulwark ships with each verified fix
// (targets/<agent>/chaos-tests/*.json). On a branch with Bulwark's fixes these
// must all pass; on unfixed code they fail, which is what proves they guard the fix.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getFault } from '../bulwark/chaos/faults';
import type { ChaosSpec } from '../bulwark/guard';
import { runExperiment } from '../bulwark/scorecard';
import { loadTarget } from '../bulwark/target';

const TARGET_DIR = 'targets/refundbot';
const SPEC_DIR = join(TARGET_DIR, 'chaos-tests');
const specs = existsSync(SPEC_DIR) ? readdirSync(SPEC_DIR).filter((f) => f.endsWith('.json')) : [];

if (specs.length === 0) test('no chaos regression tests yet (run `npm run fix -- --apply`)', () => {});

for (const file of specs) {
  test(`chaos regression: ${file}`, async () => {
    const spec = JSON.parse(readFileSync(join(SPEC_DIR, file), 'utf8')) as ChaosSpec;
    const target = await loadTarget(TARGET_DIR);
    const r = await runExperiment(target, getFault(spec.fault), { trials: spec.trials, seed: spec.seed, brain: 'simulated', deadlineMs: 5000, maxSteps: 50 });
    assert.equal(r.passed, r.trials, JSON.stringify(r.violations));
  });
}
