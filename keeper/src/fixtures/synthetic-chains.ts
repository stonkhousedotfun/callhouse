/**
 * Deterministic, wholly synthetic option-chain responses for offline tests.
 * Prices come from our Black–Scholes implementation at deliberately chosen forwards and vols;
 * no vendor quote, downloaded chain, or recorded market observation is used here.
 */
import { bsDelta, bsPrice, tradingYears } from '../v2/pricing/bs.js';
import { parseCboeChain, type CboeChain } from '../vol.js';

interface SyntheticOptionRow {
  option: string;
  bid: number;
  ask: number;
  iv: number;
  delta: number;
}

interface SyntheticPayload {
  timestamp: string;
  data: {
    symbol: string;
    current_price: number;
    last_trade_time: string;
    options: SyntheticOptionRow[];
  };
}

interface Recipe {
  root: string;
  shareSpot: number;
  forward: number;
  vol: number;
  timestamp: string;
  lastTradeTime: string;
  asOf: number;
  expiries: readonly number[];
  firstStrike: number;
  lastStrike: number;
}

const sepClose = (day: number) => Date.UTC(2026, 8, day, 20) / 1000;
const cents = (value: number) => Math.round(value * 100) / 100;

function buildPayload(recipe: Recipe): SyntheticPayload {
  const options: SyntheticOptionRow[] = [];
  for (const day of recipe.expiries) {
    const expiry = sepClose(day);
    const t = tradingYears(recipe.asOf, expiry);
    for (let strike = recipe.firstStrike; strike <= recipe.lastStrike; strike += 2.5) {
      for (const type of ['C', 'P'] as const) {
        const kind = type === 'C' ? 'call' as const : 'put' as const;
        const input = { type: kind, spot: recipe.forward, strike, t, vol: recipe.vol };
        const theoretical = bsPrice(input);
        const bid = Math.max(0.01, cents(theoretical) - 0.02);
        const ask = cents(bid + 0.04);
        const rawDelta = bsDelta(input);
        // Four-decimal vendor-shaped deltas, kept strictly inside the valid open interval.
        const magnitude = Math.max(0.0001, Math.min(0.9999, Math.round(Math.abs(rawDelta) * 10_000) / 10_000));
        const symbol = `${recipe.root}26${String(9).padStart(2, '0')}${String(day).padStart(2, '0')}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
        options.push({ option: symbol, bid: cents(bid), ask, iv: recipe.vol, delta: type === 'C' ? magnitude : -magnitude });
      }
    }
  }
  return {
    timestamp: recipe.timestamp,
    data: {
      symbol: recipe.root,
      current_price: recipe.shareSpot,
      last_trade_time: recipe.lastTradeTime,
      options,
    },
  };
}

const nvda: Recipe = {
  root: 'NVDA', shareSpot: 212.35, forward: 211.4, vol: 0.43,
  timestamp: '2026-09-15 05:45:00', lastTradeTime: '2026-09-14T15:59:59',
  asOf: Date.UTC(2026, 8, 14, 19, 59, 59) / 1000,
  expiries: [18, 25], firstStrike: 185, lastStrike: 250,
};

const tsla: Recipe = {
  root: 'TSLA', shareSpot: 360.4, forward: 358.9, vol: 0.52,
  timestamp: '2026-09-17 05:45:00', lastTradeTime: '2026-09-16T15:59:59',
  asOf: Date.UTC(2026, 8, 16, 19, 59, 59) / 1000,
  expiries: [16, 18, 21, 23, 25], firstStrike: 315, lastStrike: 405,
};

export const syntheticNvdaPayload = (): SyntheticPayload => buildPayload(nvda);
export const syntheticTslaPayload = (): SyntheticPayload => buildPayload(tsla);
export const syntheticNvdaChain = (): CboeChain => parseCboeChain(syntheticNvdaPayload());
export const syntheticTslaChain = (): CboeChain => parseCboeChain(syntheticTslaPayload());
