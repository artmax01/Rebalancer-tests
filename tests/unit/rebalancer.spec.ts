import { test, expect } from '@playwright/test';
import { rebalance, RebalanceRequest, ValidationError } from '../../src/rebalancer';
import { accountABC, EXPECTED_ABC_WHOLE, tradeFor, withPositions } from '../helpers/data';

/** Runs the rebalancer and returns its validation errors (fails if it doesn't throw one). */
function errorsOf(req: unknown): string[] {
  try {
    rebalance(req as RebalanceRequest);
  } catch (e) {
    if (e instanceof ValidationError) return e.errors;
    throw e;
  }
  throw new Error('Expected a ValidationError but the request was accepted');
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Account ABC – assessment scenario (whole shares, round down)', () => {
  for (const exp of EXPECTED_ABC_WHOLE) {
    test(`${exp.symbol}: variance ${exp.variancePct}% → ${exp.action} ${exp.quantity}`, () => {
      expect(tradeFor(rebalance(accountABC()), exp.symbol)).toMatchObject(exp);
    });
  }

  test('only IBM and ORCL generate orders', () => {
    const orders = rebalance(accountABC()).trades.filter((t) => t.action !== 'HOLD').map((t) => t.symbol);
    expect(orders).toEqual(['IBM', 'ORCL']);
  });

  test('orders are cash-neutral: buy $9,900, sell $9,900, net cash $0', () => {
    expect(rebalance(accountABC())).toMatchObject({ totalBuyValue: 9900, totalSellValue: 9900, netCash: 0 });
  });

  test('residual variance after the trades is less than one share of each security', () => {
    const result = rebalance(accountABC());
    for (const t of result.trades) {
      const oneSharePct = (t.price / result.investableAssets) * 100;
      expect(Math.abs(t.projectedPct - t.targetPct), t.symbol).toBeLessThan(oneSharePct);
    }
  });
});

test.describe('Account ABC – fractional shares', () => {
  test('IBM BUY 66.666667, ORCL SELL 45.454545, every position lands exactly on 20%', () => {
    const result = rebalance(accountABC({ rounding: 'fractional' }));
    expect(tradeFor(result, 'IBM')).toMatchObject({ action: 'BUY', quantity: 66.666667, tradeValue: 10000 });
    expect(tradeFor(result, 'ORCL')).toMatchObject({ action: 'SELL', quantity: 45.454545, tradeValue: 10000 });
    for (const t of result.trades) expect(t.projectedPct, t.symbol).toBe(20);
    expect(result.netCash).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Rebalancing rules', () => {
  test('already balanced portfolio produces no orders', () => {
    const result = rebalance(withPositions({ IBM: { currentPct: 20 }, ORCL: { currentPct: 20 } }));
    expect(result.trades.every((t) => t.action === 'HOLD' && t.quantity === 0)).toBe(true);
    expect(result).toMatchObject({ totalBuyValue: 0, totalSellValue: 0, netCash: 0 });
  });

  test('rebalancing an already rebalanced portfolio is idempotent', () => {
    const first = rebalance(accountABC({ rounding: 'fractional' }));
    const after = accountABC({ rounding: 'fractional' });
    after.positions = after.positions.map((p) => ({ ...p, currentPct: tradeFor(first, p.symbol).projectedPct }));
    expect(rebalance(after).trades.map((t) => t.action)).toEqual(['HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD']);
  });

  test('target 0% liquidates the position without selling more than is held', () => {
    // HD: 20% of $100K = $20,000 held = 285.71 shares @ $70 → SELL 285 ($19,950)
    // IBM: 20% → 40% = +$20,000 @ $150 = 133.33 → BUY 133 ($19,950)
    const result = rebalance(
      withPositions({ IBM: { targetPct: 40, currentPct: 20 }, ORCL: { currentPct: 20 }, HD: { targetPct: 0 } }),
    );
    const hd = tradeFor(result, 'HD');
    expect(hd).toMatchObject({ action: 'SELL', quantity: 285, tradeValue: 19950, projectedPct: 0.05 });
    expect(hd.quantity).toBeLessThanOrEqual(20000 / 70);
    expect(tradeFor(result, 'IBM')).toMatchObject({ action: 'BUY', quantity: 133, tradeValue: 19950 });
  });

  test('a brand-new position (current 0%) is bought', () => {
    // MSFT: 0% → 20% = $20,000 / $90 = 222.22 → BUY 222 ; ORCL: 40% → 20% = $20,000 / $220 = 90.9 → SELL 90
    const result = rebalance(
      withPositions({ IBM: { currentPct: 20 }, MSFT: { currentPct: 0 }, ORCL: { currentPct: 40 } }),
    );
    expect(tradeFor(result, 'MSFT')).toMatchObject({ action: 'BUY', quantity: 222, tradeValue: 19980 });
    expect(tradeFor(result, 'ORCL')).toMatchObject({ action: 'SELL', quantity: 90, tradeValue: 19800 });
  });

  test('a gap smaller than one share price is not traded (HOLD)', () => {
    // $1,000 account: AAPL needs +$100 but costs $450 → HOLD ; HD has −$100 @ $70 → SELL 1
    const result = rebalance(
      withPositions(
        { IBM: { currentPct: 20 }, ORCL: { currentPct: 20 }, AAPL: { currentPct: 10 }, HD: { currentPct: 30 } },
        { totalAssets: 1000 },
      ),
    );
    expect(tradeFor(result, 'AAPL')).toMatchObject({ action: 'HOLD', quantity: 0, variancePct: -10 });
    expect(tradeFor(result, 'HD')).toMatchObject({ action: 'SELL', quantity: 1, tradeValue: 70 });
  });

  test('decimal percentages (33.33 / 33.33 / 33.34) are handled', () => {
    const result = rebalance({
      accountId: 'DEC',
      totalAssets: 100000,
      positions: [
        { symbol: 'AAA', targetPct: 33.33, currentPct: 50, price: 100 }, // −$16,670 → SELL 166
        { symbol: 'BBB', targetPct: 33.33, currentPct: 25, price: 50 }, //  +$8,330 → BUY 166
        { symbol: 'CCC', targetPct: 33.34, currentPct: 25, price: 25 }, //  +$8,340 → BUY 333
      ],
    });
    expect(result.trades.map(({ symbol, action, quantity }) => ({ symbol, action, quantity }))).toEqual([
      { symbol: 'AAA', action: 'SELL', quantity: 166 },
      { symbol: 'BBB', action: 'BUY', quantity: 166 },
      { symbol: 'CCC', action: 'BUY', quantity: 333 },
    ]);
  });

  test('floating-point noise does not lose a whole share (29.9 − 20 = 9.899999999999999 in JS)', () => {
    // Exact math: 9.9% × $100K = $9,900 / $220 = 45.000 shares. Naive JS gives 44.99999999999999 → truncates to 44.
    const result = rebalance(
      withPositions({
        IBM: { targetPct: 10.1, currentPct: 20 },
        ORCL: { targetPct: 29.9, currentPct: 20 },
      }),
    );
    expect(tradeFor(result, 'ORCL')).toMatchObject({ action: 'BUY', quantity: 45, tradeValue: 9900 });
    expect(tradeFor(result, 'IBM')).toMatchObject({ action: 'SELL', quantity: 66, tradeValue: 9900 });
  });

  test('single security at 100% target and 100% current → HOLD (0/100 boundary)', () => {
    const result = rebalance({
      accountId: 'ONE',
      totalAssets: 50000,
      positions: [{ symbol: 'IBM', targetPct: 100, currentPct: 100, price: 150 }],
    });
    expect(result.trades[0]).toMatchObject({ action: 'HOLD', quantity: 0 });
  });

  test('response keeps the input order of securities', () => {
    expect(rebalance(accountABC()).trades.map((t) => t.symbol)).toEqual(['IBM', 'MSFT', 'ORCL', 'AAPL', 'HD']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Scaling, vesting and precision', () => {
  test('$1,000,000 account scales linearly → BUY 666 IBM, SELL 454 ORCL', () => {
    const result = rebalance(accountABC({ totalAssets: 1_000_000 }));
    expect(tradeFor(result, 'IBM')).toMatchObject({ action: 'BUY', quantity: 666 });
    expect(tradeFor(result, 'ORCL')).toMatchObject({ action: 'SELL', quantity: 454 });
  });

  test('$1,000,000,000 account keeps precision → BUY 666,666 IBM, SELL 454,545 ORCL', () => {
    const result = rebalance(accountABC({ totalAssets: 1_000_000_000 }));
    expect(tradeFor(result, 'IBM')).toMatchObject({ quantity: 666666, tradeValue: 99_999_900 });
    expect(tradeFor(result, 'ORCL')).toMatchObject({ quantity: 454545, tradeValue: 99_999_900 });
  });

  test('vestedPct 50 halves the investable base → BUY 33 IBM, SELL 22 ORCL', () => {
    const result = rebalance(accountABC({ vestedPct: 50 }));
    expect(result.investableAssets).toBe(50000);
    expect(tradeFor(result, 'IBM')).toMatchObject({ action: 'BUY', quantity: 33 });
    expect(tradeFor(result, 'ORCL')).toMatchObject({ action: 'SELL', quantity: 22 });
  });

  test('vestedPct and rounding default to 100% and wholeDown when omitted', () => {
    const req = accountABC();
    delete req.vestedPct;
    const result = rebalance(req);
    expect(result).toMatchObject({ investableAssets: 100000, rounding: 'wholeDown' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Input validation', () => {
  const cases: { name: string; req: unknown; error: string }[] = [
    { name: 'targets add up to 105%', req: withPositions({ IBM: { targetPct: 25 } }), error: 'targetPct values must add up to 100 (got 105)' },
    { name: 'current holdings add up to 90%', req: withPositions({ ORCL: { currentPct: 20 } }), error: 'currentPct values must add up to 100 (got 90)' },
    { name: 'targets 99.98% (just outside ±0.01 tolerance)', req: withPositions({ HD: { targetPct: 19.98 } }), error: 'targetPct values must add up to 100 (got 99.98)' },
    { name: 'price is 0 (division by zero)', req: withPositions({ IBM: { price: 0 } }), error: 'IBM: price must be a number greater than 0' },
    { name: 'price is negative', req: withPositions({ IBM: { price: -150 } }), error: 'IBM: price must be a number greater than 0' },
    { name: 'price sent as a string', req: withPositions({ IBM: { price: '150' as unknown as number } }), error: 'IBM: price must be a number greater than 0' },
    { name: 'targetPct is negative', req: withPositions({ IBM: { targetPct: -5 } }), error: 'IBM: targetPct must be a number between 0 and 100' },
    { name: 'targetPct above 100', req: withPositions({ IBM: { targetPct: 120 } }), error: 'IBM: targetPct must be a number between 0 and 100' },
    { name: 'currentPct is NaN', req: withPositions({ MSFT: { currentPct: NaN } }), error: 'MSFT: currentPct must be a number between 0 and 100' },
    { name: 'totalAssets is 0', req: accountABC({ totalAssets: 0 }), error: 'totalAssets must be a number greater than 0' },
    { name: 'totalAssets is negative', req: accountABC({ totalAssets: -100000 }), error: 'totalAssets must be a number greater than 0' },
    { name: 'vestedPct is 0', req: accountABC({ vestedPct: 0 }), error: 'vestedPct must be greater than 0 and at most 100' },
    { name: 'vestedPct above 100', req: accountABC({ vestedPct: 150 }), error: 'vestedPct must be greater than 0 and at most 100' },
    { name: 'unknown rounding mode', req: accountABC({ rounding: 'up' as never }), error: 'rounding must be one of: wholeDown, fractional' },
    { name: 'no positions', req: accountABC({ positions: [] }), error: 'positions must contain at least one security' },
    { name: 'missing symbol', req: withPositions({ IBM: { symbol: '' } }), error: 'positions[0].symbol is required' },
    {
      name: 'duplicate symbol (case-insensitive)',
      req: accountABC({ positions: [...accountABC().positions, { symbol: 'ibm', targetPct: 0, currentPct: 0, price: 150 }] }),
      error: 'duplicate symbol ibm',
    },
    { name: 'body is null', req: null, error: 'request body must be a JSON object' },
  ];

  for (const c of cases) {
    test(`rejects: ${c.name}`, () => {
      expect(errorsOf(c.req)).toContain(c.error);
    });
  }

  test('accepts percentages within the ±0.01 rounding tolerance (targets = 99.99%)', () => {
    expect(() => rebalance(withPositions({ HD: { targetPct: 19.99 } }))).not.toThrow();
  });

  test('reports every problem at once, not just the first', () => {
    const errors = errorsOf(withPositions({ IBM: { price: 0 }, ORCL: { targetPct: -1 } }, { totalAssets: 0 }));
    expect(errors).toEqual(
      expect.arrayContaining([
        'totalAssets must be a number greater than 0',
        'IBM: price must be a number greater than 0',
        'ORCL: targetPct must be a number between 0 and 100',
      ]),
    );
  });
});
