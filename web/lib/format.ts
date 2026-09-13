import { formatUnits, parseUnits } from "viem";

import { ASSET_DECIMALS, OVERCALL_FEE_BPS, SHARE_DECIMALS, USDG_DECIMALS } from "./contracts";

export const WAD = 10n ** 18n;

/* -------------------------------------------------------------------------------------------
 * Number formatting
 *
 * House rule: a number on this site is either a real on-chain quantity or an em dash. There is
 * no estimate, no forecast, and no weekly figure multiplied out to a year. The only performance
 * number the product is allowed to publish is what actually landed last week.
 * ----------------------------------------------------------------------------------------- */

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Fixed-decimal formatting with thousands separators and no scientific notation. */
export function formatAmount(
  value: bigint | undefined | null,
  decimals: number,
  displayDecimals: number,
): string {
  if (value === undefined || value === null) return "—";
  const negative = value < 0n;
  const raw = formatUnits(negative ? -value : value, decimals);
  const [whole, frac = ""] = raw.split(".");
  let out = group(whole);
  if (displayDecimals > 0) {
    const padded = (frac + "0".repeat(displayDecimals)).slice(0, displayDecimals);
    out = `${out}.${padded}`;
  }
  return negative ? `-${out}` : out;
}

/** USDG has 6 decimals. Two shown by default — it is a dollar-like unit. */
export function fmtUsdg(value: bigint | undefined | null, displayDecimals = 2): string {
  return formatAmount(value, USDG_DECIMALS, displayDecimals);
}

/** Stock Tokens have 18 decimals. Four shown: a lot is 1.0000 and fractions matter. */
export function fmtAsset(value: bigint | undefined | null, displayDecimals = 4): string {
  return formatAmount(value, ASSET_DECIMALS, displayDecimals);
}

/** Vault shares (cNVDA) are 18 decimals, same as the asset. */
export function fmtShares(value: bigint | undefined | null, displayDecimals = 4): string {
  return formatAmount(value, SHARE_DECIMALS, displayDecimals);
}

/** Parse user input into base units. Returns null on anything that is not a clean number. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d*\.?\d*$/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "") return null;
  const [, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;
  try {
    const parsed = parseUnits(trimmed as `${number}`, decimals);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function shortAddress(address: string | undefined | null): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string | undefined | null): string {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

/* -------------------------------------------------------------------------------------------
 * The uiMultiplier display rule (ERC-8056)
 * ----------------------------------------------------------------------------------------- */

/**
 * "NVDA-eq" = raw balance × uiMultiplier() / 1e18.
 *
 * DISPLAY ONLY. The Stock Token uses the multiplier to express splits and dividend adjustments
 * without rebasing anyone's balance. The vault's share maths, the deposit cap, the lot count and
 * every transaction this UI builds all use the RAW balance. If the two ever disagree on screen,
 * the raw number is the one that moved the money.
 */
export function toNvdaEq(raw: bigint | undefined | null, uiMultiplier: bigint | undefined | null): bigint | undefined {
  if (raw === undefined || raw === null) return undefined;
  const m = uiMultiplier ?? WAD;
  if (m === 0n) return undefined;
  return (raw * m) / WAD;
}

/** True when the token's multiplier is anything other than 1.0 — i.e. worth showing at all. */
export function multiplierIsActive(uiMultiplier: bigint | undefined | null): boolean {
  return uiMultiplier !== undefined && uiMultiplier !== null && uiMultiplier !== WAD;
}

/** The multiplier itself, as a bare ratio like "1.0000". */
export function fmtMultiplier(uiMultiplier: bigint | undefined | null): string {
  return formatAmount(uiMultiplier ?? WAD, 18, 4);
}

/* -------------------------------------------------------------------------------------------
 * Realized weekly figures
 *
 * Two different numbers, and they are not interchangeable:
 *   premiumPerShare — net premium a holder of one cNVDA received. Denominated in USDG.
 *   realizedWeek    — net premium / TVL in USD at harvest. A fraction of the book.
 *
 * Neither is ever multiplied by 52. A week with no buyer is 0, and 0 is a result, not a gap.
 *
 * PREMIUM ONLY (W-21). On an assigned week the harvest also sweeps the strike proceeds — the
 * USDG the collateral taken at the strike was sold for. That is returned principal, not yield,
 * and passing it to either function below turned a 43.32 USDG week into a 993.32 USDG one.
 * Pass `CycleRow.premiumNetUsdg`, never `creditedUsdg` or `harvestGrossUsdg`; the strike
 * proceeds are shown on their own line.
 * ----------------------------------------------------------------------------------------- */

/**
 * A USDG amount per ONE whole share, in USDG base units (6 dec).
 * `shares` is the vault's total supply at harvest (18 dec).
 */
export function usdgPerShare(usdg6: bigint | undefined, shares18: bigint | undefined): bigint | undefined {
  if (usdg6 === undefined) return undefined;
  // An unfilled week is exactly zero per share, and it is knowable without a denominator.
  // Returning undefined there would render an em dash and read like missing data.
  if (usdg6 === 0n) return 0n;
  if (shares18 === undefined || shares18 === 0n) return undefined;
  return (usdg6 * WAD) / shares18;
}

/**
 * Net premium per ONE whole share for a week, in USDG base units. Prefers the indexer's own
 * figure, summed per sweep against each sweep's supply (exact across a mid-week deposit), and
 * falls back to `premiumNetUsdg / sharesAtHarvest` for a row rebuilt from logs. Strike proceeds
 * are never in either. Undefined, and so a dash, when the week's premium is not known.
 */
export function premiumPerShare(row: {
  premiumNetPerShare?: bigint;
  premiumNetUsdg?: bigint;
  sharesAtHarvest?: bigint;
}): bigint | undefined {
  if (row.premiumNetPerShare !== undefined) return row.premiumNetPerShare;
  return usdgPerShare(row.premiumNetUsdg, row.sharesAtHarvest);
}

/**
 * TVL in USDG base units = assets (18 dec) × spot per lot (USDG 6 dec) / 1e18.
 * Spot comes from the vault's own price feed read, the same one that gates a write. It is a
 * display and gate input only; settlement never reads a price.
 */
export function tvlUsdg(assets18: bigint | undefined, spotUsdg6: bigint | undefined): bigint | undefined {
  if (assets18 === undefined || spotUsdg6 === undefined) return undefined;
  return (assets18 * spotUsdg6) / WAD;
}

/**
 * The realized-week figure: net PREMIUM / TVL in USD at harvest, as a percent string. Strike
 * proceeds are never an input (see the block comment above).
 * Returns "0.000%" for an unfilled week, because that is the honest answer.
 */
export function fmtRealizedWeek(premiumNetUsdg6: bigint | undefined, tvlUsdg6: bigint | undefined): string {
  if (premiumNetUsdg6 === undefined || tvlUsdg6 === undefined || tvlUsdg6 === 0n) return "—";
  // 1e5 keeps three decimal places of a percent through integer maths.
  const bps100k = (premiumNetUsdg6 * 100n * 100000n) / tvlUsdg6;
  return `${formatAmount(bps100k, 5, 3)}%`;
}

/* -------------------------------------------------------------------------------------------
 * The Overcall fee split — THE rounding rule
 * ----------------------------------------------------------------------------------------- */

export type PremiumSplit = {
  unitPrice6: bigint;
  contracts: bigint;
  feePerContract6: bigint;
  writerPerContract6: bigint;
  /** consideration[1] — Overcall's 5% leg. */
  feeTotal6: bigint;
  /** consideration[0] — the vault's leg. */
  writerTotal6: bigint;
  /** What the buyer pays in total. */
  gross6: bigint;
  /** False when the 5% leg floors to zero and Overcall's schema would reject the order. */
  listable: boolean;
};

/**
 * Split a premium the way Overcall does: round PER CONTRACT, then multiply.
 *
 *   feePerContract6    = floor(unitPrice6 * 500 / 10000)
 *   writerPerContract6 = unitPrice6 - feePerContract6
 *   consideration[1]   = feePerContract6    * N
 *   consideration[0]   = writerPerContract6 * N
 *
 * WHY it has to be this way round: every Overcall listing is orderType 1 (PARTIAL_OPEN). Seaport
 * fills a fraction k/N by scaling each item amount, and reverts with InexactFraction if any
 * amount is not exactly divisible. Rounding the TOTAL produces an order that signs fine and
 * validates fine, and then silently cannot be partially filled — which on a thin book is the
 * difference between a fill and an unfilled week.
 *
 * `listable` is false below unitPrice6 = 20, where 5% floors to zero and Overcall's schema
 * rejects the order outright ("A consideration item must carry a non-zero amount").
 *
 * This mirrors Policy.splitPremium() in contracts/src/Policy.sol. If one changes, both change.
 */
export function splitPremium(unitPrice6: bigint, contracts: bigint): PremiumSplit {
  const feePerContract6 = (unitPrice6 * OVERCALL_FEE_BPS) / 10_000n;
  const writerPerContract6 = unitPrice6 - feePerContract6;
  return {
    unitPrice6,
    contracts,
    feePerContract6,
    writerPerContract6,
    feeTotal6: feePerContract6 * contracts,
    writerTotal6: writerPerContract6 * contracts,
    gross6: unitPrice6 * contracts,
    listable: unitPrice6 >= 20n && contracts > 0n,
  };
}

/** Recover the per-contract unit price from a listing's two consideration legs. */
export function unitPriceFromLegs(
  writerTotal6: bigint,
  feeTotal6: bigint,
  contracts: bigint,
): bigint | undefined {
  if (contracts === 0n) return undefined;
  return (writerTotal6 + feeTotal6) / contracts;
}

/* -------------------------------------------------------------------------------------------
 * Valorem claim scalars
 * ----------------------------------------------------------------------------------------- */

/**
 * Valorem's `claim(claimId)` returns amountWritten / amountExercised as 1e18-SCALED SCALARS,
 * not contract counts. 3 contracts written reads as 3e18. Divide before showing a human.
 */
export function scaleToContracts(scaled: bigint | undefined): bigint | undefined {
  if (scaled === undefined) return undefined;
  return scaled / WAD;
}

/* -------------------------------------------------------------------------------------------
 * Time
 *
 * Every deadline on this site comes from the Overcall registry (exerciseTimestamp /
 * expiryTimestamp), never from a hardcoded "Friday 20:00". The registry owner can move a cycle;
 * a wall clock cannot know that.
 * ----------------------------------------------------------------------------------------- */

export function fmtUtc(ts: number | bigint | undefined | null): string {
  if (ts === undefined || ts === null) return "—";
  const seconds = typeof ts === "bigint" ? Number(ts) : ts;
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

export function fmtUtcDate(ts: number | bigint | undefined | null): string {
  if (ts === undefined || ts === null) return "—";
  const seconds = typeof ts === "bigint" ? Number(ts) : ts;
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "2d 04h 11m 07s", or "elapsed" once the deadline is behind us. */
export function fmtCountdown(targetSeconds: number | undefined, nowSeconds: number): string {
  if (targetSeconds === undefined || targetSeconds <= 0) return "—";
  let remaining = targetSeconds - nowSeconds;
  if (remaining <= 0) return "elapsed";
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return days > 0
    ? `${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`
    : `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/** Fraction of the window already elapsed, clamped to 0..1, for the progress rail. */
export function windowProgress(startSeconds: number, endSeconds: number, nowSeconds: number): number {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return 0;
  const p = (nowSeconds - startSeconds) / (endSeconds - startSeconds);
  return Math.max(0, Math.min(1, p));
}
