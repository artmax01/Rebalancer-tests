# Manual Test Cases — Portfolio Rebalancer

**Application under test:** a rebalancing screen (and its `POST /api/rebalance` service) that takes an
account's holdings — target %, current %, unit price — and proposes the number of shares to buy or sell
per security so the account reaches zero target variance.

**Assumed UI:** account selector → holdings grid (Security, Target %, Current %, Variance, Unit price)
→ **Rebalance** button → proposed orders grid (Security, Side, Quantity, Est. value, Projected %)
→ totals (Buy, Sell, Net cash) → **Release orders**.

**Base data (Account ABC):** total assets $100,000, 100% vested

| Security | Target % | Current % | Unit price |
|---|---|---|---|
| IBM | 20 | 10 | 150 |
| MSFT | 20 | 20 | 90 |
| ORCL | 20 | 30 | 220 |
| AAPL | 20 | 20 | 450 |
| HD | 20 | 20 | 70 |

Priority: **P1** = must pass to release, **P2** = important, **P3** = nice to have.
**Auto** = also covered by the automated suite (see `tests/`).

---

## A. Core calculation

| ID | Scenario | Steps / data | Expected result | Pri | Auto |
|---|---|---|---|---|---|
| TC-01 | Assessment scenario, whole shares | Open Account ABC → Rebalance | IBM **BUY 66** ($9,900) · ORCL **SELL 45** ($9,900) · MSFT, AAPL, HD **HOLD 0**. Totals: Buy $9,900, Sell $9,900, Net cash $0 | P1 | ✓ |
| TC-02 | Variance column | Open Account ABC, inspect Variance before rebalancing | IBM −10, MSFT 0, ORCL +10, AAPL 0, HD 0 (variance = current − target; −ve = buy, +ve = sell) | P1 | ✓ |
| TC-03 | Projected % after trades | After TC-01, inspect Projected % | IBM 19.9%, ORCL 20.1%, others 20%. Residual is less than one share of each security | P1 | ✓ |
| TC-04 | Fractional shares enabled | Turn on fractional shares → Rebalance Account ABC | IBM BUY 66.666667, ORCL SELL 45.454545, every Projected % = 20.00, Net cash $0 | P2 | ✓ |
| TC-05 | Already balanced account | Set IBM and ORCL current % to 20 → Rebalance | No orders; all rows HOLD 0; message such as "Account is within target"; Release orders disabled | P1 | ✓ |
| TC-06 | Idempotency | Execute the proposal from TC-04, reload the account → Rebalance again | No new orders are proposed | P2 | ✓ |
| TC-07 | Full liquidation (target 0%) | HD target 0, IBM target 40 / current 20, ORCL current 20 → Rebalance | HD SELL 285 ($19,950) — never more than the 285.71 shares held; IBM BUY 133 ($19,950) | P1 | ✓ |
| TC-08 | New position (current 0%) | MSFT current 0, ORCL current 40, IBM current 20 → Rebalance | MSFT BUY 222 ($19,980); ORCL SELL 90 ($19,800) | P1 | ✓ |
| TC-09 | Gap smaller than one share | Total assets $1,000; AAPL current 10, HD current 30, IBM/ORCL current 20 → Rebalance | AAPL HOLD (needs $100, one share is $450); HD SELL 1 ($70). No zero-quantity orders are created | P2 | ✓ |
| TC-10 | Decimal percentages | 3 securities: target 33.33 / 33.33 / 33.34, current 50 / 25 / 25, prices 100 / 50 / 25 | SELL 166 / BUY 166 / BUY 333 | P2 | ✓ |
| TC-11 | Floating-point precision | IBM target 10.1 / current 20, ORCL target 29.9 / current 20 → Rebalance | ORCL **BUY 45** (not 44 — 9.9% × $100K ÷ $220 is exactly 45); IBM SELL 66 | P2 | ✓ |

## B. Boundaries and scale

| ID | Scenario | Steps / data | Expected result | Pri | Auto |
|---|---|---|---|---|---|
| TC-12 | Large account | Total assets $1,000,000,000 → Rebalance | IBM BUY 666,666, ORCL SELL 454,545; values shown with thousand separators, no scientific notation or truncation in the grid | P2 | ✓ calc |
| TC-13 | Partially vested | Vested 50% → Rebalance | Investable shown as $50,000; IBM BUY 33, ORCL SELL 22 | P2 | ✓ |
| TC-14 | Percentage sum tolerance | (a) targets add to 99.99% (b) targets add to 99.98% | (a) accepted (b) blocked with "targetPct values must add up to 100" | P2 | ✓ |
| TC-15 | Single security, 0/100 boundaries | One security, target 100 / current 100 | HOLD 0, no errors | P3 | ✓ |
| TC-16 | Large model | Account with 500 securities | Proposal returned within the agreed SLA (e.g. < 2 s); grid scrolls/paginates; totals correct | P3 | — |

## C. Validation and negative paths

| ID | Scenario | Steps / data | Expected result | Pri | Auto |
|---|---|---|---|---|---|
| TC-17 | Targets ≠ 100% | IBM target 25 (sum 105) | Blocking error naming the sum; no orders generated | P1 | ✓ |
| TC-18 | Current ≠ 100% | ORCL current 20 (sum 90) | Blocking error (or, if the business treats the gap as cash, a cash row is shown — **confirm with BA**) | P1 | ✓ |
| TC-19 | Bad price | Price 0, then −150, then blank | Field-level error per security; no crash, no "Infinity"/"NaN" in the grid | P1 | ✓ |
| TC-20 | Non-numeric input | Enter `abc`, `20%`, `1e5`, spaces, `20,5` in % and price fields | Rejected or normalised consistently; error message is clear | P2 | ✓ API |
| TC-21 | Percentage out of range | Target −5, target 120 | Error "must be between 0 and 100" | P2 | ✓ |
| TC-22 | Total assets ≤ 0 | 0, then −100,000 | Error; Rebalance disabled | P2 | ✓ |
| TC-23 | Duplicate security | Add `ibm` alongside `IBM` | Error "duplicate symbol" (case-insensitive) | P3 | ✓ |
| TC-24 | Empty account | Account with no positions | Friendly message, no orders, no exception | P3 | ✓ |
| TC-25 | Multiple errors at once | Price 0 on IBM, target −1 on ORCL, total assets 0 | All three errors shown together, not one at a time | P3 | ✓ |

## D. Integration, data and access

| ID | Scenario | Steps / data | Expected result | Pri | Auto |
|---|---|---|---|---|---|
| TC-26 | Price refresh | Change ORCL price in market data → Rebalance | New price used; price timestamp shown; stale prices flagged | P2 | — |
| TC-27 | Switching accounts | Rebalance ABC, then switch to another account | Previous proposal is cleared; no data from ABC is shown | P2 | — |
| TC-28 | Release to trading | Release the TC-01 proposal | Exactly two orders reach the OMS: BUY 66 IBM, SELL 45 ORCL — side, symbol, quantity and account match the grid | P1 | — |
| TC-29 | Permissions and audit | Log in as a read-only user; then as a trader | Read-only user can view but not release; audit log records who rebalanced, when, and what was proposed | P2 | — |
| TC-30 | API contract and errors | Postman: valid body, malformed JSON, GET instead of POST, unknown route | 200 with documented fields/types; 400; 405; 404 | P2 | ✓ |
