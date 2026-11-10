import { test, expect } from '@playwright/test';
import { accountABC, EXPECTED_ABC_WHOLE, withPositions } from '../helpers/data';

const ENDPOINT = '/api/rebalance';

test.describe('POST /api/rebalance – happy path', () => {
  test('returns the expected orders for account ABC', async ({ request }) => {
    const res = await request.post(ENDPOINT, { data: accountABC() });

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');

    const body = await res.json();
    expect(body).toMatchObject({ accountId: 'ABC', rounding: 'wholeDown', investableAssets: 100000 });
    for (const exp of EXPECTED_ABC_WHOLE) {
      expect(body.trades.find((t: { symbol: string }) => t.symbol === exp.symbol), exp.symbol).toMatchObject(exp);
    }
    expect(body).toMatchObject({ totalBuyValue: 9900, totalSellValue: 9900, netCash: 0 });
  });

  test('response matches the contract (field names and types)', async ({ request }) => {
    const body = await (await request.post(ENDPOINT, { data: accountABC() })).json();

    expect(body).toEqual({
      accountId: expect.any(String),
      investableAssets: expect.any(Number),
      rounding: expect.stringMatching(/^(wholeDown|fractional)$/),
      trades: expect.any(Array),
      totalBuyValue: expect.any(Number),
      totalSellValue: expect.any(Number),
      netCash: expect.any(Number),
    });
    expect(body.trades).toHaveLength(5);
    for (const t of body.trades) {
      expect(t).toEqual({
        symbol: expect.any(String),
        targetPct: expect.any(Number),
        currentPct: expect.any(Number),
        variancePct: expect.any(Number),
        price: expect.any(Number),
        action: expect.stringMatching(/^(BUY|SELL|HOLD)$/),
        quantity: expect.any(Number),
        tradeValue: expect.any(Number),
        projectedPct: expect.any(Number),
      });
    }
  });

  test('fractional rounding requested by the client is honoured', async ({ request }) => {
    const body = await (await request.post(ENDPOINT, { data: accountABC({ rounding: 'fractional' }) })).json();
    const bySymbol = Object.fromEntries(body.trades.map((t: { symbol: string }) => [t.symbol, t]));
    expect(bySymbol.IBM).toMatchObject({ action: 'BUY', quantity: 66.666667 });
    expect(bySymbol.ORCL).toMatchObject({ action: 'SELL', quantity: 45.454545 });
  });
});

test.describe('POST /api/rebalance – validation and errors', () => {
  const invalid = [
    { name: 'targets do not add up to 100%', data: withPositions({ IBM: { targetPct: 25 } }), error: 'targetPct values must add up to 100 (got 105)' },
    { name: 'zero price', data: withPositions({ ORCL: { price: 0 } }), error: 'ORCL: price must be a number greater than 0' },
    { name: 'totalAssets sent as a string', data: { ...accountABC(), totalAssets: '100000' }, error: 'totalAssets must be a number greater than 0' },
    { name: 'positions missing', data: { accountId: 'ABC', totalAssets: 100000 }, error: 'positions must contain at least one security' },
  ];

  for (const c of invalid) {
    test(`422 when ${c.name}`, async ({ request }) => {
      const res = await request.post(ENDPOINT, { data: c.data });
      expect(res.status()).toBe(422);
      expect((await res.json()).errors).toContain(c.error);
    });
  }

  test('400 for malformed JSON', async ({ request }) => {
    // Send raw bytes: with a JSON content type Playwright would JSON-encode a plain string
    // into a valid string literal, so the server would never see the broken payload.
    const res = await request.post(ENDPOINT, {
      data: Buffer.from('{"accountId": "ABC", "totalAssets": '),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ errors: ['request body must be valid JSON'] });
  });

  test('405 for GET on the rebalance endpoint', async ({ request }) => {
    expect((await request.get(ENDPOINT)).status()).toBe(405);
  });

  test('404 for an unknown route', async ({ request }) => {
    expect((await request.post('/api/rebalance-all', { data: accountABC() })).status()).toBe(404);
  });
});
