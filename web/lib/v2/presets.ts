import type { Strategy } from "./api-types";
import { premium } from "./payoff";

export type PresetId = "weekly-5" | "weekly-delta-15" | "daily-2" | "weekly-10";
export const WRITER_PRESETS: readonly { id: PresetId; label: string; detail: string; weekly: boolean; otmBps: number }[] = [
  { id: "weekly-5", label: "Weekly, +5% OTM", detail: "A weekly call about 5% above spot.", weekly: true, otmBps: 500 },
  { id: "weekly-delta-15", label: "Weekly, ~0.15 delta", detail: "Find the closest live weekly delta and keep smart pricing on.", weekly: true, otmBps: 0 },
  { id: "daily-2", label: "Daily, +2% OTM", detail: "A short daily call about 2% above spot.", weekly: false, otmBps: 200 },
  { id: "weekly-10", label: "Conservative, +10% OTM weekly", detail: "More room above spot, usually a smaller premium.", weekly: true, otmBps: 1_000 },
];

export function otmBps(spot: bigint, strike: bigint): number {
  if (spot <= 0n || strike <= spot) throw new RangeError("The strike must be above the live spot.");
  const value = Number(((strike - spot) * 10_000n + spot / 2n) / spot);
  if (value < 100 || value > 2_500) throw new RangeError("Auto-roll strikes must be 1% to 25% out of the money.");
  return value;
}

/** Pick the live weekly call whose current pricing-service delta is nearest 0.15. */
export function closestDelta<T extends { delta: number | null; strike: bigint }>(rows: readonly T[], spot: bigint): T | null {
  return rows.filter((row) => row.delta !== null && Number.isFinite(row.delta) && row.delta! >= 0 && row.strike > spot)
    .sort((a, b) => Math.abs(a.delta! - 0.15) - Math.abs(b.delta! - 0.15) || (a.strike < b.strike ? -1 : 1))[0] ?? null;
}

/** A preset fills the strategy form; the writer can edit every field before signing. */
export function presetStrategy(id: PresetId, spot: bigint, fair: bigint | null, maxUnits: bigint, deltaStrike?: bigint): Strategy {
  const preset = WRITER_PRESETS.find((row) => row.id === id);
  if (!preset) throw new RangeError("Unknown preset.");
  if (spot <= 0n || maxUnits < 0n || maxUnits > (1n << 64n) - 1n) throw new RangeError("Invalid spot or size.");
  const distance = id === "weekly-delta-15" ? (deltaStrike === undefined ? null : otmBps(spot, deltaStrike)) : preset.otmBps;
  if (distance === null) throw new RangeError("Live weekly delta is unavailable. Choose another preset.");
  const reference = fair && fair > 0n ? Number(fair * 10_000n / spot) : 100;
  const askBps = Math.max(5, Math.min(1_000, Math.round(reference)));
  return {
    active: true, weekly: preset.weekly, smartPricing: true, otmBps: distance, askBps,
    minAskBps: Math.max(5, Math.floor(askBps / 2)), maxAskBps: Math.min(1_000, askBps * 2),
    maxUnits: maxUnits.toString(),
  };
}

/** USDG premium proceeds only. Show native-asset writer rent and maker rebates separately. */
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
