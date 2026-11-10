/**
 * Property-based checks: instead of hard-coding answers, assert rules that must hold
 * for ANY valid portfolio. 500 seeded random accounts per run; a failure message
 * includes the seed, so it can be replayed with randomPortfolio(seed).
 */
import { test, expect } from '@playwright/test';
import { rebalance } from '../../src/rebalancer';
import { randomPortfolio } from '../helpers/random';

const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);
const CENT = 0.01;

test.describe('Invariants on 500 random portfolios', () => {
  test('whole-share mode: right direction, never overshoots, within one share of target, never oversells', () => {
    for (const seed of SEEDS) {
      const req = randomPortfolio(seed);
      const result = rebalance(req);
      const investable = req.totalAssets;

      result.trades.forEach((t, i) => {
        const p = req.positions[i];
        const ctx = `seed=${seed} ${p.symbol}`;
        const gap = ((p.targetPct - p.currentPct) / 100) * investable; // test-side oracle: + buy / − sell
        const held = ((p.currentPct / 100) * investable) / p.price;

        // 1. Direction follows the sign of the variance
        if (t.action === 'BUY') expect(gap, ctx).toBeGreaterThan(0);
        if (t.action === 'SELL') expect(gap, ctx).toBeLessThan(0);

        // 2. Whole, non-negative quantity; value = quantity × price
        expect(Number.isInteger(t.quantity), ctx).toBe(true);
        expect(t.quantity, ctx).toBeGreaterThanOrEqual(0);
        expect(t.tradeValue, ctx).toBeCloseTo(t.quantity * p.price, 2);

        // 3. Never trades past the target (round-down policy)
        expect(t.tradeValue, ctx).toBeLessThanOrEqual(Math.abs(gap) + CENT);

        // 4. What's left over is less than one share — otherwise we should have traded one more
        expect(Math.abs(gap) - t.tradeValue, ctx).toBeLessThan(p.price + CENT);

        // 5. Never sells more shares than the account holds
        if (t.action === 'SELL') expect(t.quantity, ctx).toBeLessThanOrEqual(held + 1e-6);
      });

      // 6. Totals are consistent with the lines
      const buy = result.trades.filter((t) => t.action === 'BUY').reduce((s, t) => s + t.tradeValue, 0);
      const sell = result.trades.filter((t) => t.action === 'SELL').reduce((s, t) => s + t.tradeValue, 0);
      expect(result.totalBuyValue, `seed=${seed}`).toBeCloseTo(buy, 2);
      expect(result.totalSellValue, `seed=${seed}`).toBeCloseTo(sell, 2);
      expect(result.netCash, `seed=${seed}`).toBeCloseTo(sell - buy, 2);
    }
  });

  test('fractional mode: every position lands on target and the trades are cash-neutral', () => {
    for (const seed of SEEDS) {
      const result = rebalance({ ...randomPortfolio(seed), rounding: 'fractional' });
      for (const t of result.trades) {
        expect(Math.abs(t.projectedPct - t.targetPct), `seed=${seed} ${t.symbol}`).toBeLessThan(0.01);
      }
      expect(Math.abs(result.netCash), `seed=${seed}`).toBeLessThan(0.1);
    }
  });

  test('re-running on the projected result produces no further orders (idempotency)', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const req = { ...randomPortfolio(seed), rounding: 'fractional' as const };
      const first = rebalance(req);
      const second = rebalance({
        ...req,
        positions: req.positions.map((p, i) => ({ ...p, currentPct: first.trades[i].projectedPct })),
      });
      // Projections are rounded to 4 dp, so allow sub-share dust but no real orders
      for (const t of second.trades) {
        expect(t.tradeValue, `seed=${seed} ${t.symbol}`).toBeLessThan(req.totalAssets * 0.0001 + CENT);
      }
    }
  });
});
