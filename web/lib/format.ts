import { formatUnits, parseUnits } from "viem";

import { ASSET_DECIMALS, LOT_SIZE, SHARE_DECIMALS, USDG_DECIMALS } from "./contracts";

export const WAD = 10n ** 18n;
const BPS = 10_000n;

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

/** A WAD (1e18) share as a percentage: 0.25e18 → "25.00%". */
export function fmtWadPercent(wad: bigint | undefined | null): string {
  if (wad === undefined || wad === null) return "—";
  return `${formatAmount(wad * 100n, 18, 2)}%`;
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
 * The listing's price
 *
 * Every listing has ONE consideration leg, USDG to the vault, and the vault enforces
 * `gross % amount == 0` at approveListing so a partial fill of k of N pays exactly gross × k / N.
 * There is no third-party fee leg: gross and net premium are the same figure, and what the buyer
 * pays is what the vault receives (the protocol fee is taken later, at harvest).
 * ----------------------------------------------------------------------------------------- */

/** The per-contract price of a listing, or undefined for an empty one. Exact by construction. */
export function unitPriceUsdg(grossUsdg6: bigint | undefined, contracts: bigint | undefined): bigint | undefined {
  if (grossUsdg6 === undefined || contracts === undefined || contracts === 0n) return undefined;
  return grossUsdg6 / contracts;
}

/* -------------------------------------------------------------------------------------------
 * Policy maths, mirrored from contracts/src/Policy.sol
 *
 * The vault re-runs these at every fill against TODAY's spot (ValoremLib.writeOnFill). The page
 * shows the same figures so a buyer can see a refusal coming; the pre-flight simulation is the
 * authority, this is the explanation beside it. If Policy.sol changes, these change.
 * ----------------------------------------------------------------------------------------- */

export type PolicyBps = {
  minOtmBps: number;
  maxOtmBps: number;
  minPremiumBps: number;
  maxUtilizationBps: number;
  protocolFeeBps: number;
  maxContractsCap: bigint;
};

/**
 * Contracts the vault may have written in total this cycle against `nav` (its totalAssets()),
 * Policy.maxContracts: the utilisation ceiling in whole lots, capped at maxContractsCap.
 */
export function maxContracts(nav18: bigint | undefined, policy: PolicyBps | undefined): bigint | undefined {
  if (nav18 === undefined || policy === undefined) return undefined;
  const byUtilization = (nav18 * BigInt(policy.maxUtilizationBps)) / BPS / LOT_SIZE;
  return byUtilization < policy.maxContractsCap ? byUtilization : policy.maxContractsCap;
}

/**
 * Contracts the vault can still write this cycle: `maxContracts(totalAssets()) − contractsWritten`.
 * There is no inventory under write on fill; this is the whole of what is for sale, and every
 * fill is re-sized against it at the hook.
 */
export function capacityContracts(
  nav18: bigint | undefined,
  contractsWritten: bigint | undefined,
  policy: PolicyBps | undefined,
): bigint | undefined {
  const cap = maxContracts(nav18, policy);
  if (cap === undefined || contractsWritten === undefined) return undefined;
  return cap > contractsWritten ? cap - contractsWritten : 0n;
}

/** The inclusive [min, max] strike window for a spot, Policy.strikeBand. */
export function strikeBand(spotUsdg6: bigint | undefined, policy: PolicyBps | undefined): { min: bigint; max: bigint } | undefined {
  if (spotUsdg6 === undefined || spotUsdg6 === 0n || policy === undefined) return undefined;
  return {
    min: (spotUsdg6 * (BPS + BigInt(policy.minOtmBps))) / BPS,
    max: (spotUsdg6 * (BPS + BigInt(policy.maxOtmBps))) / BPS,
  };
}

/**
 * The premium floor the fill gate applies to a fill of `contracts` at `spot`, Policy.minPremium.
 * Valorem's engine fee (15 bps of notional, valued at spot) is added on top when it is switched
 * on; that term is omitted here because the fee is off on the deployed Clear and the simulation
 * is the authority when it is not.
 */
export function minPremiumUsdg(spotUsdg6: bigint | undefined, contracts: bigint, policy: PolicyBps | undefined): bigint | undefined {
  if (spotUsdg6 === undefined || spotUsdg6 === 0n || policy === undefined) return undefined;
  return (spotUsdg6 * contracts * BigInt(policy.minPremiumBps)) / BPS;
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
 * Every deadline on this site comes from the option type the vault armed — `cycleExerciseTs`
 * and `cycleExpiryTs`, snapshotted from the clearinghouse at rollOpen — never from a hardcoded
 * "Friday 20:00". The keeper chooses the type; the vault records it; a wall clock knows neither.
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

/**
 * The same instant in New York, the clock the keeper builds the week's option type against: the
 * exercise time is the NYSE close, 16:00 America/New_York (a Thursday before a Friday market
 * holiday), and expiry is 24 hours later. That is 20:00 UTC while daylight time holds and 21:00
 * UTC from November, which is why the UTC figure alone reads as if the close moved. Rendered
 * beside the UTC figure, never instead of it, and always with the zone name (EDT or EST) so the
 * offset in force is on screen. Display only: the timestamp itself is the chain's.
 */
export function fmtEastern(ts: number | bigint | undefined | null): string {
  if (ts === undefined || ts === null) return "—";
  const seconds = typeof ts === "bigint" ? Number(ts) : ts;
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(new Date(seconds * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  // Intl renders midnight as "24" under hour12: false in some ICU builds; the chain's clock is
  // 0..23 and so is this.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")} ${get("timeZoneName")}`;
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

/* -------------------------------------------------------------------------------------------
 * Deposit and queue states that change what the forms must say
 * ----------------------------------------------------------------------------------------- */

/**
 * How exposed a deposit made right now is to this week's short call.
 *
 *  - "none":   not Listed (or unread). Idle is flat; Exercisable and Settling refuse deposits.
 *  - "listed": a call is armed and may be selling. Shares are priced on a NAV that values the
 *              short call at zero, so an assigned week is socialised across every share, a
 *              deposit made now included, and every later fill this week is sized against a
 *              balance that includes it (decision D8: Listed deposits allowed, risk disclosed).
 *  - "near":   as "listed", and live spot is already at or above strike × (1 − minOtmBps). That
 *              is the point where the vault would no longer arm this strike, i.e. the call is
 *              close to (or already) in the money.
 *
 * Spot and strike are both USDG base units per lot. A stale feed (spot undefined) cannot prove
 * "near", so it falls back to "listed" rather than guessing either way.
 */
export type ListedDepositRisk = "none" | "listed" | "near";

export function listedDepositRisk(v: {
  phase?: number;
  cycleStrikeUsdg?: bigint;
  spotUsdg?: bigint;
  minOtmBps?: number;
}): ListedDepositRisk {
  if (v.phase !== 1) return "none";
  const strike = v.cycleStrikeUsdg;
  if (strike === undefined || strike === 0n || v.spotUsdg === undefined || v.minOtmBps === undefined) {
    return "listed";
  }
  const threshold = (strike * BigInt(10_000 - v.minOtmBps)) / 10_000n;
  return v.spotUsdg >= threshold ? "near" : "listed";
}

/**
 * Why deposits are closed right now, from what the page has read, or undefined when they are
 * open as far as it can tell. Mirrors Vault._depositRefused, whose single `DepositsClosed`
 * error carries no argument on purpose; `maxDeposit() == 0` is the chain's own word (checked by
 * the form as well), and this names the reason beside it. The share-price floor (a dead book)
 * is not derivable from the snapshot and is left to `maxDeposit`.
 */
export type DepositsClosedReason = "phase" | "window" | "assignmentPending" | "stranded" | "reserveUnbacked";

export function depositsClosedReason(
  v: {
    phase?: number;
    cycleExerciseTs?: number;
    claimKey?: bigint;
    contractsAssigned?: bigint;
    assetHeld?: bigint;
    reservedAssets?: bigint;
  },
  nowSeconds: number,
): DepositsClosedReason | undefined {
  if (v.phase === undefined) return undefined;
  if (v.phase !== 0 && v.phase !== 1) return "phase";
  if (v.phase === 1 && v.cycleExerciseTs !== undefined && nowSeconds > 0 && nowSeconds >= v.cycleExerciseTs) return "window";
  const claim = v.claimKey ?? 0n;
  if (claim !== 0n && v.phase === 0) return "stranded";
  if (claim !== 0n && (v.contractsAssigned ?? 0n) > 0n) return "assignmentPending";
  if (v.assetHeld !== undefined && v.reservedAssets !== undefined && v.assetHeld < v.reservedAssets) return "reserveUnbacked";
  return undefined;
}

/**
 * Whether this account's queue entry can be settled with the permissionless `settleQueue()`.
 *
 * Only while the vault is Idle, and only for an entry in the CURRENT epoch: an entry whose epoch
 * is below `epochId` was already settled and is collected with `completeRedeem`. Without this
 * path a queue entered while flat waited for a `rollClose` that needs a fresh `rollOpen`, and a
 * week that never gets armed (halted, stale oracle, less than one lot idle) held it indefinitely.
 * While a claim is stranded this is also the exit: the entry is paid its slice of the idle
 * balance now and its share of the claim when `retryStrandedClaim` succeeds.
 */
export function canSettleQueue(v: {
  phase?: number;
  epochId?: bigint;
  queuedShares?: bigint;
  queuedEpoch?: bigint;
}): boolean {
  return (
    v.phase === 0 &&
    (v.queuedShares ?? 0n) > 0n &&
    v.epochId !== undefined &&
    v.queuedEpoch !== undefined &&
    v.queuedEpoch === v.epochId
  );
}
