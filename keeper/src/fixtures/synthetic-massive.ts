/**
 * Synthetic Massive option-snapshot responses (GET /v3/snapshot/options/{root}) for offline tests.
 *
 * The SHAPE is Massive's, field for field, as a live NVDA response returned it on 2026-09-22: `details`
 * (contract_type, exercise_style, expiration_date, shares_per_contract, strike_price, ticker),
 * `last_quote` (ask, ask_size, ask_exchange, bid, bid_size, bid_exchange, last_updated in nanoseconds,
 * midpoint, timeframe), `greeks`, `implied_volatility`, `last_trade`, `day`, `open_interest`,
 * `break_even_price` and `underlying_asset` (price, last_updated, timeframe), paged by `next_url`. The
 * VALUES are not: every row is a synthetic-chains.ts row restated, so no vendor quote is committed
 * (the repo's rule for captured third-party chains, .gitignore). Massive's omissions are reproduced
 * on purpose: `greeks: {}` with no `implied_volatility` (what it sends for a contract it cannot solve),
 * an empty `last_trade`, and an empty `day`.
 */
import type { CboeChain } from '../vol.js';
import { parseNewYorkLocalTime } from '../vol.js';

export type MassiveRowJson = Record<string, unknown>;

/** Unix seconds to Massive's nanosecond integer. */
export const toNs = (seconds: number): number => seconds * 1e9;

/** `NVDA260918C00220000` -> `O:NVDA260918C00220000`, Massive's OCC ticker. */
export const occTicker = (cboeSymbol: string): string => `O:${cboeSymbol}`;

export interface MassiveRestateOptions {
  /** Every quote's `last_updated`, unix seconds. Default the chain's last trade. */
  quoteAt?: number;
  /** The underlying's `last_updated`, unix seconds. Default the chain's last trade. */
  underlyingAt?: number;
  quoteTimeframe?: 'REAL-TIME' | 'DELAYED';
  underlyingTimeframe?: 'REAL-TIME' | 'DELAYED';
}

/** A synthetic Cboe chain's rows as Massive would send them: same quotes, greeks and strikes. */
export function massiveRowsFromCboe(chain: CboeChain, options: MassiveRestateOptions = {}): MassiveRowJson[] {
  const lastTrade = parseNewYorkLocalTime(chain.lastTradeTime);
  if (lastTrade === null) throw new Error(`synthetic chain ${chain.root} has an unparseable last trade`);
  const quoteAt = options.quoteAt ?? lastTrade;
  const underlyingAt = options.underlyingAt ?? lastTrade;
  return chain.options.map((o) => ({
    break_even_price: o.type === 'C' ? o.strike + (o.bid + o.ask) / 2 : o.strike - (o.bid + o.ask) / 2,
    day: {},
    details: {
      contract_type: o.type === 'C' ? 'call' : 'put',
      exercise_style: 'american',
      expiration_date: o.expiry,
      shares_per_contract: 100,
      strike_price: o.strike,
      ticker: occTicker(o.symbol),
    },
    greeks: { delta: o.delta, gamma: 0.01, theta: -0.1, vega: 0.1 },
    implied_volatility: o.iv,
    last_quote: {
      ask: o.ask,
      ask_size: 10,
      ask_exchange: 302,
      bid: o.bid,
      bid_size: 10,
      bid_exchange: 302,
      last_updated: toNs(quoteAt),
      midpoint: (o.bid + o.ask) / 2,
      timeframe: options.quoteTimeframe ?? 'REAL-TIME',
    },
    last_trade: {},
    open_interest: 0,
    underlying_asset: {
      change_to_break_even: 0,
      last_updated: toNs(underlyingAt),
      price: chain.shareSpot,
      ticker: chain.root,
      timeframe: options.underlyingTimeframe ?? 'DELAYED',
    },
  }));
}

/** `rows` cut into Massive pages of `pageSize`, each but the last pointing at the next by a cursor. */
export function massivePages(rows: readonly MassiveRowJson[], root: string, pageSize = 250, base = 'https://api.massive.com'): Array<{ status: string; request_id: string; results: MassiveRowJson[]; next_url?: string }> {
  const pages: Array<{ status: string; request_id: string; results: MassiveRowJson[]; next_url?: string }> = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += pageSize) {
    const page: { status: string; request_id: string; results: MassiveRowJson[]; next_url?: string } = { status: 'OK', request_id: `synthetic-${i / pageSize}`, results: rows.slice(i, i + pageSize) };
    if (i + pageSize < rows.length) page.next_url = `${base}/v3/snapshot/options/${root}?cursor=synthetic-${i / pageSize + 1}`;
    pages.push(page);
  }
  return pages;
}
