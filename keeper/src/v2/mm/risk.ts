/**
 * Quote sizes inside the MakerVault's on-chain guards and the bot's own caps. Pure.
 *
 * WHY MIRROR THE GUARDS. A vault call that breaks a guard reverts after its simulation passed a
 * moment ago, or its simulation reverts and the series is left unquoted; either way the gas or the
 * quote is lost. So every size is chosen so that the vault's own post-condition holds (MakerVault.sol
 * SIZE GUARDS, restated here with the vault's names):
 *
 *   up       = longs + resale escrow + bid units − shorts
 *   down     = shorts + write units − (longs + resale escrow − resale units)   (escrowed longs leave the wallet)
 *   exposure = max(up, down, 0)                                    <= min(maxSeriesUnits, MM_MAX_SERIES_UNITS)
 *   Σ notional = totalNotional − seriesNotional[s] + exposure × strike / 100
 *                                                                  <= min(maxTotalNotional, MM_MAX_TOTAL_NOTIONAL_USDG6)
 *
 * using the vault's STORED `totalNotional` and `seriesNotional` (the values its check reads), series by
 * series in quoting priority. The vault reverts only when an action GROWS a series past a cap; sizing
 * the final state under the caps keeps every intermediate call (cancels, then replaces, then places)
 * under them too, because each call only moves a side towards its final value.
 *
 * FUNDS, which the vault does not check but the book does at fill time:
 *   - bids escrow USDG from the vault WALLET: price × units / 100 against the wallet balance plus the
 *     escrow of the vault's live bids (a replace or cancel hands that back);
 *   - AskWrite mints from the vault's Clearinghouse LEDGER when hit: units × collateralPerUnit PLUS THE
 *     CLEARINGHOUSE'S RENT on that collateral (INTERFACE_VERSION 7) of the series' collateral asset
 *     (the Stock Token for calls, USDG for puts) against `free(vault, asset)`, shared by every write ask on
 *     that asset (a write ask the ledger cannot cover is skipped by takers' fills, so quoting it would only
 *     advertise depth that is not there);
 *   - AskResale escrows the vault's own longs, so it sells at most what the vault holds.
 * The ask side is MM_ASK_UNITS in total: inventory first (resale), then writes for the rest.
 *
 * RENT (INTERFACE_VERSION 7). `OrderBook._reserveCollateral` budgets
 * `units × cpu + ceil(units × cpu × mintFeePpm × (expiry − now) / (1e6 × 7 days))`, so `free / cpu` now
 * over-advertises a write ask by the rent. Sizes come from mintFee.maxWriteUnits, the exact inverse of that
 * predicate for ONE fill of the whole order (what `quoteTake` answers), and each series subtracts its own exact
 * need from the shared per-asset budget — the chain rounds once per fill, so a second ask on the same asset must
 * not reuse the rent the first one will pay.
 *
 * THE OUTFLOW CAP (INTERFACE_VERSION 7). `MakerVault` charges the net USDG a quoter call moves out against a
 * leaky bucket (`limits.maxDailyOutflow` per OUTFLOW_WINDOW) and reverts `OutflowCapExceeded` above it. Placing or
 * replacing a Bid is booked and enforced; a cancel credits its escrow back. `SizeLimits.outflowBudget` is what a
 * tick may still escrow in new bids after the credits its own cancels and replaces hand back — the caller computes
 * `cap − max(0, used − releasedEscrow)` — and bids are sized inside it, so the cap trims quotes instead of
 * reverting a send.
 *
 * THE PER-EXPIRY CAP. A bot-side cap, like MM_MAX_TOTAL_NOTIONAL_USDG6 but over the series of
 * ONE expiry: every 0DTE series settles at the same 16:00 print, so the day's whole book is one correlated bet.
 *   Σ notional(expiry) = expiryNotional[expiry] − seriesNotional[s] + exposure × strike / 100  <= maxExpiryNotional
 * `expiryNotional` is the stored notional of EVERY managed series of that expiry (quoted or not), summed by the caller;
 * it runs down series by series exactly like the total. 0n = no cap (explicit opt-out).
 *
 * THE GREEK GATE (P14). A side that would take a market's |net delta| (shares) past MM_MAX_DELTA_SHARES, or its
 * |net gamma| (share-delta per USD of spot) past MM_MAX_GAMMA, is not quoted -- and only that side: a side that moves
 * the net TOWARDS zero is never stopped, however large the net already is. {gateGreeks} keeps, per market, the range
 * the net could reach if every side already allowed this tick filled in full (`lo` if every sale fills, `hi` if every
 * purchase does), so two series of one market cannot each use the same room.
 */
import { collateralNeeded, maxWriteUnits, remainingLife } from '../mintFee.js';
import { UNITS_PER_SHARE } from './constants.js';

export interface SizeSeries {
  longId: bigint;
  strike: bigint;
  /** MakerVault.exposure detail. */
  longs: bigint;
  resale: bigint;
  shorts: bigint;
  /** MakerVault.seriesNotional(longId): the stored value the guard reads. */
  seriesNotional: bigint;
  collateralAsset: string;
  collateralPerUnit: bigint;
  /** The series' pinned rent rate, millionths of the locked collateral per 7 days (INTERFACE_VERSION 7). */
  mintFeePpm: number;
  /** Series expiry, unix seconds: with `SizeLimits.now` it gives the remaining life the rent is charged on. */
  expiry: number;
  /** Prices of the quotes this series wants; null = that side is not quoted. */
  bidPrice: bigint | null;
  askPrice: bigint | null;
  /** false when the market's minting is paused: an AskWrite fill would be skipped, so only inventory is offered. */
  writeAllowed: boolean;
}

export interface SizeLimits {
  /** Head block timestamp: the rent is charged on `expiry − now`, as the book's budget is. */
  now: number;
  /** Vault limits.maxSeriesUnits and the bot's cap (0n = none) combined by the caller or here. */
  vaultMaxSeriesUnits: bigint;
  botMaxSeriesUnits: bigint;
  vaultMaxTotalNotional: bigint;
  botMaxTotalNotional: bigint;
  /** MakerVault.totalNotional (stored). */
  totalNotional: bigint;
  /**
   * USDG the tick may put into bid escrow: the vault's wallet plus the escrow of its live bids, less (on a House
   * vault) the USDG reserved for queued deposits and unclaimed withdrawals, never below zero (planner.bidBudget,
   *
   */
  usdgBudget: bigint;
  /**
   * USDG base units of NEW bid escrow this tick may create before `MakerVault` reverts `OutflowCapExceeded`:
   * `maxDailyOutflow − max(0, outflow().used − the escrow this tick's cancels and replaces give back)`.
   */
  outflowBudget: bigint;
  /** Clearinghouse.free(vault, asset) per lower-case asset. */
  freeCollateral: ReadonlyMap<string, bigint>;
  /**
   * MM_WRITE_OVERSUBSCRIBE_BPS. The per-asset write budget the ASKS ARE SIZED AGAINST is
   * `free x bps / 10_000`; 10_000 is today's exact budget (the advertised sum never exceeds `free`). Above it the
   * book is ONE POOL shared by every ask on the asset: each single ask still fits `maxWriteUnits(free)`, so any ONE
   * fill is always covered, and only several fills of different series inside one tick can outrun the pool -- the
   * book then SKIPS the uncoverable fill at plan time (`OrderBook._plan`, filled whole or skipped, never cut) and
   * catches a mint that still fails at delivery, so a taker never reverts on our shortfall. `undefined` = 10_000.
   */
  writeOversubscribeBps?: number;
  bidUnits: bigint;
  askUnits: bigint;
  /** P13: the per-expiry cap, USDG base units; 0n or absent = none. */
  maxExpiryNotional?: bigint;
  /** P13: stored notional by expiry over every managed series (the caller sums SeriesView.seriesNotional). */
  expiryNotional?: ReadonlyMap<number, bigint>;
  /**
   * Expiries whose sum is unknown (a series' seriesNotional read failed). With the cap on, such an expiry has
   * NO room: nothing grows in it this tick, as if it were at the cap. Never counted as the smaller known sum.
   */
  expiryNotionalUnread?: ReadonlySet<number>;
}

export const WRITE_OVERSUBSCRIBE_BPS_EXACT = 10_000;

/** `delta` / `gamma`: the planner's P14 greek gate refused a side (risk.gateGreeks), recorded on the sizes it planned. */
export type SizeCap = 'series-units' | 'total-notional' | 'usdg' | 'collateral' | 'outflow' | 'expiry-notional' | 'delta' | 'gamma';

export interface SeriesSizes {
  longId: bigint;
  bid: bigint;
  write: bigint;
  resale: bigint;
  /** Worst-case exposure and notional of the planned final state. */
  exposure: bigint;
  notional: bigint;
  capped: SizeCap[];
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
/** A cap where 0n means "none". */
const combine = (vault: bigint, bot: bigint): bigint => (bot > 0n ? min(vault, bot) : vault);

/** MakerVault._units over a planned final state. */
export function exposureUnits(s: { longs: bigint; resale: bigint; shorts: bigint; bid: bigint; write: bigint; resaleOrder: bigint }): bigint {
  const totalLongs = s.longs + s.resale;
  const up = totalLongs + s.bid - s.shorts;
  const down = s.shorts + s.write - (totalLongs - s.resaleOrder);
  return max(max(up, down), 0n);
}

export const notionalOf = (units: bigint, strike: bigint): bigint => (units * strike) / UNITS_PER_SHARE;

/** Sizes for every series, in the given (priority) order. */
export function planSizes(series: readonly SizeSeries[], limits: SizeLimits): SeriesSizes[] {
  const seriesCap = combine(limits.vaultMaxSeriesUnits, limits.botMaxSeriesUnits);
  const totalCap = combine(limits.vaultMaxTotalNotional, limits.botMaxTotalNotional);
  let running = limits.totalNotional;
  const expiryCap = limits.maxExpiryNotional ?? 0n;
  const runningByExpiry = new Map<number, bigint>(limits.expiryNotional ?? []);
  let usdgLeft = limits.usdgBudget;
  let outflowLeft = max(limits.outflowBudget, 0n);
  // Two views of the same pool: `collateralLeft` is the SIZING budget, oversubscribed by
  // MM_WRITE_OVERSUBSCRIBE_BPS and run down by every ask planned on the asset; `freeActual` is what the chain
  // holds, the bound every SINGLE ask must fit so that any one fill is covered. At 10_000 bps they coincide.
  const oversubscribe = BigInt(limits.writeOversubscribeBps ?? WRITE_OVERSUBSCRIBE_BPS_EXACT);
  const collateralLeft = new Map<string, bigint>();
  const freeActual = new Map<string, bigint>();
  for (const [asset, free] of limits.freeCollateral) {
    collateralLeft.set(asset.toLowerCase(), (free * oversubscribe) / BigInt(WRITE_OVERSUBSCRIBE_BPS_EXACT));
    freeActual.set(asset.toLowerCase(), free);
  }

  const out: SeriesSizes[] = [];
  for (const s of series) {
    const capped = new Set<SizeCap>();
    const totalLongs = s.longs + s.resale;
    const others = running - s.seriesNotional;

    // The series cap, tightened by what the total notional still allows at this strike.
    const room = totalCap > others ? totalCap - others : 0n;
    const byNotional = s.strike > 0n ? (room * UNITS_PER_SHARE) / s.strike : 0n;
    // P13: and by what this expiry's notional still allows. Without the stored sum the series' own stored notional is
    // the floor of the expiry's, so the cap still binds on what is known.
    const expiryOthers = (runningByExpiry.get(s.expiry) ?? s.seriesNotional) - s.seriesNotional;
    const expiryUnread = limits.expiryNotionalUnread?.has(s.expiry) === true;
    const expiryRoom = !expiryUnread && expiryCap > expiryOthers ? expiryCap - expiryOthers : 0n;
    const byExpiry = expiryCap > 0n ? (s.strike > 0n ? (expiryRoom * UNITS_PER_SHARE) / s.strike : 0n) : null;
    let cap = min(seriesCap, byNotional);
    let binding: SizeCap = byNotional < seriesCap ? 'total-notional' : 'series-units';
    if (byExpiry !== null && byExpiry < cap) {
      cap = byExpiry;
      binding = 'expiry-notional';
    }

    // Ask side: inventory first, writes for the rest; down = shorts + write + resale − totalLongs <= cap.
    let resale = 0n;
    let write = 0n;
    if (s.askPrice !== null && limits.askUnits > 0n) {
      resale = min(limits.askUnits, totalLongs);
      write = s.writeAllowed ? limits.askUnits - resale : 0n;
      const downRoom = max(cap + totalLongs - s.shorts, 0n);
      if (write + resale > downRoom) {
        capped.add(binding);
        const over = write + resale - downRoom;
        const cutWrite = min(write, over);
        write -= cutWrite;
        resale -= over - cutWrite;
      }
      const asset = s.collateralAsset.toLowerCase();
      const left = collateralLeft.get(asset) ?? 0n;
      const remaining = remainingLife(s.expiry, limits.now);
      if (write > 0n && s.collateralPerUnit > 0n) {
        // Collateral PLUS rent, the book's own budget: the exact inverse for one fill of the whole ask -- against
        // the pool's remaining SIZING budget, and never above what the chain would cover for this ONE fill.
        const single = maxWriteUnits(freeActual.get(asset) ?? 0n, s.collateralPerUnit, s.mintFeePpm, remaining);
        const affordable = min(maxWriteUnits(left, s.collateralPerUnit, s.mintFeePpm, remaining), single);
        if (affordable < write) {
          write = affordable;
          capped.add('collateral');
        }
        // The chain rounds the rent once per fill, so the next ask on this asset starts from what is truly left.
        collateralLeft.set(asset, left - collateralNeeded(write, s.collateralPerUnit, s.mintFeePpm, remaining));
      } else if (write > 0n) {
        write = 0n;
        capped.add('collateral');
      }
    }

    // Bid side: up = totalLongs + bid − shorts <= cap; escrow price × units / 100 from the USDG budget.
    let bid = 0n;
    if (s.bidPrice !== null && s.bidPrice > 0n && limits.bidUnits > 0n) {
      bid = limits.bidUnits;
      const upRoom = max(cap + s.shorts - totalLongs, 0n);
      if (bid > upRoom) {
        bid = upRoom;
        capped.add(binding);
      }
      const affordable = (usdgLeft * UNITS_PER_SHARE) / s.bidPrice;
      if (affordable < bid) {
        bid = affordable;
        capped.add('usdg');
      }
      // The vault's daily outflow cap: a bid is charged its whole escrow AT PLACEMENT, because anyone can fill it
      // between vault calls. Sized inside the budget, so the cap trims the quote instead of reverting the place.
      const withinOutflow = (outflowLeft * UNITS_PER_SHARE) / s.bidPrice;
      if (withinOutflow < bid) {
        bid = withinOutflow;
        capped.add('outflow');
      }
      const escrow = (s.bidPrice * bid) / UNITS_PER_SHARE;
      usdgLeft -= escrow;
      outflowLeft -= escrow;
    }

    const exposure = exposureUnits({ longs: s.longs, resale: s.resale, shorts: s.shorts, bid, write, resaleOrder: resale });
    const notional = notionalOf(exposure, s.strike);
    running = others + notional;
    runningByExpiry.set(s.expiry, expiryOthers + notional);
    out.push({ longId: s.longId, bid, write, resale, exposure, notional, capped: [...capped] });
  }
  return out;
}

/*//////////////////////////////////////////////////////////////
                    GREEK GATE (P14)
//////////////////////////////////////////////////////////////*/

export interface GreekLimits {
  /** MM_MAX_DELTA_SHARES; 0 = no delta limit (explicit opt-out). */
  maxDeltaShares: number;
  /** MM_MAX_GAMMA; 0 = no gamma limit (explicit opt-out). */
  maxGamma: number;
}

/** The reachable range of one market's net greek this tick: `lo` if every allowed sale fills, `hi` if every purchase does. */
export interface GreekRange {
  lo: number;
  hi: number;
}

export interface MarketGreeks {
  delta: GreekRange;
  gamma: GreekRange;
  /**
   * A held position of this market whose delta (gamma) could not be priced. Its contribution is unknown, not
   * 0, so while the limit is on {gateGreeks} opens no side in the market: the net it would be measured against is unknown.
   */
  deltaUnknown?: boolean;
  gammaUnknown?: boolean;
}

/** The starting range of each market: its inventory's net delta and gamma (lower-case underlying keys). */
export function marketGreeksOf(positions: ReadonlyArray<{ underlying: string; units: bigint; delta: number | null; gamma: number | null }>): Map<string, MarketGreeks> {
  const out = new Map<string, MarketGreeks>();
  for (const p of positions) {
    if (p.units === 0n) continue;
    const key = p.underlying.toLowerCase();
    const row: MarketGreeks = out.get(key) ?? { delta: { lo: 0, hi: 0 }, gamma: { lo: 0, hi: 0 } };
    const shares = Number(p.units) / Number(UNITS_PER_SHARE);
    // An unknown greek adds 0 to the range and marks the market unknown: gateGreeks then opens no side in it,
    // as it already refuses a side on a series whose OWN greek is unknown.
    if (p.delta !== null && Number.isFinite(p.delta)) {
      row.delta.lo += shares * p.delta;
      row.delta.hi += shares * p.delta;
    } else row.deltaUnknown = true;
    if (p.gamma !== null && Number.isFinite(p.gamma)) {
      row.gamma.lo += shares * p.gamma;
      row.gamma.hi += shares * p.gamma;
    } else row.gammaUnknown = true;
    out.set(key, row);
  }
  return out;
}

/**
 * Whether moving `range` by `change` breaches `limit`: the bound it moves ends past the limit AND further from zero than
 * it was. A change towards zero is never a breach -- this is what makes the gate stop only the side that increases
 * exposure. limit <= 0 = no limit.
 */
export function greekBreach(range: GreekRange, change: number, limit: number): boolean {
  if (!(limit > 0) || change === 0) return false;
  const from = change < 0 ? range.lo : range.hi;
  const to = from + change;
  return Math.abs(to) > limit && Math.abs(to) > Math.abs(from);
}

function widen(range: GreekRange, change: number): void {
  if (change < 0) range.lo += change;
  else range.hi += change;
}

/**
 * P14 for one series: may its bid and its ask side be quoted, given the market's range so far. Allowed sides widen the
 * range (mutated). A side is refused when its own greek is unknown and the limit is on: fail closed, never guessed.
 *   bid (a purchase of `bidUnits`)  delta +units/100 × delta, gamma +units/100 × gamma
 *   ask (a sale of `askUnits`)      delta −units/100 × delta, gamma −units/100 × gamma
 * Units are the WORST case the side could fill this tick (the configured side size, before any other cap).
 */
export function gateGreeks(input: {
  market: MarketGreeks;
  delta: number | null;
  gamma: number | null;
  bidUnits: bigint;
  askUnits: bigint;
  limits: GreekLimits;
}): { bid: boolean; ask: boolean; reasons: string[] } {
  const { market, limits } = input;
  const reasons: string[] = [];
  const side = (name: 'bid' | 'ask', units: bigint, sign: 1 | -1): boolean => {
    if (units <= 0n) return true;
    const shares = (Number(units) / Number(UNITS_PER_SHARE)) * sign;
    const dKnown = input.delta !== null && Number.isFinite(input.delta);
    const gKnown = input.gamma !== null && Number.isFinite(input.gamma);
    if (limits.maxDeltaShares > 0 && !dKnown) {
      reasons.push(`${name}: series delta unknown`);
      return false;
    }
    if (limits.maxGamma > 0 && !gKnown) {
      reasons.push(`${name}: series gamma unknown`);
      return false;
    }
    // A held position of the market could not be priced, so the net this side moves is unknown.
    if (limits.maxDeltaShares > 0 && market.deltaUnknown === true) {
      reasons.push(`${name}: market net delta unknown (a held series has no delta)`);
      return false;
    }
    if (limits.maxGamma > 0 && market.gammaUnknown === true) {
      reasons.push(`${name}: market net gamma unknown (a held series has no gamma)`);
      return false;
    }
    const dChange = dKnown ? shares * input.delta! : 0;
    const gChange = gKnown ? shares * input.gamma! : 0;
    if (greekBreach(market.delta, dChange, limits.maxDeltaShares)) {
      reasons.push(`${name}: net delta ${(dChange < 0 ? market.delta.lo : market.delta.hi).toFixed(2)} -> ${((dChange < 0 ? market.delta.lo : market.delta.hi) + dChange).toFixed(2)} shares past ${limits.maxDeltaShares}`);
      return false;
    }
    if (greekBreach(market.gamma, gChange, limits.maxGamma)) {
      reasons.push(`${name}: net gamma ${(gChange < 0 ? market.gamma.lo : market.gamma.hi).toFixed(4)} -> ${((gChange < 0 ? market.gamma.lo : market.gamma.hi) + gChange).toFixed(4)} past ${limits.maxGamma}`);
      return false;
    }
    widen(market.delta, dChange);
    widen(market.gamma, gChange);
    return true;
  };
  const bid = side('bid', input.bidUnits, 1);
  const ask = side('ask', input.askUnits, -1);
  return { bid, ask, reasons };
}
