/**
 * The strike picker and the sizer.
 *
 * Everything here mirrors contracts/src/Policy.sol exactly, in the same integer arithmetic,
 * because the vault re-checks all of it on chain and reverts if the keeper's answer differs.
 * Getting the rounding right here is the difference between a simulation that passes and a
 * Friday-night `StrikeBelowBand` revert.
 *
 * Nothing is hardcoded. The band, the utilisation, the cap and the premium floor are all read
 * from `vault.policy()` so an admin policy change takes effect without a keeper deploy.
 *
 * UNITS, stated once:
 *   spotUsdg6    spot price of ONE lot (1e18 of the asset) in USDG base units (6 dp).
 *   strikeUsdg6  registry.strikePerContract(optionId), same units.
 *   contracts    whole lots. One lot = cycle.lotSize asset base units (1e18 on every market).
 *   unitPrice6   the ask for ONE contract, USDG base units, gross (before Overcall's 5%).
 */
import { registryAbi, vaultAbi } from './abi.js';
import { publicClient } from './clients.js';
import { BPS, ONE_LOT, config } from './config.js';
import { log } from './logger.js';
import { lastFilledUnitPrice6 } from './overcallApi.js';
import { MIN_LISTABLE_UNIT_PRICE_6, splitPremium } from './seaport.js';

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

export interface Rung {
  optionId: bigint;
  strikeUsdg6: bigint;
  approved: boolean;
  cycleOf: number;
}

export interface CycleView {
  number: number;
  exerciseTimestamp: bigint;
  expiryTimestamp: bigint;
  lotSize: bigint;
  optionIds: readonly bigint[];
}

export interface WritePlan {
  optionId: bigint;
  strikeUsdg6: bigint;
  contracts: bigint;
  unitPrice6: bigint;
  gross6: bigint;
  toVault6: bigint;
  toOvercall6: bigint;
  /** exerciseTimestamp: the Seaport order's endTime. Friday book close, not Saturday expiry. */
  endTime: bigint;
  spotUsdg6: bigint;
  bandLowUsdg6: bigint;
  bandHighUsdg6: bigint;
  priceSource: 'policy-floor' | 'last-fill' | 'manual-override';
}

/** A refusal to write is a first-class result, not an exception. An unfilled week is the most
 *  likely week and the product publishes it honestly as "unfilled, 0". */
export interface NoWrite {
  ok: false;
  reason: string;
  detail: Record<string, string>;
}

export type PickResult = ({ ok: true } & WritePlan) | NoWrite;

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

/** The last lotSize value warned about, so a non-1e18 market warns once per boot, not per tick. */
let warnedLotSize: string | undefined;

/** The registry's live cycle. Note there is NO status field on this struct; the write gate is
 *  `isWritingOpen()`. */
export async function readCycle(): Promise<CycleView> {
  const cycle = await publicClient.readContract({
    address: config.REGISTRY,
    abi: registryAbi,
    functionName: 'cycle',
  });
  const lotSize = BigInt(cycle.lotSize);
  // Policy.sol's sizer divides by a COMPILED LOT = 1e18 while pickWrite below divides by this
  // registry value. A market that ever set a different lot size would have every write revert
  // ContractsAboveUtilization all week — say so once, because it would otherwise stay silent
  // until the first revert.
  if (lotSize !== ONE_LOT && warnedLotSize !== lotSize.toString()) {
    warnedLotSize = lotSize.toString();
    log.policy.warn(
      { lotSize: lotSize.toString() },
      'registry lot size is not 1e18; Policy.sol divides by a compiled LOT=1e18, so keeper sizing will revert on chain',
    );
  }
  return {
    number: cycle.number,
    exerciseTimestamp: BigInt(cycle.exerciseTimestamp),
    expiryTimestamp: BigInt(cycle.expiryTimestamp),
    lotSize,
    optionIds: cycle.optionIds,
  };
}

/**
 * Every rung in the live cycle, with its strike, sorted ascending.
 *
 * `cycle().optionIds` and `activeOptionIds()` return the same set; we read `activeOptionIds()`
 * as the authority (it is what Overcall's own validator consults for `isApproved`) and fall
 * back to the cycle struct's array if it comes back empty.
 */
export async function readRungs(cycle: CycleView): Promise<Rung[]> {
  let ids: readonly bigint[] = await publicClient.readContract({
    address: config.REGISTRY,
    abi: registryAbi,
    functionName: 'activeOptionIds',
  });
  if (ids.length === 0) ids = cycle.optionIds;

  const rungs = await Promise.all(
    ids.map(async (optionId): Promise<Rung> => {
      const [strike, approved, cycleOf] = await Promise.all([
        publicClient.readContract({
          address: config.REGISTRY,
          abi: registryAbi,
          functionName: 'strikePerContract',
          args: [optionId],
        }),
        publicClient.readContract({
          address: config.REGISTRY,
          abi: registryAbi,
          functionName: 'isApproved',
          args: [optionId],
        }),
        publicClient.readContract({
          address: config.REGISTRY,
          abi: registryAbi,
          functionName: 'cycleOf',
          args: [optionId],
        }),
      ]);
      return { optionId, strikeUsdg6: BigInt(strike), approved, cycleOf };
    }),
  );

  const sorted = rungs.sort((a, b) => (a.strikeUsdg6 < b.strikeUsdg6 ? -1 : a.strikeUsdg6 > b.strikeUsdg6 ? 1 : 0));
  log.policy.debug(
    { count: sorted.length, rungs: sorted.map((rung) => `${rung.strikeUsdg6.toString()}:${rung.approved}`).join(',') },
    'ladder read',
  );
  return sorted;
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

/** Policy.maxContracts: floor(idle * utilisation / 1e4 / lot), capped. */
export function maxContracts(idleAssets: bigint, lotSize: bigint, p: PolicyParams): bigint {
  if (lotSize === 0n) return 0n;
  const byUtilisation = (idleAssets * p.maxUtilizationBps) / BPS / lotSize;
  return byUtilisation < p.maxContractsCap ? byUtilisation : p.maxContractsCap;
}

/**
 * The smallest per-contract ask that clears the vault's premium floor.
 *
 * On chain the check is `gross >= floor(spot * contracts * minPremiumBps / 10000)`, and
 * `gross == unitPrice6 * contracts`. Taking the CEILING of the per-contract floor therefore
 * always clears it, and taking the floor sometimes misses it by one base unit — which is a
 * `PremiumBelowMinimum` revert for the sake of a millionth of a dollar.
 */
export function minUnitPrice6(spotUsdg6: bigint, p: PolicyParams): bigint {
  return ceilDiv(spotUsdg6 * p.minPremiumBps, BPS);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero');
  return (a + b - 1n) / b;
}

/**
 * The last-fill lift is honoured at most to this multiple of the policy floor.
 *
 * Why a clamp at all: anyone can write 1 contract of this week's rung on permissionless
 * Valorem and self-fill it on Overcall at an absurd price — the cost is the 5% fee on one
 * contract. An unclamped max(floor, last fill) would then price the WHOLE vault's listing at
 * the attacker's number and guarantee an unfilled week, repeatable weekly. A real market
 * signal three times the floor is still honoured; beyond that, faking the signal costs more
 * than the premium at stake.
 */
export const LAST_FILL_MAX_LIFT = 3n;

/*//////////////////////////////////////////////////////////////
                           THE DECISION
//////////////////////////////////////////////////////////////*/

export interface PickInput {
  cycle: CycleView;
  rungs: Rung[];
  policy: PolicyParams;
  /** vault.idleAssets(), asset base units. */
  idleAssets: bigint;
  /** vault.spotUsdg(), the same oracle read the vault's own gate uses. */
  spotUsdg6: bigint;
  /**
   * SEAM, for tests and the fork dry run only. Where "the last fill on these rungs" comes from.
   * Production never sets it and gets `lastFilledUnitPrice6` — the live Overcall book. It is
   * injectable so the picker's integer maths can be pinned in a unit test without a network,
   * and so a rehearsal can hand it a stubbed book. Same signature, same null-means-no-fill.
   */
  readLastFill?: (optionIds: readonly bigint[]) => Promise<bigint | null>;
  /**
   * SEAM, for tests only. Stands in for KEEPER_UNIT_PRICE_USDG6. `undefined` (the production
   * value: the field is absent) reads the environment as before; `null` means "no override"
   * regardless of the environment; a bigint is the override. Exists because config is fixed
   * at import time and a test needs both branches in one process.
   */
  unitPriceOverride6?: bigint | null;
}

/**
 * Pick this week's rung, size and ask — or decline.
 *
 * Order of operations:
 *   1. rungs -> keep the ones approved and in the live cycle
 *   2. keep the ones inside the vault's OTM band, read from policy() rather than hardcoded
 *   3. take the NEAREST out-of-the-money one, i.e. the lowest eligible strike. Nearest OTM is
 *      where the premium is; the far rungs earn nothing on a weekly.
 *   4. size = floor(idle * maxUtilizationBps / 10000 / lotSize), capped by maxContractsCap
 *   5. price = max(policy floor, last fill), the last-fill lift clamped at LAST_FILL_MAX_LIFT
 *      times the floor (a self-filled print is a cheap fake signal), floored again at 20 base
 *      units so Overcall's 5% does not round to zero, and never above the strike (both the
 *      vault and Overcall reject a premium above the strike as a fat finger)
 *
 * Any failure returns `ok: false` with a reason. Skipping a week is legitimate; forcing a bad
 * write is not.
 */
export async function pickWrite(input: PickInput): Promise<PickResult> {
  const { cycle, rungs, policy, idleAssets, spotUsdg6 } = input;

  if (cycle.number === 0) {
    return { ok: false, reason: 'no-cycle', detail: { cycleNumber: '0' } };
  }
  if (spotUsdg6 === 0n) {
    return { ok: false, reason: 'spot-zero', detail: {} };
  }

  const contracts = maxContracts(idleAssets, cycle.lotSize, policy);
  if (contracts === 0n) {
    return {
      ok: false,
      reason: 'no-idle-collateral',
      detail: {
        idleAssets: idleAssets.toString(),
        lotSize: cycle.lotSize.toString(),
        maxUtilizationBps: policy.maxUtilizationBps.toString(),
      },
    };
  }

  const { lo, hi } = strikeBand(spotUsdg6, policy);
  const live = rungs.filter((rung) => rung.approved && rung.cycleOf === cycle.number);
  const eligible = live.filter((rung) => rung.strikeUsdg6 >= lo && rung.strikeUsdg6 <= hi);

  if (eligible.length === 0) {
    return {
      ok: false,
      reason: 'no-rung-in-band',
      detail: {
        spotUsdg6: spotUsdg6.toString(),
        bandLowUsdg6: lo.toString(),
        bandHighUsdg6: hi.toString(),
        strikes: live.map((rung) => rung.strikeUsdg6.toString()).join(','),
        minOtmBps: policy.minOtmBps.toString(),
        maxOtmBps: policy.maxOtmBps.toString(),
      },
    };
  }

  // `rungs` is sorted ascending, so the first survivor is the nearest out-of-the-money strike.
  const chosen = eligible[0];
  if (!chosen) {
    return { ok: false, reason: 'no-rung-in-band', detail: {} };
  }

  const floorUnit6 = minUnitPrice6(spotUsdg6, policy);
  let unitPrice6 = floorUnit6;
  let priceSource: WritePlan['priceSource'] = 'policy-floor';

  // Prefer a fill on the rung we are actually writing. Only if that rung has never traded do
  // we fall back to any rung in the cycle — a fill on a further-out strike is a weak signal
  // for a nearer one, but it is a better floor than nothing.
  const readLastFill = input.readLastFill ?? lastFilledUnitPrice6;
  const lastFill6 =
    (await readLastFill([chosen.optionId])) ?? (await readLastFill(live.map((rung) => rung.optionId)));
  if (lastFill6 !== null && floorUnit6 > 0n && lastFill6 > unitPrice6) {
    // Clamped — see LAST_FILL_MAX_LIFT. A zero floor anchors no signal, so the lift is skipped.
    unitPrice6 = lastFill6 < floorUnit6 * LAST_FILL_MAX_LIFT ? lastFill6 : floorUnit6 * LAST_FILL_MAX_LIFT;
    priceSource = 'last-fill';
  }

  // The seam resolves to exactly the old read when the field is absent (see PickInput).
  const override6 =
    input.unitPriceOverride6 === undefined ? config.KEEPER_UNIT_PRICE_USDG6 : (input.unitPriceOverride6 ?? undefined);
  if (override6 !== undefined) {
    unitPrice6 = override6;
    priceSource = 'manual-override';
  }

  if (unitPrice6 < MIN_LISTABLE_UNIT_PRICE_6) unitPrice6 = MIN_LISTABLE_UNIT_PRICE_6;

  // The vault reverts `UnitPriceExceedsStrike` and Overcall's check 5 rejects it too. If the
  // floor genuinely lands above the strike the oracle is broken, not the market.
  if (unitPrice6 > chosen.strikeUsdg6) {
    return {
      ok: false,
      reason: 'premium-above-strike',
      detail: {
        unitPrice6: unitPrice6.toString(),
        strikeUsdg6: chosen.strikeUsdg6.toString(),
        spotUsdg6: spotUsdg6.toString(),
      },
    };
  }

  const { toVault6, toOvercall6, gross6 } = splitPremium(unitPrice6, contracts);

  log.policy.info(
    {
      optionId: chosen.optionId.toString(),
      strikeUsdg6: chosen.strikeUsdg6.toString(),
      contracts: contracts.toString(),
      unitPrice6: unitPrice6.toString(),
      priceSource,
      bandLowUsdg6: lo.toString(),
      bandHighUsdg6: hi.toString(),
      spotUsdg6: spotUsdg6.toString(),
    },
    'picked this cycle',
  );

  return {
    ok: true,
    optionId: chosen.optionId,
    strikeUsdg6: chosen.strikeUsdg6,
    contracts,
    unitPrice6,
    gross6,
    toVault6,
    toOvercall6,
    endTime: cycle.exerciseTimestamp,
    spotUsdg6,
    bandLowUsdg6: lo,
    bandHighUsdg6: hi,
    priceSource,
  };
}

/*//////////////////////////////////////////////////////////////
                        RELIST SIZING
//////////////////////////////////////////////////////////////*/

/**
 * Size a replacement listing.
 *
 * After a cancel or a partial fill the vault may hold fewer option tokens than it wrote, and
 * `approveListing` checks the offer against `clear.balanceOf(vault, optionId)`. `contractsSold`
 * on the vault is reporting-only and is never decremented by a Seaport fill, so the ERC-1155
 * balance is the only honest source for "what can we still sell".
 */
export function relistContracts(inventory: bigint): bigint {
  return inventory;
}

/** The vault's own per-cycle cap, mirrored so the keeper stops before a revert. */
export const MAX_LISTINGS_PER_CYCLE = 3;
