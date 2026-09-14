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
 */
import { vaultAbi } from './abi.js';
import { publicClient } from './clients.js';
import { BPS, ONE_LOT, config } from './config.js';
import { log } from './logger.js';
import { targetStrike6 } from './optionType.js';

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

/*//////////////////////////////////////////////////////////////
                           CHAIN READS
//////////////////////////////////////////////////////////////*/

/** The last policy() payload seen, serialised, so an admin `setPolicy` logs exactly once on
 *  the next poll instead of on every tick. `undefined` until the first read after boot. */
let lastPolicyJson: string | undefined;

export async function readPolicy(): Promise<PolicyParams> {
  const [minOtmBps, maxOtmBps, minPremiumBps, maxUtilizationBps, protocolFeeBps, maxContractsCap] =
    await publicClient.readContract({
      address: config.VAULT,
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
  priceSource: 'fill-floor' | 'manual-override';
}

/** A refusal to arm is a first-class result, not an exception. An unfilled week is the most
 *  likely week and the product publishes it honestly as "unfilled, 0". */
export interface NoWrite {
  ok: false;
  reason: string;
  detail: Record<string, string>;
}

export type PlanResult = WeekPlan | NoWrite;

/**
 * Pick this week's strike, size and ask — or decline.
 *
 *   1. strike = round(spot × (1 + KEEPER_STRIKE_OTM_BPS/1e4)) to the nearest whole USDG; it
 *      must sit inside the vault's OTM band at this spot, both bounds (the arm gate checks both;
 *      the fill gate the floor only).
 *   2. contracts = capacity: floor(totalAssets × maxUtilizationBps / 1e4 / LOT), capped, less
 *      what is already written. Zero means nothing to sell.
 *   3. unitPrice = ceil(fillFloor(contracts) / contracts) lifted by KEEPER_PREMIUM_MARGIN_BPS,
 *      never above the strike (the vault reverts `UnitPriceExceedsStrike`); a manual override
 *      replaces the price but is still bounded the same way.
 *
 * Any failure returns `ok: false` with a reason. Skipping a week is legitimate; forcing a bad
 * arm is not.
 */
export function planWeek(input: PlanInput): PlanResult {
  const { policy, spotUsdg6, totalAssets, contractsWritten } = input;
  if (spotUsdg6 === 0n) return { ok: false, reason: 'spot-zero', detail: {} };

  const otmBps = input.strikeOtmBps ?? config.KEEPER_STRIKE_OTM_BPS;
  const strikeUsdg6 = targetStrike6(spotUsdg6, otmBps);
  const { lo, hi } = strikeBand(spotUsdg6, policy);
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

  const contracts = capacity(totalAssets, contractsWritten, policy);
  if (contracts === 0n) {
    return {
      ok: false,
      reason: 'no-capacity',
      detail: {
        totalAssets: totalAssets.toString(),
        contractsWritten: contractsWritten.toString(),
        maxUtilizationBps: policy.maxUtilizationBps.toString(),
        maxContractsCap: policy.maxContractsCap.toString(),
      },
    };
  }

  const priced = priceListing({ ...input, strikeUsdg6, contracts });
  if (!priced.ok) return priced;

  log.policy.info(
    {
      strikeUsdg6: strikeUsdg6.toString(),
      contracts: contracts.toString(),
      unitPrice6: priced.unitPrice6.toString(),
      priceSource: priced.priceSource,
      floorUnit6: priced.floorUnit6.toString(),
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
  };
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
}

export type PriceResult =
  | { ok: true; unitPrice6: bigint; floorUnit6: bigint; priceSource: WeekPlan['priceSource'] }
  | NoWrite;

/**
 * Price a listing of `contracts` at the current spot: the fill floor per contract, lifted by the
 * margin, never above the strike. Shared by the first listing of a week and every reprice, so a
 * reprice can never re-pick the strike — the vault is armed on one option id all week.
 */
export function priceListing(input: PriceInput): PriceResult {
  const { policy, spotUsdg6, strikeUsdg6, contracts } = input;
  if (spotUsdg6 === 0n) return { ok: false, reason: 'spot-zero', detail: {} };
  if (contracts <= 0n) return { ok: false, reason: 'no-capacity', detail: {} };

  const floorUnit6 = fillFloorUnit6(spotUsdg6, contracts, policy, input.feesEnabled, input.feeBps);
  const marginBps = input.premiumMarginBps ?? config.KEEPER_PREMIUM_MARGIN_BPS;
  let unitPrice6 = withPremiumMargin(floorUnit6, marginBps);
  let priceSource: WeekPlan['priceSource'] = 'fill-floor';

  // The seam resolves to exactly the environment read when the field is absent (see PlanInput).
  const override6 =
    input.unitPriceOverride6 === undefined ? config.KEEPER_UNIT_PRICE_USDG6 : (input.unitPriceOverride6 ?? undefined);
  if (override6 !== undefined) {
    // An override below the fill floor would be a listing no buyer can fill; lift it silently
    // rather than publish something dead.
    unitPrice6 = override6 > floorUnit6 ? override6 : floorUnit6;
    priceSource = 'manual-override';
  }

  // The vault reverts `UnitPriceExceedsStrike`. If the floor genuinely lands above the strike
  // the oracle is broken, not the market.
  if (strikeUsdg6 > 0n && unitPrice6 > strikeUsdg6) {
    return {
      ok: false,
      reason: 'premium-above-strike',
      detail: { unitPrice6: unitPrice6.toString(), strikeUsdg6: strikeUsdg6.toString(), spotUsdg6: spotUsdg6.toString() },
    };
  }
  return { ok: true, unitPrice6, floorUnit6, priceSource };
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
