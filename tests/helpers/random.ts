import type { RebalanceRequest } from '../../src/rebalancer';

/** Small seeded PRNG so every randomized failure is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n non-negative integers (basis points) that add up to exactly 10,000 = 100%. */
function splitBasisPoints(rand: () => number, n: number): number[] {
  const cuts = Array.from({ length: n - 1 }, () => Math.floor(rand() * 10001)).sort((a, b) => a - b);
  const parts: number[] = [];
  let prev = 0;
  for (const c of cuts) {
    parts.push(c - prev);
    prev = c;
  }
  parts.push(10000 - prev);
  return parts;
}

/** Random valid account: 2–8 securities, $1K–$10M, prices $1–$1,000, 2-decimal percentages. */
export function randomPortfolio(seed: number): RebalanceRequest {
  const rand = mulberry32(seed);
  const n = 2 + Math.floor(rand() * 7);
  const target = splitBasisPoints(rand, n);
  const current = splitBasisPoints(rand, n);
  return {
    accountId: `RND-${seed}`,
    totalAssets: Math.round((1_000 + rand() * 9_999_000) * 100) / 100,
    positions: target.map((bp, i) => ({
      symbol: `SEC${i + 1}`,
      targetPct: bp / 100,
      currentPct: current[i] / 100,
      price: Math.round((1 + rand() * 999) * 100) / 100,
    })),
  };
}
