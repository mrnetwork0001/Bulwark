// Wilson score interval for a binomial proportion. Unlike the naive k/n ± error,
// it stays inside [0, 1] and behaves at 0/n and n/n, which is exactly where
// "it never fails now" claims live.
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Small seeded PRNG so every trial replays exactly from its seed.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const logFactCache: number[] = [0];
function logFact(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) logFactCache[i] = logFactCache[i - 1] + Math.log(i);
  return logFactCache[n];
}
const logChoose = (n: number, k: number) => logFact(n) - logFact(k) - logFact(n - k);

// One-sided Fisher exact test: the probability of group A doing at least this
// well relative to group B if both had the same underlying pass rate. Small
// values mean A is genuinely better, not just lucky.
export function fisherGreater(aPass: number, aN: number, bPass: number, bN: number): number {
  const n = aN + bN;
  const k = aPass + bPass;
  let p = 0;
  for (let x = aPass; x <= Math.min(k, aN); x++) {
    p += Math.exp(logChoose(k, x) + logChoose(n - k, aN - x) - logChoose(n, aN));
  }
  return Math.min(1, p);
}

// ---------------------------------------------------------------------------
// SLO math: how many trials does it take to *demonstrate* a reliability target?
//
// Method: exact one-sided Clopper-Pearson. With k passes in n trials, the
// lower confidence bound on the true pass rate p is the p at which seeing k or
// more passes would happen only α of the time. At k = n (zero failures) that has
// a closed form: P(n/n | p) = p^n, so the bound is α^(1/n). The SLO "p ≥ target"
// is demonstrated by n clean trials when α^(1/n) ≥ target, i.e.
//     n ≥ ln(α) / ln(target)
// This is the "rule of three" family (at 95%, n ≈ 3 / (1 - target)): 0.95 needs
// 59 trials, 0.99 needs 299, 0.999 needs 2,995. Wilson is not used here because
// at n/n it is not exact and would claim a target with fewer trials than the
// binomial supports.
// ---------------------------------------------------------------------------

/** Smallest n such that n passes out of n trials demonstrate `target` at `confidence` (one-sided). */
export function zeroFailureTrials(target: number, confidence = 0.95): number {
  if (!(target > 0 && target < 1)) throw new Error(`SLO target must be between 0 and 1 (exclusive), got ${target}`);
  if (!(confidence > 0 && confidence < 1)) throw new Error(`confidence must be between 0 and 1 (exclusive), got ${confidence}`);
  const exact = Math.log(1 - confidence) / Math.log(target);
  // Guard against float noise (e.g. 58.99999999 or 59.00000001 for an exact integer).
  let n = Math.max(1, Math.ceil(exact - 1e-9));
  while (Math.pow(1 - confidence, 1 / n) < target) n++;
  while (n > 1 && Math.pow(1 - confidence, 1 / (n - 1)) >= target) n--;
  return n;
}

function binomTailAtLeast(k: number, n: number, p: number): number {
  // P(X ≥ k) for X ~ Binomial(n, p)
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let s = 0;
  for (let x = k; x <= n; x++) s += Math.exp(logChoose(n, x) + x * Math.log(p) + (n - x) * Math.log(1 - p));
  return Math.min(1, s);
}

/** Exact one-sided Clopper-Pearson lower bound on the pass rate after k passes in n trials. */
export function clopperPearsonLower(k: number, n: number, confidence = 0.95): number {
  if (n <= 0 || k <= 0) return 0;
  const alpha = 1 - confidence;
  if (k >= n) return Math.pow(alpha, 1 / n);
  // P(X ≥ k | p) increases with p; find the p where it equals α.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomTailAtLeast(k, n, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return lo;
}

export const SLO_METHOD = 'exact one-sided Clopper-Pearson (zero failures: n ≥ ln(1−confidence)/ln(target))';
