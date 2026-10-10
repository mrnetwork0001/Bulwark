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
