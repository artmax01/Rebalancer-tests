import base from '../../test-data/account-abc.json';
import type { PositionInput, RebalanceRequest, RebalanceResult, TradeLine } from '../../src/rebalancer';

/** Fresh deep copy of the assessment account (ABC, $100K, 5 securities). */
export function accountABC(overrides: Partial<RebalanceRequest> = {}): RebalanceRequest {
  return { ...(structuredClone(base) as RebalanceRequest), ...overrides };
}

/** Account ABC with some positions changed, e.g. withPositions({ IBM: { price: 0 } }). */
export function withPositions(
  changes: Record<string, Partial<PositionInput>>,
  overrides: Partial<RebalanceRequest> = {},
): RebalanceRequest {
  const acct = accountABC(overrides);
  acct.positions = acct.positions.map((p) => ({ ...p, ...(changes[p.symbol] ?? {}) }));
  return acct;
}

export function tradeFor(result: RebalanceResult, symbol: string): TradeLine {
  const t = result.trades.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`No trade line for ${symbol}`);
  return t;
}

/**
 * Hand-calculated oracle for the assessment (whole shares, rounded down).
 * Kept as literal numbers on purpose — the tests must not re-use the app's formula.
 *
 *   IBM : (20−10)% × 100,000 = +$10,000 → 10,000 / 150 = 66.67 → BUY 66  ($9,900)
 *   ORCL: (20−30)% × 100,000 = −$10,000 → 10,000 / 220 = 45.45 → SELL 45 ($9,900)
 *   MSFT, AAPL, HD: 0 variance → HOLD
 */
export const EXPECTED_ABC_WHOLE = [
  { symbol: 'IBM', variancePct: -10, action: 'BUY', quantity: 66, tradeValue: 9900, projectedPct: 19.9 },
  { symbol: 'MSFT', variancePct: 0, action: 'HOLD', quantity: 0, tradeValue: 0, projectedPct: 20 },
  { symbol: 'ORCL', variancePct: 10, action: 'SELL', quantity: 45, tradeValue: 9900, projectedPct: 20.1 },
  { symbol: 'AAPL', variancePct: 0, action: 'HOLD', quantity: 0, tradeValue: 0, projectedPct: 20 },
  { symbol: 'HD', variancePct: 0, action: 'HOLD', quantity: 0, tradeValue: 0, projectedPct: 20 },
] as const;
