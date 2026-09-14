/**
 * One `Harvest` event, split into premium and strike proceeds. Pure: no Ponder, no database.
 *
 * WHY THIS EXISTS (W-21). `Vault._harvest` inside `rollClose` sweeps everything that arrived
 * since the last sweep, and on an assigned week that includes the USDG the claim returned for
 * the contracts taken at the strike. So on the terminal harvest of an assigned week:
 *
 *   grossUsdg  = premium not yet swept + RollClose.usdgFromAssignment
 *   feeUsdg    = floor((grossUsdg − usdgFromAssignment) × protocolFeeBps / 10_000)
 *   netUsdg    = grossUsdg − feeUsdg
 *
 * `netUsdg` is what the Distributor credits holders, and it is real money, but the strike part
 * of it is returned principal: collateral that left at the strike and came back as USDG. It is
 * not yield. Summing `netUsdg` as "premium" made a week that earned 43.32 USDG of premium on 12
 * contracts publish 993.32, and every per-share and "realized" figure built on it inherited the
 * error. A deposit or mint checkpoint (`_checkpointHarvest`) passes 0 as the fee-free part and
 * can never carry strike proceeds, because they sit inside the Valorem claim until `rollClose`
 * redeems it.
 *
 * The event carries no split, so the caller supplies `usdgFromAssignment`: `RollClose`'s own
 * argument for the terminal harvest (emitted one log earlier in the same transaction), the live
 * shares' part of a recovered stranded claim's USDG for the retry's harvest (lib/lifecycle.ts
 * `strandRecovery`), 0 for a checkpoint. Nothing here recomputes the fee; the fee is the event's.
 */

export const SHARE_SCALE = 10n ** 18n;

export type HarvestEvent = {
  grossUsdg: bigint;
  feeUsdg: bigint;
  netUsdg: bigint;
  /** `RollClose.usdgFromAssignment` for the terminal harvest; 0 for a deposit checkpoint. */
  usdgFromAssignment: bigint;
  /** Share supply the sweep was indexed against (pre-burn, pre-mint). */
  supply: bigint;
};

/** The per-event split. Every field is USDG base units except the two per-share figures. */
export type HarvestSplit = {
  /** The part of `grossUsdg` that is strike proceeds. Never more than `grossUsdg`. */
  strikeProceeds: bigint;
  /** `grossUsdg − strikeProceeds`: premium that reached the vault (one consideration item, no venue cut). */
  premiumGross: bigint;
  /** `premiumGross − feeUsdg`: premium after the protocol fee. The only "earned" figure. */
  premiumNet: bigint;
  /** `netUsdg` verbatim: everything credited to holders, premium AND strike proceeds. */
  credited: bigint;
  /** `premiumNet × 1e18 / supply`, USDG base units per whole share. */
  premiumNetPerShare: bigint;
  /** `netUsdg × 1e18 / supply`, the credited figure per whole share. Not a premium figure. */
  creditedPerShare: bigint;
};

export const perShare = (amount: bigint, supply: bigint): bigint =>
  supply === 0n ? 0n : (amount * SHARE_SCALE) / supply;

export function splitHarvest(h: HarvestEvent): HarvestSplit {
  // Clamped, not trusted: strike proceeds cannot exceed what the sweep found. (They cannot on
  // chain either — `usdgFromAssignment` is a balance delta inside the same sweep — but a
  // negative premium must be impossible here rather than merely unlikely.)
  const strikeProceeds = h.usdgFromAssignment < h.grossUsdg ? h.usdgFromAssignment : h.grossUsdg;
  const premiumGross = h.grossUsdg - strikeProceeds;
  // The fee is charged on `premiumGross` alone, so it can never exceed it; clamp all the same.
  const premiumNet = premiumGross > h.feeUsdg ? premiumGross - h.feeUsdg : 0n;
  return {
    strikeProceeds,
    premiumGross,
    premiumNet,
    credited: h.netUsdg,
    premiumNetPerShare: perShare(premiumNet, h.supply),
    creditedPerShare: perShare(h.netUsdg, h.supply),
  };
}

/**
 * A cycle's harvest columns, named exactly as they are in `ponder.schema.ts` so the handler can
 * patch the row with the result.
 */
export type CycleHarvestTotals = {
  harvestGross: bigint;
  harvestPremiumGross: bigint;
  strikeProceeds: bigint;
  fee: bigint;
  premiumNet: bigint;
  creditedUsdg: bigint;
  premiumNetPerShare: bigint;
  usdgPerShare: bigint;
};

export const ZERO_HARVEST_TOTALS: CycleHarvestTotals = {
  harvestGross: 0n,
  harvestPremiumGross: 0n,
  strikeProceeds: 0n,
  fee: 0n,
  premiumNet: 0n,
  creditedUsdg: 0n,
  premiumNetPerShare: 0n,
  usdgPerShare: 0n,
};

/**
 * Accumulate one harvest onto a cycle's totals. Accumulated, not assigned: a week's take can be
 * swept by several checkpoints and then the terminal harvest, and the published figure is the
 * whole week. Per-share figures are summed per sweep because each sweep was indexed against the
 * supply of its own moment, so the sum is what a share held all week actually received.
 */
export function addHarvest(t: CycleHarvestTotals, h: HarvestEvent): CycleHarvestTotals {
  const s = splitHarvest(h);
  return {
    harvestGross: t.harvestGross + h.grossUsdg,
    harvestPremiumGross: t.harvestPremiumGross + s.premiumGross,
    strikeProceeds: t.strikeProceeds + s.strikeProceeds,
    fee: t.fee + h.feeUsdg,
    premiumNet: t.premiumNet + s.premiumNet,
    creditedUsdg: t.creditedUsdg + s.credited,
    premiumNetPerShare: t.premiumNetPerShare + s.premiumNetPerShare,
    usdgPerShare: t.usdgPerShare + s.creditedPerShare,
  };
}
