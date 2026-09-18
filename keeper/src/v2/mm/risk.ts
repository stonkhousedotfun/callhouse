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
 *     CLEARINGHOUSE'S RENT on that collateral (INTERFACE_VERSION 7, c05) of the series' collateral asset
 *     (the Stock Token for calls, USDG for puts) against `free(vault, asset)`, shared by every write ask on
 *     that asset (a write ask the ledger cannot cover is skipped by takers' fills, so quoting it would only
 *     advertise depth that is not there);
 *   - AskResale escrows the vault's own longs, so it sells at most what the vault holds.
 * The ask side is MM_ASK_UNITS in total: inventory first (resale), then writes for the rest.
 *
 * RENT (INTERFACE_VERSION 7, c05). `OrderBook._reserveCollateral` budgets
 * `units × cpu + ceil(units × cpu × mintFeePpm × (expiry − now) / (1e6 × 7 days))`, so `free / cpu` now
 * over-advertises a write ask by the rent. Sizes come from mintFee.maxWriteUnits, the exact inverse of that
 * predicate for ONE fill of the whole order (what `quoteTake` answers), and each series subtracts its own exact
 * need from the shared per-asset budget — the chain rounds once per fill, so a second ask on the same asset must
 * not reuse the rent the first one will pay.
 *
 * THE OUTFLOW CAP (INTERFACE_VERSION 7, c21). `MakerVault` charges the net USDG a quoter call moves out against a
 * leaky bucket (`limits.maxDailyOutflow` per OUTFLOW_WINDOW) and reverts `OutflowCapExceeded` above it. Placing or
 * replacing a Bid is booked and enforced; a cancel credits its escrow back. `SizeLimits.outflowBudget` is what a
 * tick may still escrow in new bids after the credits its own cancels and replaces hand back — the caller computes
 * `cap − max(0, used − releasedEscrow)` — and bids are sized inside it, so the cap trims quotes instead of
 * reverting a send.
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
  /** USDG in the vault's wallet plus the escrow of its live bids. */
  usdgBudget: bigint;
  /**
   * USDG base units of NEW bid escrow this tick may create before `MakerVault` reverts `OutflowCapExceeded`:
   * `maxDailyOutflow − max(0, outflow().used − the escrow this tick's cancels and replaces give back)`.
   */
  outflowBudget: bigint;
  /** Clearinghouse.free(vault, asset) per lower-case asset. */
  freeCollateral: ReadonlyMap<string, bigint>;
  bidUnits: bigint;
  askUnits: bigint;
}

export type SizeCap = 'series-units' | 'total-notional' | 'usdg' | 'collateral' | 'outflow';

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
  let usdgLeft = limits.usdgBudget;
  let outflowLeft = max(limits.outflowBudget, 0n);
  const collateralLeft = new Map<string, bigint>();
  for (const [asset, free] of limits.freeCollateral) collateralLeft.set(asset.toLowerCase(), free);

  const out: SeriesSizes[] = [];
  for (const s of series) {
    const capped = new Set<SizeCap>();
    const totalLongs = s.longs + s.resale;
    const others = running - s.seriesNotional;

    // The series cap, tightened by what the total notional still allows at this strike.
    const room = totalCap > others ? totalCap - others : 0n;
    const byNotional = s.strike > 0n ? (room * UNITS_PER_SHARE) / s.strike : 0n;
    const cap = min(seriesCap, byNotional);
    const binding: SizeCap = byNotional < seriesCap ? 'total-notional' : 'series-units';

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
        // Collateral PLUS rent, the book's own budget: the exact inverse for one fill of the whole ask.
        const affordable = maxWriteUnits(left, s.collateralPerUnit, s.mintFeePpm, remaining);
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
    out.push({ longId: s.longId, bid, write, resale, exposure, notional, capped: [...capped] });
  }
  return out;
}
