// Runs the chaos regression tests Bulwark ships with each verified fix
// (targets/<agent>/chaos-tests/*.json) for every target on the allowlist. On a
// branch with Bulwark's fixes these must all pass; on unfixed code they fail,
// which is what proves they guard the fix. CI (.github/workflows/bulwark.yml)
// runs this on every PR that touches targets/.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getFault } from '../bulwark/chaos/faults';
import type { ChaosSpec } from '../bulwark/guard';
import { runExperiment } from '../bulwark/scorecard';
import { listTargets, loadTarget } from '../bulwark/target';

const targets = listTargets();

test('chaos specs: every target directory on the allowlist is covered', () => {
  assert.ok(targets.includes('refundbot') && targets.includes('researchbot'), `targets found: ${targets.join(', ')}`);
});

for (const name of targets) {
  const dir = join('targets', name);
  const specDir = join(dir, 'chaos-tests');
  const specs = existsSync(specDir) ? readdirSync(specDir).filter((f) => f.endsWith('.json')).sort() : [];
  if (specs.length === 0) test(`${name}: no chaos regression tests yet (run \`npm run fix -- --target ${dir} --apply\`)`, () => {});

  for (const file of specs) {
    test(`chaos regression: ${name}/${file}`, async () => {
      const spec = JSON.parse(readFileSync(join(specDir, file), 'utf8')) as ChaosSpec;
      const target = await loadTarget(dir);
      const r = await runExperiment(target, getFault(spec.fault, target), { trials: spec.seeds?.length ?? spec.trials, seed: spec.seed, seeds: spec.seeds, brain: 'simulated', deadlineMs: 5000, maxSteps: 50 });
      assert.equal(r.passed, r.trials, JSON.stringify(r.violations));
    });
  }
}
