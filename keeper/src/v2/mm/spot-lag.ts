/**
 * THE SPOT-LAG FLOOR: no ask below the option's value at the spot the market can already be at before the oracle
 * prints, and no bid above its value at the spot the market can already have fallen to (for a put, risen to). Pure; the
 * planner calls it. It closes the spot-lag gap.
 *
 * WHY. The series oracle's source 0 is a push feed that prints on a 0.5 % move (ChainlinkFeedSource.sol:17). Between
 * prints the market can be up to that far from the print the whole book is priced at, and a taker who watches the market
 * sees the move before the oracle does. At the worked NVDA example (229.03, the 232.50 call, four session hours, 45 %
 * vol, delta 0.253) half a percent of spot is 1.145 USDG of spot and 0.29 USDG of premium: 38 % of the call's fair
 * value and more than its whole half spread. (An earlier estimate put it at 0.07; that was an arithmetic slip.) Past
 * SPOT_CORROBORATION_AGE_S the oracle accepts the print only because its pool agrees within maxDeviationBps, so the
 * band widens to that. maxDeviationBps is per market and settable (SettlementOracle.setMarket, CONFIG_ADMIN; default
 * 150, ceiling 1 000), so it is read live every tick (reads.readSeriesViews) and MM_SPOT_LAG_STALE_BPS is only
 * the floor under it. The spot-age halt does not close this gap: it accepts an observation the pool corroborates
 * within MM_FAIR_SPOT_TOLERANCE_BPS, and the ask is still priced at the oracle's print.
 *
 * THE SAME LAG RUNS THE OTHER WAY FOR A BID. The market falls, the print has not moved,
 * and a call bid at fair − halfSpread − skew is a bid at the pre-fall fair. The default half spread (5 % of fair) is far
 * under the band's worth (38 % of fair above), so the spread does not cover it; widening the spread for every quote to
 * cover a lag-only risk is the fix this is instead of.
 *
 * THE FLOOR, per whole share in USDG base units:
 *   S_ref   = max(oracle spot, /fair's spot) for a call, the min for a put: the worse of the two spots for a SELLER
 *   u       = MM_SPOT_LAG_BPS while the print is at most SPOT_CORROBORATION_AGE_S old; past it (and when its time is
 *             unknown) max(MM_SPOT_LAG_STALE_BPS, the series oracle's live marketConfig maxDeviationBps), the env alone
 *             when that read failed
 *   S_q     = S_ref × (1 + u) for a call, rounded up; S_ref × (1 − u) for a put, rounded down
 *   lagFair = ⌈BS(S_q, K, iv, T)⌉ at /fair's own vol, on the pricing service's trading clock (pricing/bs.ts)
 * The planner quotes the series a second time with lagFair as its fair (engine.quotePrices, so every engine rule, the
 * spread, the widening, the skew, the seller-fee gross-up and whatever shapes the ask, applies to it as to the fair) and
 * keeps the HIGHER ask and resale ask. lagFair, to the tick and grossed for each slot's own seller fee, is also the price
 * no ask of the series may be quoted or left resting under (engine.judgeReplace). It only ever raises an ask.
 *
 * THE BID CAP, its mirror, from the same band:
 *   B_ref      = min(oracle spot, /fair's spot) for a call, the max for a put: the worse of the two spots for a BUYER
 *   B_q        = B_ref × (1 − u) for a call, rounded down; B_ref × (1 + u) for a put, rounded up
 *   bidLagFair = ⌊BS(B_q, K, iv, T)⌋
 *   cap        = bidLagFair rounded DOWN to the tick; a bid carries no fee term (engine.ts header, BIDS CARRY NO FEE TERM)
 * The cap is also the price no bid of the series may be left resting over, whatever MM_REQUOTE_BPS says
 * (engine.judgeReplace): that one is priced NOW.
 *
 * THE BID IS QUOTED AT THE CAP IT WILL HAVE AHEAD, not the cap now. T is the time left, so the cap falls
 * by theta every second at an unchanged spot, and a bid quoted exactly at today's cap is over it one read later:
 * measured 107 of 166 confirmed transactions as "bid above the spot-lag cap" replaces chasing it down by a tick or two
 * (597200 -> 597000 -> 596800 on consecutive 15 s ticks), while half the series never got an ask for want of budget. So
 * the bid is priced with T at `bidAt`, the planner's TWO ROUTINE SENDS ahead (TickInput.bidCapAheadS, 2 x
 * (MM_SEND_INTERVAL_S + one read) from the quoter) and never past the validUntil a new bid gets:
 *   capAhead   = min(cap, ⌊BS(B_q, K, iv, T(bidAt))⌋ rounded DOWN to the tick)
 * and bid = min(fair's bid, capAhead). With no rate term (pricing/bs.ts) the value only falls as T shrinks, so at an
 * unchanged spot a bid placed this way stays at or under the current cap through the next routine send and the one
 * after; at the P11 env (60 s sends, 15 s reads, 180 s quote life) that is past the send that refreshes it, so theta
 * alone never replaces a bid. A replace keeps the order's own validUntil, so its cap there is never under capAhead.
 * The invariant is unchanged: a resting bid over the CURRENT cap (floor.bid) is still replaced at once. The price of
 * this is at most two routine sends of theta off the bid. The cap is never given a tolerance above its current value;
 * the bid is lowered instead.
 *
 * THE SPOT CUSHION. capAhead covers theta, not a move: a bid priced exactly at it is over the cap on the first
 * /fair downtick, and in a moving market that replaced most bids on every read (measured on a fork: 36-40 of 47 series with
 * an ask, ~95 tx/min, the replaces eating the budget new asks needed). So capAhead is priced at a spot moved one more
 * sigma against the buyer over the same horizon:
 *   cushion    = ⌈iv × √(trading years from now to bidAt)⌉ bps, iv /fair's own vol (0 when bidAt is now or off-session)
 *   capAhead   = min(cap, ⌊BS(B_q × (1 − cushion), K, iv, T(bidAt))⌋ rounded DOWN to the tick)   (a put: × (1 + cushion))
 * At 45-50 % vol and the P11 horizon (150 session seconds) that is 23-25 bps. The cap itself (floor.bid, the price no
 * resting bid may exceed) does not move: the cap is not loosened, the quoted bid is lowered, by about one sigma of spot
 * times the option's delta. A move past one sigma inside the horizon still crosses the cap and is replaced at once.
 *
 * THE ASK CUSHION, the spot cushion's mirror. An ask priced at its floors is under them on the first uptick:
 * a rising /fair spot lifts S_ref and so lagFair on every read, and each oracle print lifts the vault's own ask floor
 * (MakerVault._askFloor: the intrinsic value at the print plus a time-value term), and the resting ask is replaced at
 * once (engine.judgeReplace). We measured it in the cadence loop, a 6 bps/read rise: 187 such replaces in
 * 20 min, 130 of them the vault's floor. So each ask is also held at both floors where the same one-sigma move over
 * the same horizon can put them:
 *   lagFairAhead = max(lagFair, ⌈BS(S_q × (1 + cushion), K, iv, T)⌉)   (a put: × (1 − cushion))
 *   vaultAhead   = the read vault floor + the gross-up of the rise of MakerVault._askFloor's base from the print to the
 *                  worse of hi = max(oracle spot, /fair's spot) × (1 + cushion) and lo = the min × (1 − cushion)
 *   askAhead     = per slot, the higher of lagFairAhead grossed for its seller fee and vaultAhead
 * T is now, not bidAt: the value only falls with T, so a floor is highest at the start of the horizon and the time
 * term runs for the seller. The vault's base is convex in spot (a call's (S(1 − tol) − K)⁺ or a put's (K − S(1 + tol))⁺,
 * plus the linear MIN_ASK_BPS_OF_SPOT term), so its highest value on [lo, hi] is at an end. Only its RISE is mirrored,
 * added to the floor the vault answered, so a formula or constant that differs from the deployed one moves the
 * cushion, never the floor. The floors themselves (floor.write, floor.resale, the vault's read floor, askToleranceBps)
 * do not move: the ask is raised, by about one sigma of spot times delta for a priced ask and one sigma of the floor
 * for an ask at the vault's floor. A move past one sigma inside the horizon still crosses a floor and is replaced at
 * once. With no horizon the cushion is 0, lagFairAhead is lagFair and vaultAhead is the read floor moved to /fair's
 * spot when that is the worse one.
 *
 * The bid is the lower of the fair's bid and capAhead, and none when that is under a tick. It only ever lowers a bid,
 * so it cannot cross an ask that only rose. The cap is the value at the stressed spot itself, not a spread under
 * it: the ask's floor is the same (lagFair with no spread), and the bid is not also quoted at a spread under bidLagFair
 * (the ask's `lagged` quote has no bid twin; that would need a third quotePrices call in the planner).
 * MM_SPOT_LAG_BPS = MM_SPOT_LAG_STALE_BPS = 0 turns both off (the live oracle band does not turn them back on).
 *
 * TWO CLOCKS FOR ONE QUESTION, side by side. "How well is spot known now" is answered twice:
 *
 *   guard                  clock                                         band it trusts
 *   P7 spot-age (engine    the FRESHEST CORROBORATED observation         any source within MM_FAIR_SPOT_TOLERANCE_BPS
 *   marketSafetyHalt)      (reads.readSpotClocks): the print, or a later  of the print refreshes the clock
 *                          pool reading that agrees with it
 *   this floor and cap     the PRINT's own time (trySpot updatedAt)      MM_SPOT_LAG_BPS up to 30 min, then
 *                                                                         max(MM_SPOT_LAG_STALE_BPS, live
 *                                                                         maxDeviationBps)
 *
 * So a print P7 lets through only because the pool agrees within the tolerance is priced here at MM_SPOT_LAG_BPS. That
 * is sound only while MM_SPOT_LAG_BPS ≥ MM_FAIR_SPOT_TOLERANCE_BPS: the band then covers every gap P7 accepts. The
 * shipped env (ops/v2/env/mm-bot.env) holds it at 50 ≥ 50 and spot-lag.test.ts pins that on the rendered file. The
 * keeper's own defaults do NOT (50 < 300, config.ts); a bot run without the rendered env is outside the pin. The clocks
 * are not merged: this floor ages the print because the feed's 0.5 % deviation rule is what bounds the market's
 * distance from the PRINT, which a pool reading does not refresh.
 */
import { NYSE_HOLIDAYS_2026_2028 } from '../../calendar.js';
import { bsPrice, tradingYears } from '../pricing/bs.js';
import { BPS, MIN_ASK_BPS_OF_SPOT, PRICE_TICK, SPOT_CORROBORATION_AGE_S } from './constants.js';
import { grossUpToTick, quoteFeeBpsOf, roundDownToTick, roundUpToTick, type AskFloors, type FairInput, type QuoteFees, type QuotePrices, type SeriesInfo } from './engine.js';

/** MM_SPOT_LAG_BPS and MM_SPOT_LAG_STALE_BPS (config.ts); both 0 = off. */
export interface SpotLagParams {
  spotLagBps: number;
  spotLagStaleBps: number;
}

/** The floor and the cap of one series and how they got there, for /state. Prices are USDG base units per share. */
export interface SpotLagQuote {
  /** The worse of the oracle's spot and /fair's for the seller; S_q; the band between them in bps. */
  spotRef: bigint;
  spotQ: bigint;
  bandBps: number;
  /** ⌈BS(S_q, K, iv, T)⌉: the fair value at the stressed spot, NET. */
  lagFair: bigint;
  /** The bid's mirror: the worse of the two spots for the buyer; B_q, stressed the other way by the same band. */
  bidSpotRef: bigint;
  bidSpotQ: bigint;
  /** ⌊BS(B_q, K, iv, T)⌋: the fair value at the spot stressed against a bid. */
  bidLagFair: bigint;
  /**
   * The time the quoted bid is capped at (the planner's two routine sends ahead, never past the bid's validUntil;
   * `now` when none was given) and that cap, rounded down to the tick and never above floor.bid. The bid target is at most this; floor.bid, the cap NOW, is what no resting bid
   * may exceed.
   */
  bidAt: number;
  /**
   * The spot cushion under bidCapAhead, bps of B_q: ⌈iv × √(trading years from now to bidAt)⌉, one sigma of
   * spot over that horizon (0 when bidAt is now or the horizon is off-session).
   */
  bidCushionBps: number;
  bidCapAhead: bigint;
  /**
   * The ask's cushion (header, THE ASK CUSHION): the same one sigma over the same horizon, bps; the fair value
   * at S_q moved up by it (a put: down), NET, never under lagFair; and per slot the price no new ask is quoted under,
   * the higher of that grossed for the slot's seller fee and the vault's own floor at the spot the move can reach.
   */
  askCushionBps: number;
  lagFairAhead: bigint;
  askAhead: { write: bigint; resale: bigint };
  /**
   * The bound of each slot. write, resale: lagFair to the tick, grossed for that slot's own seller fee; no ask of the slot
   * rests under it. bid: bidLagFair rounded down to the tick; no bid rests over it (the planner hands this whole object to
   * engine.planSeriesActions as its `safeFloor`).
   */
  floor: { write: bigint; resale: bigint; bid: bigint };
  /** true when the floor raised the write or the resale ask above the fair's own quote this tick. */
  raised: boolean;
  /** true when the cap lowered the fair's own bid this tick, or left less than a tick of it and pulled it. */
  bidCapped: boolean;
}

export const spotLagOn = (params: SpotLagParams): boolean => params.spotLagBps > 0 || params.spotLagStaleBps > 0;

/**
 * MIRRORED from MakerVault._askFloor (callhouse-contracts src/v2/mm/MakerVault.sol:918; HouseVault.sol:1695
 * is the same): the base the vault grosses up for the seller fee, USDG base units per share, at `spot`.
 * max(0, intrinsic − ⌊spot × askToleranceBps / BPS⌋) + ⌈spot × MIN_ASK_BPS_OF_SPOT / BPS⌉.
 */
export function vaultAskBaseOf(series: Pick<SeriesInfo, 'isPut' | 'strike'>, spot: bigint, askToleranceBps: number): bigint {
  const intrinsic = series.isPut ? (series.strike > spot ? series.strike - spot : 0n) : spot > series.strike ? spot - series.strike : 0n;
  const tolerance = (spot * BigInt(askToleranceBps)) / BPS;
  return (intrinsic > tolerance ? intrinsic - tolerance : 0n) + (spot * MIN_ASK_BPS_OF_SPOT + BPS - 1n) / BPS;
}

/**
 * The spot-lag floor and cap of one series (the header's formulas), or null when its inputs are not a Black-Scholes
 * input (an unusable vol, no positive spot or strike): the caller does not quote such a series at all.
 */
export function spotLagOf(input: {
  now: number;
  series: SeriesInfo;
  fair: Extract<FairInput, { ok: true }>;
  /** The series oracle's trySpot price and the time of that print (null: unknown, priced as a stale print). */
  spot: bigint;
  spotUpdatedAt: number | null;
  /**
   * The series oracle's live marketConfig maxDeviationBps (reads.readSeriesViews), the band it accepts an old print
   * within. An old print is priced at the wider of it and MM_SPOT_LAG_STALE_BPS; null or absent = unread, the env alone.
   */
  oracleBandBps?: number | null;
  fees: QuoteFees;
  params: SpotLagParams;
  holidays?: readonly string[];
  /**
   * The time the quoted bid is capped at (planner: min(the validUntil a new bid gets, now + bidCapAheadS)). The
   * bid target is capped at the value there, which is below the cap now by the theta in between. Absent, null or not
   * after `now`: the cap now.
   */
  bidAt?: number | null;
  /**
   * The vault's ask floor per kind as it answered this read (askFloorOf, at the oracle spot) and its
   * askToleranceBps. The ask cushion holds each ask at that floor moved over the horizon's one-sigma move; absent or
   * null, the cushion covers the spot-lag floor alone.
   */
  vaultFloor?: { askFloors: AskFloors; askToleranceBps: number } | null;
}): Omit<SpotLagQuote, 'raised' | 'bidCapped'> | null {
  const { series, fair, params } = input;
  if (input.spot <= 0n || series.strike <= 0n || !Number.isFinite(fair.iv) || fair.iv < 0) return null;
  const other = fair.spot !== undefined && fair.spot > 0n ? fair.spot : input.spot;
  const high = other > input.spot ? other : input.spot;
  const low = other < input.spot ? other : input.spot;
  // A call is worth more at the higher spot, a put at the lower: that one is the seller's worse, the other the buyer's.
  const spotRef = series.isPut ? low : high;
  const bidSpotRef = series.isPut ? high : low;
  const fresh = input.spotUpdatedAt !== null && input.now - input.spotUpdatedAt <= SPOT_CORROBORATION_AGE_S;
  const live = input.oracleBandBps ?? 0;
  const bandBps = fresh ? params.spotLagBps : Math.max(params.spotLagStaleBps, Number.isInteger(live) ? live : 0);
  if (bandBps >= Number(BPS)) return null;
  const band = BigInt(bandBps);
  const upBy = (s: bigint): bigint => (s * (BPS + band) + BPS - 1n) / BPS;
  const downBy = (s: bigint): bigint => (s * (BPS - band)) / BPS;
  // Against the vault, each rounded the same way: an ask at the spot the option is worth more at, a bid at the one it
  // is worth less at.
  const spotQ = series.isPut ? downBy(spotRef) : upBy(spotRef);
  const bidSpotQ = series.isPut ? upBy(bidSpotRef) : downBy(bidSpotRef);
  const priceAt = (spot: bigint, at: number = input.now): number | null => {
    try {
      const price = bsPrice({
        type: series.isPut ? 'put' : 'call',
        spot: Number(spot) / 1e6,
        strike: Number(series.strike) / 1e6,
        vol: fair.iv,
        t: tradingYears(at, series.expiry, input.holidays ?? NYSE_HOLIDAYS_2026_2028),
      });
      return Number.isFinite(price) && price >= 0 ? price : null;
    } catch {
      return null;
    }
  };
  const askPrice = priceAt(spotQ);
  const bidPrice = priceAt(bidSpotQ);
  if (askPrice === null || bidPrice === null) return null;
  const lagFair = BigInt(Math.ceil(askPrice * 1e6));
  const bidLagFair = BigInt(Math.floor(bidPrice * 1e6));
  const net = roundUpToTick(lagFair);
  const bidCap = roundDownToTick(bidLagFair);
  // The value only falls as T shrinks (no rate term); the min() keeps "never above the cap now" true by construction.
  const bidAt = input.bidAt != null && input.bidAt > input.now ? Math.min(input.bidAt, series.expiry) : input.now;
  // The spot cushion, one sigma of spot over the same horizon at /fair's own vol (header, THE SPOT CUSHION).
  const horizon = bidAt === input.now ? 0 : tradingYears(input.now, bidAt, input.holidays ?? NYSE_HOLIDAYS_2026_2028);
  const bidCushionBps = Math.min(Number(BPS) - 1, Math.ceil(fair.iv * Math.sqrt(horizon) * Number(BPS)));
  const cushion = BigInt(bidCushionBps);
  const bidSpotAhead = series.isPut ? (bidSpotQ * (BPS + cushion) + BPS - 1n) / BPS : (bidSpotQ * (BPS - cushion)) / BPS;
  const aheadPrice = bidAt === input.now ? bidPrice : priceAt(bidSpotAhead, bidAt);
  if (aheadPrice === null) return null;
  const ahead = roundDownToTick(BigInt(Math.floor(aheadPrice * 1e6)));
  // The ask's mirror (header, THE ASK CUSHION): the same sigma, the move against the seller, priced at now.
  const askSpotAhead = series.isPut ? (spotQ * (BPS - cushion)) / BPS : (spotQ * (BPS + cushion) + BPS - 1n) / BPS;
  const askAheadPrice = cushion === 0n ? askPrice : priceAt(askSpotAhead);
  if (askAheadPrice === null) return null;
  const aheadFair = BigInt(Math.ceil(askAheadPrice * 1e6));
  const lagFairAhead = aheadFair > lagFair ? aheadFair : lagFair;
  const netAhead = roundUpToTick(lagFairAhead);
  // The vault's floor where the print can be by the end of the horizon: only the rise of its base is mirrored.
  const vf = input.vaultFloor;
  let vaultRise = 0n;
  if (vf != null) {
    const hi = (high * (BPS + cushion) + BPS - 1n) / BPS;
    const lo = (low * (BPS - cushion)) / BPS;
    const at = vaultAskBaseOf(series, input.spot, vf.askToleranceBps);
    for (const s of [hi, lo]) {
      const rise = vaultAskBaseOf(series, s, vf.askToleranceBps) - at;
      if (rise > vaultRise) vaultRise = rise;
    }
  }
  const askAheadOf = (kind: 'AskWrite' | 'AskResale', read: bigint | undefined): bigint => {
    const fee = quoteFeeBpsOf(kind, input.fees);
    const priced = grossUpToTick(netAhead, fee).price;
    if (read === undefined) return priced;
    const vault = roundUpToTick(read + (vaultRise === 0n ? 0n : grossUpToTick(vaultRise, fee).price));
    return vault > priced ? vault : priced;
  };
  return {
    spotRef,
    spotQ,
    bandBps,
    lagFair,
    bidSpotRef,
    bidSpotQ,
    bidLagFair,
    bidAt,
    bidCushionBps,
    bidCapAhead: ahead < bidCap ? ahead : bidCap,
    askCushionBps: bidCushionBps,
    lagFairAhead,
    askAhead: { write: askAheadOf('AskWrite', vf?.askFloors.write), resale: askAheadOf('AskResale', vf?.askFloors.resale) },
    floor: {
      write: grossUpToTick(net, quoteFeeBpsOf('AskWrite', input.fees)).price,
      resale: grossUpToTick(net, quoteFeeBpsOf('AskResale', input.fees)).price,
      bid: bidCap,
    },
  };
}

/**
 * The fair's quote with the floor and the cap applied: each ask the highest of the fair's, the lag fair's (`lagged`,
 * the same engine.quotePrices at lagFair), the slot's floor and its ask cushion (askAhead); the bid the lower
 * of the fair's and the cap at the bid's
 * validUntil (bidCapAhead), and none when that leaves less than a tick. Asks only rise and the bid only falls,
 * so the bid cannot cross them (quotePrices already keeps it under the fair's ask and resale). A fee read the gross-up
 * refused is carried through.
 */
export function withSpotLag(prices: QuotePrices, lagged: QuotePrices, lag: Omit<SpotLagQuote, 'raised' | 'bidCapped'>): { prices: QuotePrices; lag: SpotLagQuote } {
  const most = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b > a ? b : a));
  // And at least the ask cushion's price (askAhead), so an ordinary uptick does not put it under a floor.
  const ask = most(prices.ask, lagged.ask, lag.floor.write, lag.askAhead.write);
  const resale = most(prices.resale, lagged.resale, lag.floor.resale, lag.askAhead.resale);
  // spotLagOf already holds bidCapAhead at or under floor.bid; the min() keeps it so for any caller's quote.
  const cap = lag.bidCapAhead < lag.floor.bid ? lag.bidCapAhead : lag.floor.bid;
  const bidCapped = prices.bid !== null && prices.bid > cap;
  const bid = !bidCapped ? prices.bid : cap >= PRICE_TICK ? cap : null;
  const clampedBy = [...new Set([...prices.clampedBy, ...lagged.clampedBy.filter((c) => c === 'fee-out-of-range')])];
  return {
    prices: { ...prices, bid, ask, resale, clampedBy },
    lag: { ...lag, raised: ask > prices.ask || resale > prices.resale, bidCapped },
  };
}
