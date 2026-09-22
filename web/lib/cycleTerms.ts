import { fmtEastern, fmtUsdg, fmtUtc, unitPriceUsdg } from "./format";
import type { VaultSnapshot } from "./hooks";

/**
 * This cycle's terms as FIGURES: bigints and the strings they format to. No sentences.
 *
 * WHY THIS FILE EXISTS: several pages show the same week (the strike, the two deadlines, the unit
 * price, what the open order comes to if every remaining contract sells, and the protocol fee on
 * that). Deriving each figure once, here, means two pages cannot round the fee differently or
 * print the exercise time in a different zone. The words around the figures live in the page and
 * component files, which copy-lint scanned until its removal on 2026-09-21; `CYCLE_TERMS_LABELS` below is the only wording pinned
 * here, and its test runs it through the forbidden-copy table now inlined in that test.
 *
 * WHAT IS AND IS NOT A FIGURE HERE. Everything below is either a value the chain holds (strike,
 * deadlines, contracts written, the vault's listing slot, the fee in policy), an exact product of
 * those (unit price × fillable contracts, the floored fee on it), the live spot the vault's own
 * gate reads, or the keeper's report of how it priced the listing. There is no forecast: "if every
 * remaining contract sells" is the arithmetic of the order as it stands, and a week in which nobody
 * buys pays nothing. No percentage of anything, no per-year figure, nothing after fees framed as
 * what reaches depositors, and the strike's distance from spot is given in USDG only, so it cannot
 * be read as a return.
 *
 * DELIBERATELY ABSENT: React, fetch, a clock, and general-purpose formatters (lib/format.ts owns
 * those). The two local helpers below only choose how many decimals fmtUsdg prints, and how a feed's
 * float is cut to a fixed width; they do not format anything format.ts does not.
 *
 * MONEY DISPLAY. Every USDG figure here is shown exactly: two decimals when it is whole cents, all
 * six otherwise, because fmtUsdg truncates and a truncated figure is a wrong figure. That includes
 * spot, so strike − spot = distance holds on screen digit for digit.
 */

const BPS = 10_000n;
const DASH = "—";

/** Exact USDG: two decimals when the value is whole cents, six when it is not. Wraps fmtUsdg. */
function exactUsdg(value: bigint | undefined): string {
  if (value === undefined) return DASH;
  return fmtUsdg(value, value % 10_000n === 0n ? 2 : 6);
}

function count(value: bigint | undefined): string {
  return value === undefined ? DASH : value.toString();
}

/* -------------------------------------------------------------------------------------------
 * Wording
 * ----------------------------------------------------------------------------------------- */

/**
 * Row labels for the figures below, for a page that wants the same words everywhere. Optional:
 * a page may write its own. Pinned by lib/cycleTerms.test.ts against the forbidden-copy table
 * (inlined there since copy-lint was removed on 2026-09-21) and against return, profit and per-year framing:
 * the order figures are the listing's own arithmetic, not an outcome for anyone. There is no
 * "after fee" figure: the fee is charged at harvest on the week's premium, not on an order, and a
 * total less the fee reads as what a depositor receives.
 */
export const CYCLE_TERMS_LABELS = {
  strike: "Strike",
  spot: "Spot",
  strikeAboveSpot: "Strike minus spot",
  exercise: "Exercise deadline",
  expiry: "Expiry",
  unitPrice: "Price per contract",
  contractsSold: "Contracts sold this cycle",
  fillableContracts: "Contracts left to buy",
  orderGrossIfAllFill: "Order total if every remaining contract sells",
  orderFeeIfAllFill: "Protocol fee on that total, charged at harvest",
} as const;

/* -------------------------------------------------------------------------------------------
 * cycleTerms
 * ----------------------------------------------------------------------------------------- */

/** The snapshot fields cycleTerms reads. A full VaultSnapshot satisfies it. */
export type CycleTermsInput = Pick<
  VaultSnapshot,
  | "phase"
  | "cycleStrikeUsdg"
  | "cycleExerciseTs"
  | "cycleExpiryTs"
  | "spotUsdg"
  | "listingGrossUsdg"
  | "listingAmount"
  | "contractsWritten"
  | "capacity"
  | "policy"
>;

export type CycleTermsOptions = {
  /**
   * Per-contract price, USDG base units. Used ONLY when the vault's listing slot has no price
   * (listingAmount 0 or unread), e.g. from a listing row the caller has already checked with
   * checkListingIsOurs. The vault's slot (listingGrossUsdg / listingAmount) always wins.
   */
  unitPrice6?: bigint;
  /**
   * Contracts a buyer can take right now. The CALLER computes it, from Seaport's getOrderStatus
   * for the vault's listingHash capped by the vault's capacity, as components/OrderPayload.tsx
   * does; the keeper row's `remaining` is not an input. Capped here again at the vault's capacity
   * and at the listing's own size (listingAmount), which is idempotent for a correct caller, and
   * ignored while capacity is unread: an uncapped caller figure is never shown.
   */
  fillableContracts?: bigint;
};

export type CycleTerms = {
  /** 1 Listed, 2 Exercisable, 3 Settling. */
  phase: number;
  /** Strike per contract (one token), USDG base units: the vault's cycleStrikeUsdg. */
  strikeUsdg: bigint;
  strikeFmt: string;
  /** vault.spotUsdg(), per token. Undefined when the feed is stale (the read reverts). */
  spotUsdg: bigint | undefined;
  spotFmt: string;
  /** strike − spot, USDG base units. Negative once spot is above the strike. */
  strikeAboveSpotUsdg: bigint | undefined;
  strikeAboveSpotFmt: string;
  /** The cycle's exercise time (the week's NYSE close), from the vault's snapshot. */
  exerciseTs: number;
  exerciseUtc: string;
  exerciseEastern: string;
  /** The option's expiry, 24 hours after exercise, from the vault's snapshot. */
  expiryTs: number;
  expiryUtc: string;
  expiryEastern: string;
  /** Per-contract price, USDG base units; undefined when there is no priced listing. */
  unitPrice6: bigint | undefined;
  unitPriceFmt: string;
  /** Contracts written this cycle, which under write on fill is contracts sold. */
  contractsSold: bigint | undefined;
  contractsSoldFmt: string;
  /**
   * The caller's fillable figure, capped at capacity and the listing's size. Undefined outside
   * Listed (the listing ends at exercise, so nothing can sell), and while capacity is unread.
   */
  fillableContracts: bigint | undefined;
  fillableContractsFmt: string;
  /** policy.protocolFeeBps, the only fee applied here. Undefined until policy is read. */
  feeBps: number | undefined;
  /** unitPrice6 × fillableContracts. */
  orderGrossIfAllFill6: bigint | undefined;
  orderGrossIfAllFillFmt: string;
  /** floor(gross × feeBps / 10000), the rounding of Policy.splitHarvest. Charged at harvest. */
  orderFeeIfAllFill6: bigint | undefined;
  orderFeeIfAllFillFmt: string;
};

const PHASE_LISTED = 1;

function validTs(ts: number | undefined): ts is number {
  return ts !== undefined && Number.isSafeInteger(ts) && ts > 0;
}

function validFeeBps(bps: number | undefined): bps is number {
  return bps !== undefined && Number.isInteger(bps) && bps >= 0 && bps <= 10_000;
}

/**
 * The protocol fee on a gross premium, floored exactly as Policy.splitHarvest floors it. The
 * vault charges it at harvest on the week's whole premium, so the fee on one order's figure can
 * differ from its share of the week's fee by a base unit of rounding.
 */
export function protocolFeeOn(gross6: bigint, feeBps: number): bigint {
  return (gross6 * BigInt(feeBps)) / BPS;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * This cycle's terms, or null when nothing is armed: phase unread, Idle or not a phase (1..3),
 * or the strike or either deadline unread or zero.
 */
export function cycleTerms(snapshot: CycleTermsInput, options: CycleTermsOptions = {}): CycleTerms | null {
  const { phase, cycleStrikeUsdg: strike, cycleExerciseTs: exerciseTs, cycleExpiryTs: expiryTs } = snapshot;
  if (phase === undefined || !Number.isInteger(phase) || phase < 1 || phase > 3) return null;
  if (strike === undefined || strike <= 0n) return null;
  if (!validTs(exerciseTs) || !validTs(expiryTs)) return null;

  const spot = snapshot.spotUsdg !== undefined && snapshot.spotUsdg > 0n ? snapshot.spotUsdg : undefined;
  const strikeAboveSpot = spot === undefined ? undefined : strike - spot;

  const listingAmount = snapshot.listingAmount !== undefined && snapshot.listingAmount > 0n ? snapshot.listingAmount : undefined;
  const fromVault = listingAmount !== undefined ? unitPriceUsdg(snapshot.listingGrossUsdg, listingAmount) : undefined;
  const fromCaller = options.unitPrice6 !== undefined && options.unitPrice6 > 0n ? options.unitPrice6 : undefined;
  const unitPrice6 = fromVault !== undefined && fromVault > 0n ? fromVault : fromCaller;

  // Order figures exist only while the order can sell (Listed), and only capped by what the vault
  // says: its capacity (required) and, when the slot is set, the listing's own size.
  let fillable: bigint | undefined;
  if (
    phase === PHASE_LISTED &&
    options.fillableContracts !== undefined &&
    options.fillableContracts >= 0n &&
    snapshot.capacity !== undefined
  ) {
    fillable = minBig(options.fillableContracts, snapshot.capacity < 0n ? 0n : snapshot.capacity);
    if (listingAmount !== undefined) fillable = minBig(fillable, listingAmount);
  }

  const feeBps = validFeeBps(snapshot.policy?.protocolFeeBps) ? snapshot.policy.protocolFeeBps : undefined;
  const gross = unitPrice6 !== undefined && fillable !== undefined ? unitPrice6 * fillable : undefined;
  const fee = gross !== undefined && feeBps !== undefined ? protocolFeeOn(gross, feeBps) : undefined;

  return {
    phase,
    strikeUsdg: strike,
    strikeFmt: exactUsdg(strike),
    spotUsdg: spot,
    spotFmt: exactUsdg(spot),
    strikeAboveSpotUsdg: strikeAboveSpot,
    strikeAboveSpotFmt: exactUsdg(strikeAboveSpot),
    exerciseTs,
    exerciseUtc: fmtUtc(exerciseTs),
    exerciseEastern: fmtEastern(exerciseTs),
    expiryTs,
    expiryUtc: fmtUtc(expiryTs),
    expiryEastern: fmtEastern(expiryTs),
    unitPrice6,
    unitPriceFmt: exactUsdg(unitPrice6),
    contractsSold: snapshot.contractsWritten,
    contractsSoldFmt: count(snapshot.contractsWritten),
    fillableContracts: fillable,
    fillableContractsFmt: count(fillable),
    feeBps,
    orderGrossIfAllFill6: gross,
    orderGrossIfAllFillFmt: exactUsdg(gross),
    orderFeeIfAllFill6: fee,
    orderFeeIfAllFillFmt: exactUsdg(fee),
  };
}

/* -------------------------------------------------------------------------------------------
 * The keeper's pricing report
 * ----------------------------------------------------------------------------------------- */

/**
 * The `pricing` object the keeper serves beside each listing on GET /orders and for the live
 * cycle on GET /state: its PricingRecord (keeper/src/policy.ts), stored as JSON with the listing.
 * INFORMATIONAL ONLY. Nothing here reaches a transaction or overrides a chain figure; the strike
 * and price a buyer pays are the vault's. So the guard is strict and total: anything malformed or
 * internally inconsistent makes keeperPricingFigures return null (never throw) and the page shows
 * nothing. The shape is pinned against the keeper's own planWeek / priceListing output by
 * lib/cycleTerms.test.ts, so the two sides cannot drift apart silently.
 *
 * Accepted shape (own keys only; extra keys are ignored). USDG figures are decimal strings of base
 * units, the keeper's convention for bigints.
 *
 *   mode                  "vol" | "fixed"                                            required
 *   source                quote source label ("cboe-delayed")      required in vol, else null
 *   priceSource           "fill-floor" | "vol-fair" | "vol-previous-fair" | "manual-override"
 *   volPath               "fresh" | "previous-fair" | null                  null in fixed mode
 *   volUnavailableReason  the keeper's reason code (e.g. "vol-stale") | null
 *   targetDelta           number in [0.01, 0.99]                   required in vol, else null
 *   deltaAtStrike         number in [0, 1] | null
 *   ivAtStrike            implied volatility as a decimal in [0, 5] | null
 *   strikeUsdg6           the armed strike                                            required
 *   deltaStrikeUsdg6      the delta strike before the band clamp | null
 *   strikeClamped         null | "band-floor" | "band-ceiling"
 *   bandBufferBps         integer bps | null
 *   fairUnit6             market fair value per contract | null
 *   volUnit6              fairUnit6 lifted by the edge | null
 *   floorUnit6            the vault's fill floor per contract                          required
 *   marginUnit6           floorUnit6 lifted by the margin                              required
 *   unitPrice6            the ask per contract                                         required
 *   edgeBps               integer bps                              required in vol, else null
 *   marginBps             integer bps                                                  required
 *   shareSpot             the listed share's price, dollars, (0, 1e6) | null
 *   spotUsdg6             the vault's token spot the record was priced on, ≥ 1 USDG    required
 *   expiry                the listed expiry priced against, YYYY-MM-DD | null
 *   chainTimestamp        when the quote file was generated | null
 *   lastTradeTime         the underlying's last trade | null
 *
 * `tokenSpot` (the same spot as a float) and `strikeOtmBps` (a distance in bps, which a page could
 * print as a percentage) are deliberately not read: spotUsdg6 is the exact value, and the distance
 * is given in USDG.
 *
 * TIMES are unix seconds, an ISO-8601 string with a zone (Z or ±hh:mm), or, for source
 * "cboe-delayed" only, Cboe's own zone-less strings, converted by the zones the keeper measured and
 * documents (keeper/README.md, "Market data (vol mode)"): the file `timestamp` is UTC and
 * `last_trade_time` is the New York wall clock. A zone-less time from any other source is kept as
 * reported and not converted. Every instant must fall in 2020..2099.
 *
 * CONSISTENCY, each a null on failure, so no two figures on screen can disagree:
 *   marginUnit6 = ceil(floorUnit6 × (1e4 + marginBps) / 1e4)
 *   volUnit6    = ceil(fairUnit6 × (1e4 + edgeBps) / 1e4), present exactly when fairUnit6 is
 *   floorUnit6 ≤ unitPrice6 ≤ strikeUsdg6
 *   fill-floor         unitPrice6 = marginUnit6, and volUnit6 (if any) ≤ marginUnit6
 *   vol-fair           vol mode, volPath fresh,         unitPrice6 = volUnit6 > marginUnit6
 *   vol-previous-fair  vol mode, volPath previous-fair, unitPrice6 = volUnit6 > marginUnit6
 *   volPath fresh      fairUnit6, expiry and chainTimestamp present
 *   volPath previous   fairUnit6 present; no chain figures (they would date a fair value wrongly)
 *   volPath null       no fair value and no chain figures
 */
export type PriceSource = "fill-floor" | "vol-fair" | "vol-previous-fair" | "manual-override";
export type StrikeClamp = "band-floor" | "band-ceiling" | null;

/** A keeper-reported instant. `ts` and the converted strings exist only when the zone is known. */
export type ReportedTime = {
  raw: string;
  ts: number | undefined;
  utc: string;
  eastern: string;
};

export type KeeperPricingFigures = {
  mode: "vol" | "fixed";
  /** Undefined in fixed mode. */
  source: string | undefined;
  priceSource: PriceSource;
  volPath: "fresh" | "previous-fair" | undefined;
  volUnavailableReason: string | undefined;

  /** The delta the strike was picked at; undefined in fixed mode. */
  targetDelta: number | undefined;
  /** Four decimals, truncated. */
  targetDeltaFmt: string;
  deltaAtStrike: number | undefined;
  deltaAtStrikeFmt: string;
  /** Implied volatility as a decimal, e.g. 0.3266, never a percent string. */
  ivAtStrike: number | undefined;
  ivAtStrikeFmt: string;

  strikeUsdg6: bigint;
  strikeFmt: string;
  /** The delta-implied strike before the band clamp. */
  deltaStrikeUsdg6: bigint | undefined;
  deltaStrikeFmt: string;
  strikeClamped: StrikeClamp;
  bandBufferBps: number | undefined;
  /** The vault's token spot the record was priced on. */
  spotUsdg6: bigint;
  spotFmt: string;
  /** strikeUsdg6 − spotUsdg6, in USDG. */
  strikeAboveSpotUsdg6: bigint;
  strikeAboveSpotFmt: string;

  fairUnit6: bigint | undefined;
  fairUnitFmt: string;
  volUnit6: bigint | undefined;
  volUnitFmt: string;
  floorUnit6: bigint;
  floorUnitFmt: string;
  marginUnit6: bigint;
  marginUnitFmt: string;
  unitPrice6: bigint;
  unitPriceFmt: string;
  edgeBps: number | undefined;
  marginBps: number;

  shareSpot: number | undefined;
  shareSpotFmt: string;
  expiryDate: string | undefined;
  chainTime: ReportedTime | undefined;
  lastTradeTime: ReportedTime | undefined;
};

const VOL_SOURCE = "cboe-delayed";
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9 _.:/()-]{0,63}$/;
const REASON = /^[a-z][a-z0-9-]{0,63}$/;
const DECIMAL_INT = /^[0-9]{1,30}$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PRICE_SOURCES: readonly PriceSource[] = ["fill-floor", "vol-fair", "vol-previous-fair", "manual-override"];

/** 2020-01-01T00:00:00Z and 2100-01-01T00:00:00Z. */
const MIN_TS = 1_577_836_800;
const MAX_TS = 4_102_444_800;

/** A present-but-malformed field, distinct from an absent one (undefined). */
class Malformed extends Error {}

function fail(): never {
  throw new Malformed();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function absent(x: unknown): boolean {
  return x === undefined || x === null;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** A float cut (never rounded) to `max` decimals, then trimmed of trailing zeros down to `min`. */
function truncatedDecimal(n: number, min: number, max: number): string {
  let s = String(n);
  // Only a value below 1e-6 prints in exponent form here; it truncates to zeros at max ≤ 6.
  if (s.includes("e")) s = n.toFixed(max + 2);
  const [whole, frac = ""] = s.split(".");
  let digits = frac.slice(0, max).padEnd(min, "0");
  while (digits.length > min && digits.endsWith("0")) digits = digits.slice(0, -1);
  return digits.length === 0 ? whole : `${whole}.${digits}`;
}

function readUint(x: unknown): bigint {
  if (typeof x === "string" && DECIMAL_INT.test(x)) return BigInt(x);
  return fail();
}

function optionalUint(x: unknown): bigint | undefined {
  return absent(x) ? undefined : readUint(x);
}

function readBps(x: unknown): number {
  if (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 10_000) return x;
  return fail();
}

function optionalBps(x: unknown): number | undefined {
  return absent(x) ? undefined : readBps(x);
}

function optionalFloat(x: unknown, ok: (n: number) => boolean): number | undefined {
  if (absent(x)) return undefined;
  if (typeof x === "number" && Number.isFinite(x) && ok(x)) return x;
  return fail();
}

function optionalDate(x: unknown): string | undefined {
  if (absent(x)) return undefined;
  if (typeof x !== "string") return fail();
  const m = DATE.exec(x);
  if (!m) return fail();
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Date.UTC rolls 2026-02-30 over into March; a real date round-trips.
  if (d.toISOString().slice(0, 10) !== x || Number(m[1]) < 2020 || Number(m[1]) > 2099) return fail();
  return x;
}

/** Minutes east of UTC in New York at `ms` (negative: -240 under EDT, -300 under EST). */
function newYorkOffsetMinutes(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour") === 24 ? 0 : get("hour");
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** A New York wall-clock time (as if UTC) to the real instant, or undefined in a DST gap. */
function newYorkWallToMs(wall: number): number | undefined {
  let ms = wall - newYorkOffsetMinutes(wall) * 60_000;
  const second = newYorkOffsetMinutes(ms);
  ms = wall - second * 60_000;
  return ms + newYorkOffsetMinutes(ms) * 60_000 === wall ? ms : undefined;
}

type LocalZone = "utc" | "new-york" | "unknown";

function reported(raw: string, ts: number): ReportedTime {
  if (!Number.isSafeInteger(ts) || ts < MIN_TS || ts >= MAX_TS) return fail();
  return { raw, ts, utc: fmtUtc(ts), eastern: fmtEastern(ts) };
}

function optionalTime(x: unknown, localZone: LocalZone): ReportedTime | undefined {
  if (absent(x)) return undefined;
  if (typeof x === "number") return reported(String(x), x);
  if (typeof x !== "string") return fail();
  const m = TIME.exec(x);
  if (!m) return fail();
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (optionalDate(`${m[1]}-${m[2]}-${m[3]}`) === undefined || h > 23 || mi > 59 || s > 59) return fail();
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const zone = m[7];
  if (zone !== undefined) {
    let offset = 0;
    if (zone !== "Z") {
      const digits = zone.replace(":", "");
      const oh = Number(digits.slice(1, 3));
      const om = Number(digits.slice(3, 5));
      if (oh > 14 || om > 59) return fail();
      offset = (digits[0] === "-" ? -1 : 1) * (oh * 60 + om);
    }
    return reported(x, (wall - offset * 60_000) / 1000);
  }
  if (localZone === "utc") return reported(x, wall / 1000);
  if (localZone === "new-york") {
    const ms = newYorkWallToMs(wall);
    return ms === undefined ? fail() : reported(x, ms / 1000);
  }
  if (y < 2020 || y > 2099) return fail();
  return { raw: x, ts: undefined, utc: DASH, eastern: DASH };
}

/**
 * Display figures for the keeper's pricing report, or null when it is missing, malformed in any
 * field, or inconsistent (see the comment above PriceSource for the accepted shape). Never throws.
 */
export function keeperPricingFigures(pricing: unknown): KeeperPricingFigures | null {
  try {
    return parsePricing(pricing);
  } catch {
    return null;
  }
}

function parsePricing(pricing: unknown): KeeperPricingFigures | null {
  if (!isRecord(pricing)) return null;
  const own = (key: string): unknown => (Object.hasOwn(pricing, key) ? pricing[key] : undefined);

  const mode = own("mode");
  if (mode !== "vol" && mode !== "fixed") return null;
  const vol = mode === "vol";

  const sourceRaw = own("source");
  let source: string | undefined;
  if (typeof sourceRaw === "string" && SOURCE.test(sourceRaw)) source = sourceRaw;
  else if (!absent(sourceRaw) || vol) return null;

  const priceSource = own("priceSource");
  if (typeof priceSource !== "string" || !(PRICE_SOURCES as readonly string[]).includes(priceSource)) return null;

  const volPathRaw = own("volPath");
  let volPath: "fresh" | "previous-fair" | undefined;
  if (volPathRaw === "fresh" || volPathRaw === "previous-fair") volPath = volPathRaw;
  else if (!absent(volPathRaw)) return null;
  if (!vol && volPath !== undefined) return null;

  const reasonRaw = own("volUnavailableReason");
  let volUnavailableReason: string | undefined;
  if (typeof reasonRaw === "string" && REASON.test(reasonRaw)) volUnavailableReason = reasonRaw;
  else if (!absent(reasonRaw)) return null;

  const targetDelta = optionalFloat(own("targetDelta"), (n) => n >= 0.01 && n <= 0.99);
  const deltaAtStrike = optionalFloat(own("deltaAtStrike"), (n) => n >= 0 && n <= 1);
  const ivAtStrike = optionalFloat(own("ivAtStrike"), (n) => n >= 0 && n <= 5);
  const shareSpot = optionalFloat(own("shareSpot"), (n) => n > 0 && n < 1_000_000);

  const strikeUsdg6 = readUint(own("strikeUsdg6"));
  const deltaStrikeUsdg6 = optionalUint(own("deltaStrikeUsdg6"));
  const clampRaw = own("strikeClamped");
  if (!(clampRaw === "band-floor" || clampRaw === "band-ceiling" || absent(clampRaw))) return null;
  const strikeClamped: StrikeClamp = absent(clampRaw) ? null : (clampRaw as StrikeClamp);
  const bandBufferBps = optionalBps(own("bandBufferBps"));
  const spotUsdg6 = readUint(own("spotUsdg6"));

  const fairUnit6 = optionalUint(own("fairUnit6"));
  const volUnit6 = optionalUint(own("volUnit6"));
  const floorUnit6 = readUint(own("floorUnit6"));
  const marginUnit6 = readUint(own("marginUnit6"));
  const unitPrice6 = readUint(own("unitPrice6"));
  const edgeBps = optionalBps(own("edgeBps"));
  const marginBps = readBps(own("marginBps"));

  const trusted = source === VOL_SOURCE;
  const expiry = optionalDate(own("expiry"));
  const chainTime = optionalTime(own("chainTimestamp"), trusted ? "utc" : "unknown");
  const lastTrade = optionalTime(own("lastTradeTime"), trusted ? "new-york" : "unknown");

  // Units and ranges.
  if (strikeUsdg6 === 0n || spotUsdg6 < 1_000_000n || floorUnit6 === 0n || unitPrice6 === 0n) return null;
  if (deltaStrikeUsdg6 === 0n || fairUnit6 === 0n || volUnit6 === 0n) return null;
  if (vol && (targetDelta === undefined || edgeBps === undefined)) return null;

  // The arithmetic that links the figures.
  if (marginUnit6 !== ceilDiv(floorUnit6 * (BPS + BigInt(marginBps)), BPS)) return null;
  if ((fairUnit6 === undefined) !== (volUnit6 === undefined)) return null;
  if (fairUnit6 !== undefined) {
    if (edgeBps === undefined || volUnit6 !== ceilDiv(fairUnit6 * (BPS + BigInt(edgeBps)), BPS)) return null;
  }
  if (unitPrice6 < floorUnit6 || unitPrice6 > strikeUsdg6) return null;

  switch (priceSource as PriceSource) {
    case "fill-floor":
      if (unitPrice6 !== marginUnit6 || (volUnit6 !== undefined && volUnit6 > marginUnit6)) return null;
      break;
    case "vol-fair":
    case "vol-previous-fair": {
      const path = priceSource === "vol-fair" ? "fresh" : "previous-fair";
      if (volPath !== path || volUnit6 === undefined || unitPrice6 !== volUnit6 || volUnit6 <= marginUnit6) return null;
      break;
    }
    case "manual-override":
      break;
  }

  // A market figure is shown only with the chain that dates it.
  const chainFigure =
    deltaAtStrike !== undefined ||
    ivAtStrike !== undefined ||
    shareSpot !== undefined ||
    expiry !== undefined ||
    chainTime !== undefined ||
    lastTrade !== undefined;
  if (volPath === "fresh" && (fairUnit6 === undefined || expiry === undefined || chainTime === undefined)) return null;
  if (volPath === "previous-fair" && (fairUnit6 === undefined || chainFigure)) return null;
  if (volPath === undefined && (fairUnit6 !== undefined || chainFigure)) return null;

  const strikeAboveSpot = strikeUsdg6 - spotUsdg6;
  return {
    mode,
    source,
    priceSource: priceSource as PriceSource,
    volPath,
    volUnavailableReason,
    targetDelta,
    targetDeltaFmt: targetDelta === undefined ? DASH : truncatedDecimal(targetDelta, 4, 4),
    deltaAtStrike,
    deltaAtStrikeFmt: deltaAtStrike === undefined ? DASH : truncatedDecimal(deltaAtStrike, 4, 4),
    ivAtStrike,
    ivAtStrikeFmt: ivAtStrike === undefined ? DASH : truncatedDecimal(ivAtStrike, 4, 4),
    strikeUsdg6,
    strikeFmt: exactUsdg(strikeUsdg6),
    deltaStrikeUsdg6,
    deltaStrikeFmt: exactUsdg(deltaStrikeUsdg6),
    strikeClamped,
    bandBufferBps,
    spotUsdg6,
    spotFmt: exactUsdg(spotUsdg6),
    strikeAboveSpotUsdg6: strikeAboveSpot,
    strikeAboveSpotFmt: exactUsdg(strikeAboveSpot),
    fairUnit6,
    fairUnitFmt: exactUsdg(fairUnit6),
    volUnit6,
    volUnitFmt: exactUsdg(volUnit6),
    floorUnit6,
    floorUnitFmt: exactUsdg(floorUnit6),
    marginUnit6,
    marginUnitFmt: exactUsdg(marginUnit6),
    unitPrice6,
    unitPriceFmt: exactUsdg(unitPrice6),
    edgeBps,
    marginBps,
    shareSpot,
    shareSpotFmt: shareSpot === undefined ? DASH : truncatedDecimal(shareSpot, 2, 4),
    expiryDate: expiry,
    chainTime,
    lastTradeTime: lastTrade,
  };
}
