# CRD Portfolio Rebalancer — Manual & Automated Tests

Technical assessment for Charles River Development / Alpha Platform Engineering.
Stack: **TypeScript + Playwright Test** (unit-level and API tests in one runner).

---

## 1. The problem and the answer

For each security:

```
variance %  = current % − target %                 (−ve → BUY, +ve → SELL)
dollar gap  = (target % − current %) × total assets
shares      = dollar gap ÷ unit price
```

| Security | Target % | Current % | Variance | Dollar gap | Price | Exact shares | **Whole shares (output)** |
|---|---|---|---|---|---|---|---|
| IBM  | 20 | 10 | −10 | +$10,000 | 150 | +66.67 | **BUY 66** ($9,900) |
| MSFT | 20 | 20 | 0 | $0 | 90 | 0 | **HOLD** |
| ORCL | 20 | 30 | +10 | −$10,000 | 220 | −45.45 | **SELL 45** ($9,900) |
| AAPL | 20 | 20 | 0 | $0 | 450 | 0 | **HOLD** |
| HD   | 20 | 20 | 0 | $0 | 70 | 0 | **HOLD** |

**To reach zero target variance: sell 45 shares of ORCL and buy 66 shares of IBM.**
The ORCL sale ($9,900) funds the IBM purchase ($9,900) exactly — net cash $0.

With whole shares the variance can't be exactly zero: IBM ends at 19.9% and ORCL at 20.1% (less than one share
of each). If fractional shares are allowed, the exact answer is **BUY 66.666667 IBM / SELL 45.454545 ORCL**, and
every security lands on exactly 20%.

## 2. Assumptions

1. **Investable base** = total assets × vested %. With 100% vested that's $100,000. Target/current % are
   percentages of this base.
2. **Whole shares by default, rounded down (toward zero).** This never buys past target and never sells more
   than is held; the residual is always smaller than one share. A `fractional` mode is also supported because
   the current holdings themselves imply fractional shares (10% of $100K at $150 = 66.67 IBM shares).
3. Buys are funded by sells; there is no separate cash position, so current % must add up to 100.
   Cash left over from rounding stays in the account.
4. Target % and current % must each add up to **100 ± 0.01** (rounding tolerance).
5. Trades execute at the given unit prices — no commissions, taxes, FX, slippage or market movement.
6. No short selling: a sell can never exceed the shares held.
7. Variance is reported as current − target, matching the assessment sheet.
8. A security whose gap is smaller than one share price gets **HOLD** (no zero-quantity orders).
9. Invalid input is rejected with all errors listed at once (HTTP 422); malformed JSON → 400.

## 3. Project layout

```
src/
  rebalancer.ts            logic + validation (the "application under test")
  server.ts                tiny HTTP API: POST /api/rebalance, GET /health
test-data/
  account-abc.json         the assessment account
tests/
  helpers/data.ts          builders + hand-calculated expected results (the oracle)
  helpers/random.ts        seeded random portfolio generator
  unit/rebalancer.spec.ts  scenario, rules, scaling, validation (data-driven)
  unit/invariants.spec.ts  property-based checks on 500 random portfolios
  api/rebalance.api.spec.ts  API: expected orders, contract, status codes
docs/
  manual-test-cases.md     30 manual test cases with traceability to automation
```

## 4. How to run

```bash
npm install
npx playwright test            # all 55 tests (starts the API automatically)
npm run test:unit              # logic only
npm run test:api               # API only
npm run report                 # open the HTML report
npm start                      # run the API on http://localhost:3005 (e.g. for Postman)
```

No browsers are needed — these are unit and API tests.

## 5. Test strategy

- **Independent oracle.** Expected results are hand-calculated literals (66, 45, $9,900…). The tests never
  re-use the application's formula — otherwise a bug in the formula would also be in the expectation.
- **Layers.** Logic (fast, exhaustive) → API (contract, status codes, serialisation) → UI (manual cases; would be
  Playwright e2e with page objects against the real screen).
- **Data-driven tests** for the scenario table and for 18 validation cases.
- **Property-based invariants** on 500 seeded random portfolios: correct direction, whole quantities, never past
  target, residual below one share, never oversell, totals consistent; fractional mode lands on target and is
  cash-neutral; re-running is idempotent. Failures print the seed for replay.
- **Known traps covered:** division by zero (price 0), floating point (29.9 − 20 = 9.899999999999999 in JS would
  truncate 45 shares to 44), 99.99% vs 99.98% tolerance boundary, liquidation without overselling, $1B precision.`
- **Mutation check:** planting three bugs (no float fix, round-to-nearest, flipped sign) fails 2, 9 and 15 tests
  respectively — the suite catches real defects.

## 6. Open questions for the team

- **Rounding policy** is a business rule. Round-to-nearest would give IBM BUY 67 ($10,050) vs ORCL SELL 45
  ($9,900) — $150 short of cash. Round lots (100 shares) would change everything again.
- Are fractional holdings real (as the input implies), or are the percentages approximate?
- Drift tolerance bands (only rebalance when |variance| > X%), minimum trade size, cash buffer, restricted lists,
  tax lots / wash-sale rules.

## 7. With more time

UI e2e tests (Playwright + page objects), OpenAPI schema validation, CI pipeline (GitLab/Jenkins) on every merge
request, performance test for large models, and DB/OMS checks that released orders match the proposal.
