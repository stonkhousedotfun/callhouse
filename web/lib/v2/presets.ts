import type { Strategy } from "./api-types";
import { premium } from "./payoff";
import { autoRollTargetStrike, fixedAskBpsFromReference, MAX_ASK_BPS, MIN_ASK_BPS,
  proposedSmartPricingBand, selectSmartPricingReference } from "./smartPricing";

export type PresetId = "weekly-5" | "weekly-delta-15" | "daily-2" | "weekly-10";
export const WRITER_PRESETS: readonly { id: PresetId; label: string; detail: string; weekly: boolean; otmBps: number }[] = [
  { id: "weekly-5", label: "Weekly, +5% OTM", detail: "A weekly call about 5% above spot.", weekly: true, otmBps: 500 },
  { id: "weekly-delta-15", label: "Weekly, ~0.15 delta", detail: "Find the closest live weekly delta; review auto-pricing separately.", weekly: true, otmBps: 0 },
  { id: "daily-2", label: "Daily, +2% OTM", detail: "A short daily call about 2% above spot.", weekly: false, otmBps: 200 },
  { id: "weekly-10", label: "Conservative, +10% OTM weekly", detail: "More room above spot, usually a smaller premium.", weekly: true, otmBps: 1_000 },
];

export function otmBps(spot: bigint, strike: bigint): number {
  if (spot <= 0n || strike <= spot) throw new RangeError("The strike must be above the live spot.");
  const value = Number(((strike - spot) * 10_000n + spot / 2n) / spot);
  if (value < 100 || value > 2_500) throw new RangeError("Auto-roll strikes must be 1% to 25% out of the money.");
  return value;
}

export function presetAutoRollTarget(
  id: PresetId,
  spot: bigint,
  strikeTick: bigint,
  deltaStrike?: bigint,
): { otmBps: number; strike: bigint } {
  const preset = WRITER_PRESETS.find((row) => row.id === id);
  if (!preset) throw new RangeError("Unknown preset.");
  const distance = id === "weekly-delta-15"
    ? (deltaStrike === undefined ? null : otmBps(spot, deltaStrike))
    : preset.otmBps;
  if (distance === null) throw new RangeError("Live weekly delta is unavailable. Choose another preset.");
  const strike = autoRollTargetStrike(spot, distance, strikeTick);
  if (strike === null) throw new RangeError("This preset cannot map to the market strike tick.");
  return { otmBps: distance, strike };
}

/** Pick the live weekly call whose current pricing-service delta is nearest 0.15. */
export function closestDelta<T extends { delta: number | null; strike: bigint }>(rows: readonly T[], spot: bigint): T | null {
  return rows.filter((row) => row.delta !== null && Number.isFinite(row.delta) && row.delta! >= 0 && row.strike > spot)
    .sort((a, b) => Math.abs(a.delta! - 0.15) - Math.abs(b.delta! - 0.15) || (a.strike < b.strike ? -1 : 1))[0] ?? null;
}

export type DeltaPresetCandidate<T> = { row: T; delta: number | null; fair: bigint | null; strike: bigint };

/**
 * Resolve both halves of a preset in one operation: the row shown in the manual ask and the
 * longest-dated row used to price future rolls. The sole live fair read is reserved for the
 * pricing reference; when it differs, the manual target keeps its page quote.
 */
export async function resolvePresetPricing<T>(
  id: PresetId,
  rows: readonly (DeltaPresetCandidate<T> & {
    expiry: number;
    tenor: "daily" | "weekly" | "special";
    status: string;
  })[],
  spot: bigint,
  strikeTick: bigint,
  readFair: (row: T) => Promise<bigint | null>,
): Promise<{
  target: T;
  targetStrike: bigint;
  targetFair: bigint | null;
  reference: T | null;
  referenceFair: bigint | null;
  futureRollTarget: bigint;
}> {
  const preset = WRITER_PRESETS.find((row) => row.id === id);
  if (!preset) throw new RangeError("Unknown preset.");
  const tenor = preset.weekly ? "weekly" : "daily";
  const candidates = rows.filter((row) => row.status === "open" && row.tenor === tenor && row.expiry > 0)
    .map((row) => ({ ...row, tenor: row.tenor as "daily" | "weekly" }));
  if (!candidates.length) throw new RangeError("No open series match that expiry type right now.");

  let target: (typeof candidates)[number];
  if (id === "weekly-delta-15") {
    const selected = closestDelta(candidates, spot);
    if (!selected) throw new RangeError("Live weekly delta is unavailable. Choose another preset.");
    target = selected;
  } else {
    const desired = presetAutoRollTarget(id, spot, strikeTick).strike;
    target = [...candidates].sort((a, b) => {
      const aDistance = a.strike > desired ? a.strike - desired : desired - a.strike;
      const bDistance = b.strike > desired ? b.strike - desired : desired - b.strike;
      return aDistance < bDistance ? -1 : aDistance > bDistance ? 1 : a.expiry - b.expiry;
    })[0]!;
  }

  const futureRollTarget = presetAutoRollTarget(id, spot, strikeTick,
    id === "weekly-delta-15" ? target.strike : undefined).strike;
  const reference = selectSmartPricingReference(candidates, preset.weekly, futureRollTarget);
  let referenceFair = reference?.fair ?? null;
  if (reference) {
    try {
      const live = await readFair(reference.row);
      if (live !== null) referenceFair = live;
    } catch { /* Keep the complete-list quote; never spend a second request on the manual row. */ }
  }
  return {
    target: target.row,
    targetStrike: target.strike,
    targetFair: reference === target ? referenceFair : target.fair,
    reference: reference?.row ?? null,
    referenceFair,
    futureRollTarget,
  };
}

/**
 * A preset fills the strategy form; the writer can edit every field before signing. The proposed
 * wide band is filled when a qualified reference exists, but smart pricing stays off until the
 * writer explicitly selects it. Live default activation remains an operating-policy decision.
 */
export function presetStrategy(id: PresetId, spot: bigint, referenceFair: bigint | null, maxUnits: bigint, deltaStrike?: bigint): Strategy {
  const preset = WRITER_PRESETS.find((row) => row.id === id);
  if (!preset) throw new RangeError("Unknown preset.");
  if (spot <= 0n || maxUnits < 0n || maxUnits > (1n << 64n) - 1n) throw new RangeError("Invalid spot or size.");
  const distance = id === "weekly-delta-15" ? (deltaStrike === undefined ? null : otmBps(spot, deltaStrike)) : preset.otmBps;
  if (distance === null) throw new RangeError("Live weekly delta is unavailable. Choose another preset.");
  const band = proposedSmartPricingBand(spot, referenceFair) ?? { referenceBps: 100, askBps: 200, minAskBps: 50, maxAskBps: 200 };
  const fixedAskBps = fixedAskBpsFromReference(spot, referenceFair);
  if (referenceFair !== null && fixedAskBps === null)
    throw new RangeError("The current reference cannot map to a writer-protective fixed ask inside AutoRoller's contract range.");
  return {
    active: true, weekly: preset.weekly, smartPricing: false, otmBps: distance,
    askBps: fixedAskBps ?? Math.max(MIN_ASK_BPS, Math.min(MAX_ASK_BPS, band.referenceBps)),
    minAskBps: band.minAskBps, maxAskBps: band.maxAskBps,
    maxUnits: maxUnits.toString(),
  };
}

/** USDG premium proceeds after the configured seller fee; maker rebates remain separate. */
export type WriterQuote = { gross: bigint; fee: bigint; net: bigint; comparison: string | null };

export function writerQuote(price: bigint, units: bigint, premiumFeeBps: number, fair: bigint | null): WriterQuote {
  if (!Number.isInteger(premiumFeeBps) || premiumFeeBps < 0 || premiumFeeBps > 1_000) throw new RangeError("Invalid premium fee.");
  const gross = premium(price, units);
  const fee = gross * BigInt(premiumFeeBps) / 10_000n;
  let comparison: string | null = null;
  if (fair !== null && fair > 0n) {
    const pct = Number((price > fair ? price - fair : fair - price) * 10_000n / fair) / 100;
    comparison = price === fair ? "At fair value" : `${pct.toFixed(1)}% ${price < fair ? "under" : "over"} fair value`;
  }
  return { gross, fee, net: gross - fee, comparison };
}

/** In net-share settlement, a writer retains K/S shares when a call finishes in the money. */
export function retainedSharesAtExpiry(strike: bigint, settlementSpot: bigint, units: bigint): number {
  if (strike <= 0n || settlementSpot <= 0n || units <= 0n) throw new RangeError("Invalid outcome.");
  return Number(units * (settlementSpot > strike ? strike : settlementSpot)) / Number(settlementSpot) / 100;
}

export function roundAskToTick(price: bigint, tick = 100n): bigint {
  if (price <= 0n || tick <= 0n) throw new RangeError("Ask and tick must be positive.");
  const rounded = (price + tick / 2n) / tick * tick;
  return rounded < tick ? tick : rounded;
}
