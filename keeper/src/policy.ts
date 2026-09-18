/**
 * The strike, the size and the price, mirroring contracts/src/Policy.sol and the fill gate in
 * contracts/src/lib/ValoremLib.sol in the same integer arithmetic. The vault re-checks all of it
 * on chain — at the arm, at the approval and at EVERY FILL — and reverts if the keeper's answer
 * differs, so getting the rounding right here is the difference between a filled week and a
 * `PremiumBelowFloorAtFill` on Friday.
 *
 * Nothing is hardcoded. The band, the utilisation, the cap and the premium floor are all read
 * from `vault.policy()` so an admin policy change takes effect without a keeper deploy.
 *
 * UNITS, stated once:
 *   spotUsdg6    spot price of ONE lot (1e18 of the asset) in USDG base units (6 dp).
 *   strikeUsdg6  the option type's exerciseAmount, same units, a whole USDG for our own types.
 *   contracts    whole lots. One lot = 1e18 asset base units, compiled into Policy.sol.
 *   unitPrice6   the ask for ONE contract, USDG base units. Gross == net: one consideration item.
 *
 * TWO PRICING MODES (KEEPER_PRICING_MODE). `fixed` is the launch rule: strike = spot +
 * KEEPER_STRIKE_OTM_BPS, ask = fill floor + margin. `vol` (the default) takes the strike at a
 * target delta and the ask at the market's fair value plus an edge, from a pre-fetched delayed
 * option chain (vol.ts), and keeps every vault gate exactly as `fixed` does: the ask is never
 * below the fill floor with the margin and never above the strike, and the strike is clamped
 * into the band. Both are pure and synchronous; roll.ts does the fetch.
 */
import { vaultAbi } from './abi.js';
import { publicClient } from './clients.js';
import { BPS, ONE_LOT, USDG_ONE, config, vaultAddress } from './config.js';
import { log } from './logger.js';
import { targetStrike6 } from './optionType.js';
import {
  VOL_SOURCE,
  checkQuoteWindow,
  checkVolMarket,
  fairCallPrice,
  strikeForDelta,
  type DeltaStrike,
  type FairPrice,
  type VolContext,
  type VolMarket,
  type VolSettings,
} from './vol.js';

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

export interface PolicyParams {
  minOtmBps: bigint;
  maxOtmBps: bigint;
  minPremiumBps: bigint;
  maxUtilizationBps: bigint;
  protocolFeeBps: bigint;
  maxContractsCap: bigint;
}

/** The vault's own per-cycle listing cap (Policy.MAX_LISTINGS_PER_CYCLE), mirrored so the keeper
 *  stops before a `TooManyListings` revert. Every approveListing spends one, cancelled or not. */
export const MAX_LISTINGS_PER_CYCLE = 3;

/** vol mode: how far under the band CEILING (bps of spot) a clamped strike sits. The ceiling is
 *  only checked at the arm, but the arm is two transactions (the option type, then rollOpen) and a
 *  weekday spot keeps printing between the plan and the inclusion; a strike on the very edge
 *  reverts StrikeAboveBand on a drop of a few bps, after the option type already exists. */
export const BAND_CEILING_BUFFER_BPS = 50n;

/** vol mode, at the arm: the most an unclamped strike's delta (Cboe's, interpolated at the whole-USDG
 *  strike) may differ from KEEPER_TARGET_DELTA. The rounding to a whole USDG moves it by a few
 *  hundredths at most on a one-day expiry; more means the chain's deltas and strikes disagree. */
export const DELTA_AT_STRIKE_TOLERANCE = 0.05;

/*//////////////////////////////////////////////////////////////
                           CHAIN READS
//////////////////////////////////////////////////////////////*/

/** The last policy() payload seen, serialised, so an admin `setPolicy` logs exactly once on
 *  the next poll instead of on every tick. `undefined` until the first read after boot. */
let lastPolicyJson: string | undefined;

export async function readPolicy(): Promise<PolicyParams> {
  const [minOtmBps, maxOtmBps, minPremiumBps, maxUtilizationBps, protocolFeeBps, maxContractsCap] =
    await publicClient.readContract({
      address: vaultAddress(),
      abi: vaultAbi,
      functionName: 'policy',
    });
  const fields = {
    minOtmBps: BigInt(minOtmBps).toString(),
    maxOtmBps: BigInt(maxOtmBps).toString(),
    minPremiumBps: BigInt(minPremiumBps).toString(),
    maxUtilizationBps: BigInt(maxUtilizationBps).toString(),
    protocolFeeBps: BigInt(protocolFeeBps).toString(),
    maxContractsCap: BigInt(maxContractsCap).toString(),
  };
  const json = JSON.stringify(fields);
  if (json !== lastPolicyJson) {
    log.policy.info(fields, 'policy parameters updated');
    lastPolicyJson = json;
  }
  return {
    minOtmBps: BigInt(minOtmBps),
    maxOtmBps: BigInt(maxOtmBps),
    minPremiumBps: BigInt(minPremiumBps),
    maxUtilizationBps: BigInt(maxUtilizationBps),
    protocolFeeBps: BigInt(protocolFeeBps),
    maxContractsCap: BigInt(maxContractsCap),
  };
}

/*//////////////////////////////////////////////////////////////
                              MATHS
//////////////////////////////////////////////////////////////*/

/** Policy.strikeBand: inclusive [lo, hi], floor division both ends, exactly as on chain. */
export function strikeBand(spotUsdg6: bigint, p: PolicyParams): { lo: bigint; hi: bigint } {
  return {
    lo: (spotUsdg6 * (BPS + p.minOtmBps)) / BPS,
    hi: (spotUsdg6 * (BPS + p.maxOtmBps)) / BPS,
  };
}

/** Policy.maxContracts: floor(assets × utilisation / 1e4 / LOT), capped. `assets` is what the
 *  vault sizes against: `totalAssets()`, i.e. idle plus locked less reserved. */
export function maxContracts(assets: bigint, p: PolicyParams): bigint {
  const byUtilisation = (assets * p.maxUtilizationBps) / BPS / ONE_LOT;
  return byUtilisation < p.maxContractsCap ? byUtilisation : p.maxContractsCap;
}

/**
 * Contracts the vault could still write this cycle: `Policy.maxContracts(totalAssets()) −
 * contractsWritten`, floored at zero. This is exactly the `capacityContracts` approveListing
 * checks the offer against (Vault.approveListing), and the size every fill is re-checked
 * against on the total (ValoremLib.writeOnFill step 6). There is no inventory: the vault holds
 * no option tokens between fills.
 */
export function capacity(totalAssets: bigint, contractsWritten: bigint, p: PolicyParams): bigint {
  const cap = maxContracts(totalAssets, p);
  return cap > contractsWritten ? cap - contractsWritten : 0n;
}

/**
 * The smallest per-contract ask that clears `Policy.minPremium` for ANY size.
 *
 * On chain the check is `gross >= floor(spot × contracts × minPremiumBps / 10000)`, and
 * `gross == unitPrice6 × contracts`. Taking the CEILING of the per-contract floor therefore
 * always clears it, and taking the floor sometimes misses it by one base unit — which is a
 * `PremiumBelowMinimum` revert for the sake of a millionth of a dollar.
 */
export function minUnitPrice6(spotUsdg6: bigint, p: PolicyParams): bigint {
  return ceilDiv(spotUsdg6 * p.minPremiumBps, BPS);
}

/**
 * The Valorem engine fee a fill of `n` contracts pulls from the vault in the ASSET, when the fee
 * switch is on: floor(n × LOT × feeBps / 10000), floored at one base unit
 * (ValoremLib.writeOnFill). Zero while the switch is off.
 */
export function engineFeeAsset(n: bigint, feesEnabled: boolean, feeBps: number | bigint): bigint {
  if (!feesEnabled) return 0n;
  const fee = (n * ONE_LOT * BigInt(feeBps)) / BPS;
  return fee === 0n ? 1n : fee;
}

/**
 * The FILL-TIME premium floor for the whole listing, exactly as `ValoremLib.writeOnFill` computes
 * it for a fill of `n`:
 *
 *   floorUsdg = Policy.minPremium(spot, n) + engineFee(n) × spot / LOT
 *
 * The engine fee is asset base units valued at spot, added on top of the premium floor when the
 * switch is on (AUDIT-FINDINGS F-04): the buyer's USDG must cover it or the depositors are
 * paying to sell. Off, the second term is zero and this equals the approval-time floor.
 */
export function fillFloorUsdg6(spotUsdg6: bigint, n: bigint, p: PolicyParams, feesEnabled: boolean, feeBps: number | bigint): bigint {
  const premiumFloor = (spotUsdg6 * n * p.minPremiumBps) / BPS;
  const feeValued = (engineFeeAsset(n, feesEnabled, feeBps) * spotUsdg6) / ONE_LOT;
  return premiumFloor + feeValued;
}

/**
 * The per-contract ask that clears the fill floor for a listing of `n`, as a ceiling:
 * `ceil(fillFloor(n) / n)`. Because the fill gate scales the listing's gross pro rata and the
 * floor for `k` of `n` is `minPremium(spot, k) + fee(k) × spot / LOT`, an ask that clears the
 * floor for the full size clears it for every partial size too, up to the one-base-unit fee
 * floor on tiny fills, which the margin absorbs.
 */
export function fillFloorUnit6(spotUsdg6: bigint, n: bigint, p: PolicyParams, feesEnabled: boolean, feeBps: number | bigint): bigint {
  if (n <= 0n) return minUnitPrice6(spotUsdg6, p);
  return ceilDiv(fillFloorUsdg6(spotUsdg6, n, p, feesEnabled, feeBps), n);
}

/**
 * The list price: the floor lifted by KEEPER_PREMIUM_MARGIN_BPS, rounded UP.
 *
 *   listPrice = ceil(floorUnit6 × (10000 + marginBps) / 10000)
 *
 * WHY: the fill gate re-derives the floor from the spot of the FILL. A price exactly at the
 * floor the keeper computed reverts `PremiumBelowFloorAtFill` on the first buyer after any
 * uptick. A margin of m bps survives a spot rise of up to m bps: the ceiling guarantees
 * `listPrice >= floor × (1 + m/1e4) >= spot' × minPremiumBps / 1e4` for every spot' within it.
 * margin 0 is the identity, so ceil(f × 10000 / 10000) is f exactly.
 */
export function withPremiumMargin(floorUnit6: bigint, marginBps: number | bigint): bigint {
  const margin = BigInt(marginBps);
  if (margin < 0n) throw new Error(`premium margin must not be negative: ${margin}`);
  return ceilDiv(floorUnit6 * (BPS + margin), BPS);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero');
  return (a + b - 1n) / b;
}

/*//////////////////////////////////////////////////////////////
                           THE DECISION
//////////////////////////////////////////////////////////////*/

export type PricingMode = 'vol' | 'fixed';

/**
 * Where the ask came from.
 *   fill-floor         the fill floor lifted by the margin was the binding term (fixed mode, or
 *                      vol mode when the market pays less than the vault's floor)
 *   vol-fair           the market's fair value lifted by the edge, from this decision's fetch
 *   vol-previous-fair  a reprice without fresh data: the last listing's fair value lifted by the
 *                      edge, so the ask never drops below the last market-based one
 *   manual-override    KEEPER_UNIT_PRICE_USDG6, still floored and capped; in vol mode only when it
 *                      is above the market-based ask (it can raise the ask, never undercut it)
 *   min-ask            solo path only (solo.ts): KEEPER_MIN_ASK_USDG6 was above every other term.
 *                      The pooled vault has no such floor; priceListing never returns it
 */
export type PriceSource = 'fill-floor' | 'manual-override' | 'vol-fair' | 'vol-previous-fair' | 'min-ask';

/**
 * Every number behind a strike and an ask, stored with each listing (listings.pricing_json) and
 * served by /state and /orders so the site can show exactly how the order was priced. Bigints are
 * decimal strings (USDG base units); floats are the feed's own numbers, for display only. The
 * record carries figures, never a return: no yield, no annualisation, nothing framed as profit.
 */
export interface PricingRecord {
  mode: PricingMode;
  /** The market-data source, or null in fixed mode. */
  source: typeof VOL_SOURCE | null;
  priceSource: PriceSource;
  /** vol mode: 'fresh' when this decision's fetch priced it, 'previous-fair' when a reprice fell
   *  back to the last listing's fair value. null in fixed mode. */
  volPath: 'fresh' | 'previous-fair' | null;
  /** Why fresh data was not used, on a previous-fair listing. */
  volUnavailableReason: string | null;
  targetDelta: number | null;
  /** Cboe's delta and iv interpolated at the armed strike (share space). */
  deltaAtStrike: number | null;
  ivAtStrike: number | null;
  strikeUsdg6: string;
  /** (strike − spot) / spot in bps, truncated, at the spot this was priced on. */
  strikeOtmBps: number;
  /** vol mode, at the arm: the delta-implied whole-USDG strike before the band clamp. */
  deltaStrikeUsdg6: string | null;
  /** vol mode, at the arm: null when the delta strike was used as is, otherwise which edge of the
   *  (buffered) band it was moved to. */
  strikeClamped: 'band-floor' | 'band-ceiling' | null;
  bandBufferBps: number | null;
  /** The market's fair value for one token call, USDG base units, rounded up. */
  fairUnit6: string | null;
  /** fairUnit6 lifted by the edge: the market-based ask before the floor is applied. */
  volUnit6: string | null;
  /** The vault's fill floor per contract at this spot, before the margin. */
  floorUnit6: string;
  /** floorUnit6 lifted by the margin. */
  marginUnit6: string;
  unitPrice6: string;
  edgeBps: number | null;
  marginBps: number;
  /** The feed's share spot, USD. */
  shareSpot: number | null;
  /** The vault's token spot, USDG (spotUsdg6 / 1e6), and the exact value. */
  tokenSpot: number;
  spotUsdg6: string;
  /** The listed expiry priced against (YYYY-MM-DD). */
  expiry: string | null;
  chainTimestamp: string | null;
  lastTradeTime: string | null;
}

/** The strike-selection half of a record, carried from the arm into every later listing of the
 *  cycle (a reprice never re-picks the strike, but the site still shows how it was picked). */
export type StrikeContext = Pick<PricingRecord, 'targetDelta' | 'deltaStrikeUsdg6' | 'strikeClamped' | 'bandBufferBps'>;

/** Everything the arm decision reads from chain, in one struct so a test can hand it in. */
export interface PlanInput {
  policy: PolicyParams;
  /** vault.spotUsdg(), the same oracle read the vault's own gate uses. */
  spotUsdg6: bigint;
  /** vault.totalAssets(): what the size gate measures against. */
  totalAssets: bigint;
  /** vault.contractsWritten(): 0 at the arm, the sold count later in the week. */
  contractsWritten: bigint;
  feesEnabled: boolean;
  feeBps: number | bigint;
  /** SEAM for tests: stands in for KEEPER_STRIKE_OTM_BPS; `undefined` reads the environment. */
  strikeOtmBps?: number;
  /** SEAM for tests: stands in for KEEPER_PREMIUM_MARGIN_BPS; `undefined` reads the environment. */
  premiumMarginBps?: number;
  /** SEAM for tests: KEEPER_UNIT_PRICE_USDG6. `undefined` reads the environment, `null` is "no
   *  override" regardless of it, a bigint is the override. */
  unitPriceOverride6?: bigint | null;
  /** The pre-fetched option chain (vol mode). roll.ts fetches it; absent in vol mode is
   *  'vol-unavailable', never a silent fall back to fixed. Ignored in fixed mode. */
  vol?: VolContext | null;
  /** SEAMS for tests: each stands in for its KEEPER_* key; `undefined` reads the environment. */
  pricingMode?: PricingMode;
  targetDelta?: number;
  priceEdgeBps?: number;
  volMaxAgeS?: number;
  volMaxSpotDivergenceBps?: number;
  strikeBandBufferBps?: number;
}

export interface WeekPlan {
  ok: true;
  strikeUsdg6: bigint;
  /** The contracts to offer: the vault's remaining capacity. */
  contracts: bigint;
  unitPrice6: bigint;
  gross6: bigint;
  spotUsdg6: bigint;
  bandLowUsdg6: bigint;
  bandHighUsdg6: bigint;
  /** The fill floor per contract at this spot, before the margin. */
  floorUnit6: bigint;
  priceSource: PriceSource;
  pricing: PricingRecord;
}

/** A refusal to arm is a first-class result, not an exception. An unfilled week is the most
 *  likely week and the product publishes it honestly as "unfilled, 0". */
export interface NoWrite {
  ok: false;
  reason: string;
  detail: Record<string, string>;
}

export type PlanResult = WeekPlan | NoWrite;

function pricingModeOf(input: { pricingMode?: PricingMode }): PricingMode {
  return input.pricingMode ?? config.KEEPER_PRICING_MODE;
}

/**
 * Pick this week's strike, size and ask — or decline.
 *
 * fixed:
 *   1. strike = round(spot × (1 + KEEPER_STRIKE_OTM_BPS/1e4)) to the nearest whole USDG; it
 *      must sit inside the vault's OTM band at this spot, both bounds (the arm gate checks both;
 *      the fill gate the floor only).
 *   2. contracts = capacity: floor(totalAssets × maxUtilizationBps / 1e4 / LOT), capped, less
 *      what is already written. Zero means nothing to sell.
 *   3. unitPrice = ceil(fillFloor(contracts) / contracts) lifted by KEEPER_PREMIUM_MARGIN_BPS,
 *      never above the strike (the vault reverts `UnitPriceExceedsStrike`); a manual override
 *      replaces the price but is still bounded the same way.
 *
 * vol:
 *   1. contracts = capacity, as above, checked FIRST: a vault with nothing to sell needs no
 *      market data, and roll.ts does not fetch for one.
 *   2. the chain must be fresh, list this week's close day, have usable quotes, and agree with
 *      the vault's spot (vol.checkVolMarket); otherwise a `vol-*` reason.
 *   3. strike = the KEEPER_TARGET_DELTA strike (vol.strikeForDelta, which refuses a chain whose
 *      deltas cross the target more than once or whose bracket is gapped or arbitrageable),
 *      whole USDG, clamped into [band floor + KEEPER_STRIKE_BAND_BUFFER_BPS, band ceiling −
 *      BAND_CEILING_BUFFER_BPS] in whole USDG; the clamp is recorded. It must still pass
 *      strikeBand at this spot.
 *   4. unitPrice = max(fill floor with the margin, ceil(fair × (1e4 + KEEPER_PRICE_EDGE_BPS) /
 *      1e4)), never above the strike (priceListing). The armed strike must be priced on fresh
 *      data, override or not, and an unclamped strike's delta must sit within
 *      DELTA_AT_STRIKE_TOLERANCE of the target.
 *
 * Any failure returns `ok: false` with a reason. Skipping a week is legitimate; forcing a bad
 * arm is not.
 */
export function planWeek(input: PlanInput): PlanResult {
  const { policy, spotUsdg6, totalAssets, contractsWritten } = input;
  if (spotUsdg6 === 0n) return { ok: false, reason: 'spot-zero', detail: {} };
  const mode = pricingModeOf(input);
  const { lo, hi } = strikeBand(spotUsdg6, policy);

  let strikeUsdg6: bigint;
  let contracts: bigint;
  let strikeContext: StrikeContext | undefined;

  if (mode === 'fixed') {
    const otmBps = input.strikeOtmBps ?? config.KEEPER_STRIKE_OTM_BPS;
    strikeUsdg6 = targetStrike6(spotUsdg6, otmBps);
    if (strikeUsdg6 < lo || strikeUsdg6 > hi) {
      return {
        ok: false,
        reason: 'strike-outside-band',
        detail: {
          strikeUsdg6: strikeUsdg6.toString(),
          spotUsdg6: spotUsdg6.toString(),
          bandLowUsdg6: lo.toString(),
          bandHighUsdg6: hi.toString(),
          strikeOtmBps: String(otmBps),
          minOtmBps: policy.minOtmBps.toString(),
          maxOtmBps: policy.maxOtmBps.toString(),
        },
      };
    }
    contracts = capacity(totalAssets, contractsWritten, policy);
    if (contracts === 0n) return noCapacity(input);
  } else {
    contracts = capacity(totalAssets, contractsWritten, policy);
    if (contracts === 0n) return noCapacity(input);

    const targetDelta = input.targetDelta ?? config.KEEPER_TARGET_DELTA;
    let picked: DeltaStrike;
    try {
      const market = checkVolMarket(input.vol, spotUsdg6, volSettings(input));
      if (!market.ok) return market;
      picked = strikeForDelta(market.quotes, targetDelta, market.ratio);
      if (!picked.ok) return { ok: false, reason: picked.reason, detail: { ...picked.detail, expiry: market.expiry } };
    } catch (error) {
      // Nothing in the chain may throw a tick: any surprise in untrusted data is a skipped week.
      return unexpectedVolError(error);
    }

    const bufferBps = input.strikeBandBufferBps ?? config.KEEPER_STRIKE_BAND_BUFFER_BPS;
    const clamp = clampStrikeToBand(picked.strikeUsdg6, spotUsdg6, policy, bufferBps);
    if (!clamp.ok) {
      return {
        ok: false,
        reason: 'strike-outside-band',
        detail: {
          deltaStrikeUsdg6: picked.strikeUsdg6.toString(),
          spotUsdg6: spotUsdg6.toString(),
          bandLowUsdg6: lo.toString(),
          bandHighUsdg6: hi.toString(),
          bandBufferBps: String(bufferBps),
          why: 'the buffered band holds no whole USDG',
        },
      };
    }
    strikeUsdg6 = clamp.strikeUsdg6;
    if (strikeUsdg6 < lo || strikeUsdg6 > hi) {
      // Unreachable by construction of the clamp; checked rather than assumed, as the arm gate is.
      return {
        ok: false,
        reason: 'strike-outside-band',
        detail: { strikeUsdg6: strikeUsdg6.toString(), bandLowUsdg6: lo.toString(), bandHighUsdg6: hi.toString(), spotUsdg6: spotUsdg6.toString() },
      };
    }
    strikeContext = { targetDelta, deltaStrikeUsdg6: picked.strikeUsdg6.toString(), strikeClamped: clamp.clamped, bandBufferBps: bufferBps };
  }

  const priced = priceListing({ ...input, pricingMode: mode, strikeUsdg6, contracts, previousFairUnit6: null, strikeContext });
  if (!priced.ok) return priced;
  if (mode === 'vol') {
    const { deltaAtStrike, targetDelta } = priced.pricing;
    if (priced.pricing.volPath !== 'fresh') {
      // Unreachable (no previous fair value at the arm); checked rather than assumed.
      return { ok: false, reason: 'vol-unavailable', detail: { why: 'the arm must be priced on fresh market data' } };
    }
    if (
      priced.pricing.strikeClamped === null &&
      deltaAtStrike !== null &&
      targetDelta !== null &&
      !(Math.abs(deltaAtStrike - targetDelta) <= DELTA_AT_STRIKE_TOLERANCE)
    ) {
      return {
        ok: false,
        reason: 'vol-inconsistent',
        detail: {
          why: 'the delta at the armed strike is far from the target',
          strikeUsdg6: strikeUsdg6.toString(),
          deltaAtStrike: String(deltaAtStrike),
          targetDelta: String(targetDelta),
          tolerance: String(DELTA_AT_STRIKE_TOLERANCE),
        },
      };
    }
  }

  log.policy.info(
    {
      mode,
      strikeUsdg6: strikeUsdg6.toString(),
      contracts: contracts.toString(),
      unitPrice6: priced.unitPrice6.toString(),
      priceSource: priced.priceSource,
      floorUnit6: priced.floorUnit6.toString(),
      fairUnit6: priced.pricing.fairUnit6,
      deltaAtStrike: priced.pricing.deltaAtStrike,
      strikeClamped: priced.pricing.strikeClamped,
      bandLowUsdg6: lo.toString(),
      bandHighUsdg6: hi.toString(),
      spotUsdg6: spotUsdg6.toString(),
    },
    'planned this week',
  );

  return {
    ok: true,
    strikeUsdg6,
    contracts,
    unitPrice6: priced.unitPrice6,
    gross6: priced.unitPrice6 * contracts,
    spotUsdg6,
    bandLowUsdg6: lo,
    bandHighUsdg6: hi,
    floorUnit6: priced.floorUnit6,
    priceSource: priced.priceSource,
    pricing: priced.pricing,
  };
}

function noCapacity(input: PlanInput): NoWrite {
  return {
    ok: false,
    reason: 'no-capacity',
    detail: {
      totalAssets: input.totalAssets.toString(),
      contractsWritten: input.contractsWritten.toString(),
      maxUtilizationBps: input.policy.maxUtilizationBps.toString(),
      maxContractsCap: input.policy.maxContractsCap.toString(),
    },
  };
}

function volSettings(input: { volMaxAgeS?: number; volMaxSpotDivergenceBps?: number }): VolSettings {
  return {
    maxAgeS: input.volMaxAgeS ?? config.KEEPER_VOL_MAX_AGE_S,
    maxDivergenceBps: input.volMaxSpotDivergenceBps ?? config.KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS,
    expectedRoot: config.KEEPER_VOL_ROOT,
    holidays: config.KEEPER_NYSE_HOLIDAYS,
  };
}

/** Any exception out of the market-data path (a corrupt number the checks did not anticipate) is
 *  a named skip, never a thrown tick. */
function unexpectedVolError(error: unknown): NoWrite {
  log.policy.warn({ err: error instanceof Error ? error.message : String(error) }, 'market data threw while pricing; treating it as inconsistent');
  return {
    ok: false,
    reason: 'vol-inconsistent',
    detail: { why: 'the market data could not be evaluated', error: (error instanceof Error ? error.message : String(error)).slice(0, 200) },
  };
}

/**
 * Move a whole-USDG strike into the band the vault will accept, with room to spare at both ends:
 *
 *   floor   = ceil(spot × (1e4 + minOtmBps + bufferBps) / 1e4) to a whole USDG
 *   ceiling = floor(spot × (1e4 + maxOtmBps − BAND_CEILING_BUFFER_BPS) / 1e4) to a whole USDG
 *
 * The floor buffer exists because the fill gate re-checks `strike >= band floor` at the spot of
 * every fill: a strike exactly on the floor is unfillable after the first uptick, and no reprice
 * can fix a strike. The ceiling buffer is smaller because only the arm checks the ceiling, but
 * the arm is not atomic with the plan (see BAND_CEILING_BUFFER_BPS). `ok: false` when the
 * buffered band holds no whole USDG at all.
 */
export function clampStrikeToBand(
  strikeUsdg6: bigint,
  spotUsdg6: bigint,
  p: PolicyParams,
  bufferBps: number | bigint,
): { ok: true; strikeUsdg6: bigint; clamped: 'band-floor' | 'band-ceiling' | null; floorUsdg6: bigint; ceilingUsdg6: bigint } | { ok: false } {
  const buffer = BigInt(bufferBps);
  if (buffer < 0n) throw new Error(`band buffer must not be negative: ${buffer}`);
  const bufferedLo = (spotUsdg6 * (BPS + p.minOtmBps + buffer)) / BPS;
  const floorUsdg6 = ceilDiv(bufferedLo, USDG_ONE) * USDG_ONE;
  const ceilingBps = p.maxOtmBps > BAND_CEILING_BUFFER_BPS ? p.maxOtmBps - BAND_CEILING_BUFFER_BPS : 0n;
  const ceilingUsdg6 = ((spotUsdg6 * (BPS + ceilingBps)) / BPS / USDG_ONE) * USDG_ONE;
  if (floorUsdg6 > ceilingUsdg6) return { ok: false };
  if (strikeUsdg6 < floorUsdg6) return { ok: true, strikeUsdg6: floorUsdg6, clamped: 'band-floor', floorUsdg6, ceilingUsdg6 };
  if (strikeUsdg6 > ceilingUsdg6) return { ok: true, strikeUsdg6: ceilingUsdg6, clamped: 'band-ceiling', floorUsdg6, ceilingUsdg6 };
  return { ok: true, strikeUsdg6, clamped: null, floorUsdg6, ceilingUsdg6 };
}

/** The market-based ask: ceil(fair × (1e4 + edge) / 1e4). The same rounding as the margin. */
export function withPriceEdge(fairUnit6: bigint, edgeBps: number | bigint): bigint {
  const edge = BigInt(edgeBps);
  if (edge < 0n) throw new Error(`price edge must not be negative: ${edge}`);
  return ceilDiv(fairUnit6 * (BPS + edge), BPS);
}

export interface PriceInput {
  policy: PolicyParams;
  spotUsdg6: bigint;
  strikeUsdg6: bigint;
  contracts: bigint;
  feesEnabled: boolean;
  feeBps: number | bigint;
  premiumMarginBps?: number;
  unitPriceOverride6?: bigint | null;
  /** vol mode: this decision's chain (see PlanInput.vol). */
  vol?: VolContext | null;
  /** vol mode, reprices: the fair value the cycle's previous listing was priced on, from its
   *  pricing record. The fallback when fresh data is not usable. */
  previousFairUnit6?: bigint | null;
  /** How the armed strike was picked, copied into the record. */
  strikeContext?: StrikeContext;
  pricingMode?: PricingMode;
  targetDelta?: number;
  priceEdgeBps?: number;
  volMaxAgeS?: number;
  volMaxSpotDivergenceBps?: number;
}

export type PriceResult =
  | { ok: true; unitPrice6: bigint; floorUnit6: bigint; priceSource: PriceSource; fairUnit6: bigint | null; pricing: PricingRecord }
  | NoWrite;

/**
 * Price a listing of `contracts` at the current spot. Shared by the first listing of a week and
 * every reprice, so a reprice can never re-pick the strike — the vault is armed on one option id
 * all week.
 *
 *   fixed  the fill floor per contract, lifted by the margin.
 *   vol    max(that, the fair value at the armed strike lifted by the edge). Without usable fresh
 *          data (a reprice on a dark feed) the fair value is the previous listing's (or the
 *          arm's), so a reprice never drops below the last market-based ask; with neither, the
 *          named `vol-*` reason. Fresh data must also pass checkQuoteWindow at the price bracket.
 *          A manual override can only RAISE this ask: it never undercuts the owner's rule, and
 *          it never lists without a market-based fair value. (To sell below the market, switch
 *          KEEPER_PRICING_MODE to fixed.)
 *   fixed  a manual override replaces the price, lifted to the bare fill floor.
 *   both   the result is never above the strike.
 */
export function priceListing(input: PriceInput): PriceResult {
  const { policy, spotUsdg6, strikeUsdg6, contracts } = input;
  if (spotUsdg6 === 0n) return { ok: false, reason: 'spot-zero', detail: {} };
  if (contracts <= 0n) return { ok: false, reason: 'no-capacity', detail: {} };

  const mode = pricingModeOf(input);
  const floorUnit6 = fillFloorUnit6(spotUsdg6, contracts, policy, input.feesEnabled, input.feeBps);
  const marginBps = input.premiumMarginBps ?? config.KEEPER_PREMIUM_MARGIN_BPS;
  const marginUnit6 = withPremiumMargin(floorUnit6, marginBps);
  let unitPrice6 = marginUnit6;
  let priceSource: PriceSource = 'fill-floor';

  // The seam resolves to exactly the environment read when the field is absent (see PlanInput).
  const override6 =
    input.unitPriceOverride6 === undefined ? config.KEEPER_UNIT_PRICE_USDG6 : (input.unitPriceOverride6 ?? undefined);

  const record: PricingRecord = {
    mode,
    source: null,
    priceSource,
    volPath: null,
    volUnavailableReason: null,
    targetDelta: input.strikeContext?.targetDelta ?? null,
    deltaAtStrike: null,
    ivAtStrike: null,
    strikeUsdg6: strikeUsdg6.toString(),
    strikeOtmBps: Number(((strikeUsdg6 - spotUsdg6) * BPS) / spotUsdg6),
    deltaStrikeUsdg6: input.strikeContext?.deltaStrikeUsdg6 ?? null,
    strikeClamped: input.strikeContext?.strikeClamped ?? null,
    bandBufferBps: input.strikeContext?.bandBufferBps ?? null,
    fairUnit6: null,
    volUnit6: null,
    floorUnit6: floorUnit6.toString(),
    marginUnit6: marginUnit6.toString(),
    unitPrice6: '',
    edgeBps: null,
    marginBps,
    shareSpot: null,
    tokenSpot: Number(spotUsdg6) / 1e6,
    spotUsdg6: spotUsdg6.toString(),
    expiry: null,
    chainTimestamp: null,
    lastTradeTime: null,
  };
  let fairUnit6: bigint | null = null;

  if (mode === 'vol') {
    const edgeBps = input.priceEdgeBps ?? config.KEEPER_PRICE_EDGE_BPS;
    record.source = VOL_SOURCE;
    record.edgeBps = edgeBps;
    record.targetDelta ??= input.targetDelta ?? config.KEEPER_TARGET_DELTA;

    const fresh = freshFair(input.vol, spotUsdg6, strikeUsdg6, volSettings(input));
    if (fresh.ok) {
      stampMarket(record, fresh.market, fresh.fair);
      fairUnit6 = fresh.fair.fairUnit6;
      record.volPath = 'fresh';
    } else {
      const previous = input.previousFairUnit6 ?? null;
      if (previous === null || previous <= 0n) return fresh.failure;
      fairUnit6 = previous;
      record.volPath = 'previous-fair';
      record.volUnavailableReason = fresh.failure.reason;
    }

    const volUnit6 = withPriceEdge(fairUnit6, edgeBps);
    record.fairUnit6 = fairUnit6.toString();
    record.volUnit6 = volUnit6.toString();
    if (volUnit6 > marginUnit6) {
      unitPrice6 = volUnit6;
      priceSource = record.volPath === 'previous-fair' ? 'vol-previous-fair' : 'vol-fair';
    }
    if (override6 !== undefined && override6 > unitPrice6) {
      unitPrice6 = override6;
      priceSource = 'manual-override';
    }
  } else if (override6 !== undefined) {
    // An override below the fill floor would be a listing no buyer can fill; lift it silently
    // rather than publish something dead.
    unitPrice6 = override6 > floorUnit6 ? override6 : floorUnit6;
    priceSource = 'manual-override';
  }

  // The vault reverts `UnitPriceExceedsStrike`. If the floor genuinely lands above the strike
  // the oracle is broken, not the market; if the market price does, the strike is deep in the
  // money and no week should be sold on it.
  if (strikeUsdg6 > 0n && unitPrice6 > strikeUsdg6) {
    return {
      ok: false,
      reason: 'premium-above-strike',
      detail: { unitPrice6: unitPrice6.toString(), strikeUsdg6: strikeUsdg6.toString(), spotUsdg6: spotUsdg6.toString() },
    };
  }
  record.priceSource = priceSource;
  record.unitPrice6 = unitPrice6.toString();
  return { ok: true, unitPrice6, floorUnit6, priceSource, fairUnit6, pricing: record };
}

/** The fair value at `strikeUsdg6` from this decision's chain, every check applied, or the named
 *  reason it cannot be had. Never throws. */
function freshFair(
  vol: VolContext | null | undefined,
  spotUsdg6: bigint,
  strikeUsdg6: bigint,
  settings: VolSettings,
): { ok: true; market: VolMarket; fair: FairPrice } | { ok: false; failure: NoWrite } {
  try {
    const market = checkVolMarket(vol, spotUsdg6, settings);
    if (!market.ok) return { ok: false, failure: market };
    const fair = fairCallPrice(market.quotes, strikeUsdg6, market.ratio);
    if (fair === null) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: 'vol-strike-unquoted',
          detail: {
            strikeUsdg6: strikeUsdg6.toString(),
            shareStrike: (Number(strikeUsdg6) / 1e6 / market.ratio).toFixed(4),
            quotedLow: String(market.quotes[0]?.strike ?? 'none'),
            quotedHigh: String(market.quotes[market.quotes.length - 1]?.strike ?? 'none'),
            expiry: market.expiry,
          },
        },
      };
    }
    const window = checkQuoteWindow(market.quotes, fair.bracket);
    if (window !== null) return { ok: false, failure: { ...window, detail: { ...window.detail, expiry: market.expiry } } };
    return { ok: true, market, fair };
  } catch (error) {
    return { ok: false, failure: unexpectedVolError(error) };
  }
}

function stampMarket(record: PricingRecord, market: VolMarket, fair: FairPrice): void {
  record.deltaAtStrike = fair.deltaAtStrike;
  record.ivAtStrike = fair.ivAtStrike;
  record.shareSpot = market.shareSpot;
  record.expiry = market.expiry;
  record.chainTimestamp = market.chainTimestamp;
  record.lastTradeTime = market.lastTradeTime;
}

/** The fair value a stored pricing record carries, or null (fixed mode, a pre-vol row, garbage). */
export function storedFairUnit6(pricingJson: string | null | undefined): bigint | null {
  if (!pricingJson) return null;
  try {
    const parsed = JSON.parse(pricingJson) as { fairUnit6?: unknown };
    if (typeof parsed.fairUnit6 !== 'string' || !/^\d{1,30}$/.test(parsed.fairUnit6)) return null;
    const value = BigInt(parsed.fairUnit6);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** The strike-selection half of a stored record, or undefined. */
export function storedStrikeContext(pricingJson: string | null | undefined): StrikeContext | undefined {
  if (!pricingJson) return undefined;
  try {
    const p = JSON.parse(pricingJson) as Partial<PricingRecord>;
    const clamp = p.strikeClamped === 'band-floor' || p.strikeClamped === 'band-ceiling' ? p.strikeClamped : null;
    return {
      targetDelta: typeof p.targetDelta === 'number' && Number.isFinite(p.targetDelta) ? p.targetDelta : null,
      deltaStrikeUsdg6: typeof p.deltaStrikeUsdg6 === 'string' && /^\d{1,30}$/.test(p.deltaStrikeUsdg6) ? p.deltaStrikeUsdg6 : null,
      strikeClamped: clamp,
      bandBufferBps: typeof p.bandBufferBps === 'number' && Number.isInteger(p.bandBufferBps) ? p.bandBufferBps : null,
    };
  } catch {
    return undefined;
  }
}

/*//////////////////////////////////////////////////////////////
                        THE FILL GATE, MIRRORED
//////////////////////////////////////////////////////////////*/

export interface LiveListing {
  /** The listing's gross for its whole size (`vault.listingGrossUsdg`). */
  grossUsdg6: bigint;
  /** The listing's size (`vault.listingAmount`); Seaport tracks the fraction filled. */
  amount: bigint;
  strikeUsdg6: bigint;
}

export type FillVerdict =
  | { fillable: true; floorUnit6: bigint }
  | { fillable: false; reason: 'strike-below-band' | 'premium-below-floor'; floorUnit6: bigint; detail: Record<string, string> };

/**
 * Would a fill of the live listing clear the vault's fill gate at THIS spot? The checks
 * `ValoremLib.writeOnFill` makes that depend on spot, reproduced integer for integer:
 *
 *   strike >= Policy.strikeBand(spot).lo          else StrikeBelowBand   (a rally: no price fixes it)
 *   gross(k) >= minPremium(spot, k) + fee(k)×spot  else PremiumBelowFloorAtFill (a reprice fixes it)
 *
 * evaluated for the full size `k = amount`, which is the binding case for the linear parts and
 * within a base unit of it for the fee floor. This is what decides a reprice: the vault never
 * tells the keeper a listing has gone unfillable — buyers simply get reverts — so the keeper
 * must ask the same question the hook will. An eth_call of a real fill needs a funded buyer
 * with a USDG allowance, which the keeper does not have; the mirror is the honest substitute,
 * and `approveListing`'s own simulation is the backstop for the reprice it produces.
 */
export function fillVerdict(spotUsdg6: bigint, listing: LiveListing, p: PolicyParams, feesEnabled: boolean, feeBps: number | bigint): FillVerdict {
  const { lo } = strikeBand(spotUsdg6, p);
  const floorUnit6 = fillFloorUnit6(spotUsdg6, listing.amount, p, feesEnabled, feeBps);
  if (listing.strikeUsdg6 < lo) {
    return {
      fillable: false,
      reason: 'strike-below-band',
      floorUnit6,
      detail: { strikeUsdg6: listing.strikeUsdg6.toString(), bandLowUsdg6: lo.toString(), spotUsdg6: spotUsdg6.toString() },
    };
  }
  const floorUsdg6 = fillFloorUsdg6(spotUsdg6, listing.amount, p, feesEnabled, feeBps);
  if (listing.grossUsdg6 < floorUsdg6) {
    return {
      fillable: false,
      reason: 'premium-below-floor',
      floorUnit6,
      detail: {
        grossUsdg6: listing.grossUsdg6.toString(),
        floorUsdg6: floorUsdg6.toString(),
        unitPrice6: listing.amount === 0n ? '0' : (listing.grossUsdg6 / listing.amount).toString(),
        floorUnit6: floorUnit6.toString(),
        spotUsdg6: spotUsdg6.toString(),
      },
    };
  }
  return { fillable: true, floorUnit6 };
}
