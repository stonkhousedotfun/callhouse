/**
 * Deterministic, wholly synthetic option-chain responses for offline tests.
 * Prices come from our Black–Scholes implementation at deliberately chosen forwards and vols;
 * no vendor quote, downloaded chain, or recorded market observation is used here.
 */
import { CLOSE_HOUR_ET, newYorkTimeToUnix } from '../calendar.js';
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
  /** Listed expiry days, YYYY-MM-DD New York; each expires at that day's 16:00 close. */
  expiries: readonly string[];
  firstStrike: number;
  lastStrike: number;
}

const closeOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return newYorkTimeToUnix(y, m, d, CLOSE_HOUR_ET);
};
const cents = (value: number) => Math.round(value * 100) / 100;

function buildPayload(recipe: Recipe): SyntheticPayload {
  const options: SyntheticOptionRow[] = [];
  for (const day of recipe.expiries) {
    const expiry = closeOf(day);
    const t = tradingYears(recipe.asOf, expiry);
    const yymmdd = day.slice(2).replaceAll('-', '');
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
        const symbol = `${recipe.root}${yymmdd}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
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
  expiries: ['2026-09-18', '2026-09-25'], firstStrike: 185, lastStrike: 250,
};

const tsla: Recipe = {
  root: 'TSLA', shareSpot: 360.4, forward: 358.9, vol: 0.52,
  timestamp: '2026-09-17 05:45:00', lastTradeTime: '2026-09-16T15:59:59',
  asOf: Date.UTC(2026, 8, 16, 19, 59, 59) / 1000,
  expiries: ['2026-09-16', '2026-09-18', '2026-09-21', '2026-09-23', '2026-09-25'], firstStrike: 315, lastStrike: 405,
};

/** The NVDA recipe with every session of the week listed: the three dailies before Friday too. */
const nvdaDailies: Recipe = { ...nvda, expiries: ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-25'] };

/**
 * A Thanksgiving-week NVDA chain, as of Tuesday 24 November 2026's close (16:00 EST, after the DST
 * switch). Thursday 26 November is a full-day NYSE holiday and Friday 27 November an early close
 * (13:00). Listed: that Friday, and the two Fridays after it; no Wednesday or Monday listing.
 */
const nvdaThanksgiving: Recipe = {
  root: 'NVDA', shareSpot: 200.3, forward: 200, vol: 0.45,
  timestamp: '2026-11-25 05:45:00', lastTradeTime: '2026-11-24T15:59:59',
  asOf: Date.UTC(2026, 10, 24, 20, 59, 59) / 1000,
  expiries: ['2026-11-27', '2026-12-04', '2026-12-11'], firstStrike: 170, lastStrike: 235,
};

export const syntheticNvdaPayload = (): SyntheticPayload => buildPayload(nvda);
export const syntheticTslaPayload = (): SyntheticPayload => buildPayload(tsla);
export const syntheticNvdaChain = (): CboeChain => parseCboeChain(syntheticNvdaPayload());
export const syntheticTslaChain = (): CboeChain => parseCboeChain(syntheticTslaPayload());
export const syntheticNvdaDailiesChain = (): CboeChain => parseCboeChain(buildPayload(nvdaDailies));
export const syntheticNvdaThanksgivingChain = (): CboeChain => parseCboeChain(buildPayload(nvdaThanksgiving));
