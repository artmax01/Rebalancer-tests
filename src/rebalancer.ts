/**
 * Portfolio rebalancer — the "application under test" for the CRD assessment.
 *
 * For every security:
 *   variance%  = current% − target%          (−ve → BUY, +ve → SELL)
 *   dollarGap  = (target% − current%) / 100 × investableAssets
 *   shares     = dollarGap / unitPrice       (+ve → BUY, −ve → SELL)
 *
 * investableAssets = totalAssets × vested% / 100
 *
 * Rounding (see README → Assumptions):
 *   wholeDown  (default) – whole shares, truncated toward zero, so we never
 *                          over-buy past target or sell more than we hold.
 *   fractional           – fractional shares, rounded to 6 decimals.
 */

export type RoundingMode = 'wholeDown' | 'fractional';
export type Action = 'BUY' | 'SELL' | 'HOLD';

export interface PositionInput {
  symbol: string;
  targetPct: number;
  currentPct: number;
  price: number;
}

export interface RebalanceRequest {
  accountId: string;
  totalAssets: number;
  vestedPct?: number;
  rounding?: RoundingMode;
  positions: PositionInput[];
}

export interface TradeLine {
  symbol: string;
  targetPct: number;
  currentPct: number;
  variancePct: number;
  price: number;
  action: Action;
  quantity: number;
  tradeValue: number;
  projectedPct: number;
}

export interface RebalanceResult {
  accountId: string;
  investableAssets: number;
  rounding: RoundingMode;
  trades: TradeLine[];
  totalBuyValue: number;
  totalSellValue: number;
  netCash: number;
}

export class ValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('; '));
    this.name = 'ValidationError';
  }
}

const PCT_SUM_TOLERANCE = 0.01;
const SHARE_DECIMALS = 6;
const ROUNDING_MODES: RoundingMode[] = ['wholeDown', 'fractional'];

/** Half-away-from-zero rounding that never returns -0. */
export function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = (Math.sign(n) * Math.round(Math.abs(n) * f)) / f;
  return r === 0 ? 0 : r;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPct = (v: unknown): v is number => isFiniteNumber(v) && v >= 0 && v <= 100;

export function validate(req: RebalanceRequest): string[] {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return ['request body must be a JSON object'];
  }
  const errors: string[] = [];

  if (!isFiniteNumber(req.totalAssets) || req.totalAssets <= 0) {
    errors.push('totalAssets must be a number greater than 0');
  }
  const vested = req.vestedPct ?? 100;
  if (!isFiniteNumber(vested) || vested <= 0 || vested > 100) {
    errors.push('vestedPct must be greater than 0 and at most 100');
  }
  if (req.rounding !== undefined && !ROUNDING_MODES.includes(req.rounding)) {
    errors.push(`rounding must be one of: ${ROUNDING_MODES.join(', ')}`);
  }
  if (!Array.isArray(req.positions) || req.positions.length === 0) {
    errors.push('positions must contain at least one security');
    return errors;
  }

  const seen = new Set<string>();
  req.positions.forEach((p, i) => {
    const hasSymbol = !!p && typeof p.symbol === 'string' && p.symbol.trim() !== '';
    const label = hasSymbol ? p.symbol : `positions[${i}]`;
    if (!hasSymbol) {
      errors.push(`positions[${i}].symbol is required`);
    } else if (seen.has(p.symbol.trim().toUpperCase())) {
      errors.push(`duplicate symbol ${p.symbol}`);
    } else {
      seen.add(p.symbol.trim().toUpperCase());
    }
    if (!isPct(p?.targetPct)) errors.push(`${label}: targetPct must be a number between 0 and 100`);
    if (!isPct(p?.currentPct)) errors.push(`${label}: currentPct must be a number between 0 and 100`);
    if (!isFiniteNumber(p?.price) || p.price <= 0) errors.push(`${label}: price must be a number greater than 0`);
  });

  if (errors.length === 0) {
    const targetSum = req.positions.reduce((s, p) => s + p.targetPct, 0);
    const currentSum = req.positions.reduce((s, p) => s + p.currentPct, 0);
    // +1e-9 so the ±0.01 boundary itself is accepted despite float noise (100 − 99.99 = 0.0100000000000051)
    if (Math.abs(targetSum - 100) > PCT_SUM_TOLERANCE + 1e-9) {
      errors.push(`targetPct values must add up to 100 (got ${roundTo(targetSum, 4)})`);
    }
    if (Math.abs(currentSum - 100) > PCT_SUM_TOLERANCE + 1e-9) {
      errors.push(`currentPct values must add up to 100 (got ${roundTo(currentSum, 4)})`);
    }
  }
  return errors;
}

export function rebalance(req: RebalanceRequest): RebalanceResult {
  const errors = validate(req);
  if (errors.length > 0) throw new ValidationError(errors);

  const rounding: RoundingMode = req.rounding ?? 'wholeDown';
  const investable = (req.totalAssets * (req.vestedPct ?? 100)) / 100;

  const trades: TradeLine[] = req.positions.map((p) => {
    const dollarGap = ((p.targetPct - p.currentPct) / 100) * investable; // + buy, − sell
    // Round first to strip binary floating-point noise (e.g. 44.99999999999999 → 45)
    const rawShares = roundTo(dollarGap / p.price, SHARE_DECIMALS);
    const signedShares = rounding === 'wholeDown' ? Math.trunc(rawShares) : rawShares;

    const action: Action = signedShares > 0 ? 'BUY' : signedShares < 0 ? 'SELL' : 'HOLD';
    const quantity = action === 'HOLD' ? 0 : Math.abs(signedShares);
    const tradeValue = roundTo(quantity * p.price, 2);

    const currentValue = (p.currentPct / 100) * investable;
    const projectedValue = currentValue + (action === 'SELL' ? -tradeValue : tradeValue);

    return {
      symbol: p.symbol,
      targetPct: p.targetPct,
      currentPct: p.currentPct,
      variancePct: roundTo(p.currentPct - p.targetPct, 4),
      price: p.price,
      action,
      quantity,
      tradeValue,
      projectedPct: roundTo((projectedValue / investable) * 100, 4),
    };
  });

  const totalBuyValue = roundTo(trades.filter((t) => t.action === 'BUY').reduce((s, t) => s + t.tradeValue, 0), 2);
  const totalSellValue = roundTo(trades.filter((t) => t.action === 'SELL').reduce((s, t) => s + t.tradeValue, 0), 2);

  return {
    accountId: req.accountId,
    investableAssets: roundTo(investable, 2),
    rounding,
    trades,
    totalBuyValue,
    totalSellValue,
    netCash: roundTo(totalSellValue - totalBuyValue, 2),
  };
}
