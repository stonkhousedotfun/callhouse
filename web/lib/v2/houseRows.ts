/**
 * House vault presentation assembly: API rows in, display rows out. No maths and no strings are
 * authored here — the arithmetic is `houseEpoch.ts`'s and the disclosure copy is `houseCopy.ts`'s.
 * This module only decides WHICH of their outputs a row gets, and it exists as a plain `.ts` module
 * rather than as logic inside `HouseVault.tsx` for one reason: `web/vitest.config.ts` runs a NODE
 * environment and says a jsdom environment is "deliberately absent", so the only way the losing-epoch
 * row is covered by a test at all is if the row is built outside React. `components/**\/*.test.ts` and
 * `lib/**\/*.test.ts` are the include globs; this file is under the second.
 *
 * NO AGGREGATES. There is no function here that sums, averages or annualises across epochs, and there
 * is deliberately no "total" row for a caller to reach for. {pastEpochRows} returns every epoch it is
 * given, in order, INCLUDING losing ones — see {HouseEpochRow.outcome}, whose "lost" case is a
 * first-class value rather than a filtered-out one. The disclosure policy's compliance table
 * catches the forward-looking vocabulary; it cannot catch a silently dropped negative row, which is
 * why that is asserted in this module's test instead.
 *
 * NAV IS A BOUNDARY FIGURE. Every NAV that reaches a row comes from `HouseEpoch.nav`, which the API
 * populates from a settled boundary (`HouseNav.at` is that boundary's timestamp and `HouseNav.settlementPrice`
 * the price it was struck at). A running epoch has `nav: null` and gets {NAV_NOT_AVAILABLE} through
 * `navView`, never a number.
 */
import { formatUnits } from "viem";

import type { ConfigResponse, HouseEpoch, HouseMarketResponse } from "./api-types";
import type { HouseVaultReads, SplitterReads } from "./chainReads";
import type { HouseClaimAmounts, HouseClaimState } from "./houseClaim";
import { bpsPct, feeRouteLine, houseFeeLine, vaultMarkLabel, type LabelledValue } from "./vaultCopy";
import {
  depositJoinsSentence, formatNewYork, inKindPreview, markPerShare, navView, secondsUntilBoundary,
  NAV_NOT_AVAILABLE, type InKindPreview, type NavView,
} from "./houseEpoch";
import { marketStamp } from "./time";

/**
 * A boundary time for the page. With the reader's zone, "Sep 24, 1:00 PM PDT (4:00 PM ET)"; without one
 * (a server render, or a caller that has not passed it yet), New York as before.
 */
function boundaryText(at: number, timeZone: string | undefined): string {
  return timeZone === undefined ? formatNewYork(at) : marketStamp(at, timeZone);
}

/** What one past epoch reports. `outcome` is a fact about that epoch and nothing wider. */
export type HouseEpochRow = {
  id: string;
  /** Boundary labels, already in New York, so the reader can see which boundary a figure came from. */
  startLabel: string;
  endLabel: string;
  /** The NAV struck at this epoch's own boundary, or the unavailable message for a running epoch. */
  nav: NavView;
  /** The boundary the NAV was struck at, labelled. Null when there is no NAV. */
  navAtLabel: string | null;
  /** The settlement price that boundary used, as the API formatted it. Null when there is no NAV. */
  settlementPrice: string | null;
  /** end − start in USDG base units, or null when the API has not reported a result for this epoch. */
  resultUsdg: bigint | null;
  /** "gained" | "lost" | "flat" | "unreported". A losing epoch renders; it is never dropped. */
  outcome: "gained" | "lost" | "flat" | "unreported";
  /** The performance fee taken at this boundary, USDG base units; null until the wire carries it. */
  feeTakenUsdg: bigint | null;
  /** The boundary transaction; null until the wire carries it. */
  tx: string | null;
  /** share supply after the boundary; null until the wire carries it. */
  supply: bigint | null;
};

/**
 * What a boundary label says when the boundary has not been observed. `api-schema.ts`'s
 * `houseEpochSchema` makes `start` and `end` nullable with the reason spelled out: "Null until
 * observed", because coercing an unobserved boundary to 0 would publish 1970-01-01 as an epoch
 * boundary. This is the label for that state, and the word is the schema's, not a new one.
 *
 * It is authored here rather than in `houseCopy.ts` for one reason: `HouseVault.tsx:222-223`
 * renders `startLabel` and `endLabel` with no fallback of its own, and that file is outside this
 * change. If the copy ever moves, it moves with that component.
 */
export const BOUNDARY_NOT_OBSERVED = "not observed";

function outcomeOf(resultUsdg: bigint | null): HouseEpochRow["outcome"] {
  if (resultUsdg === null) return "unreported";
  if (resultUsdg > 0n) return "gained";
  if (resultUsdg < 0n) return "lost";
  return "flat";
}

/**
 * One row per epoch, in the order the API returned them, with nothing filtered.
 *
 * `HouseEpoch.resultUsdg` is a `SignedMoney` whose `raw` may carry a leading "-" (`api-types.ts:90-91`),
 * so it is parsed with BigInt rather than being read off `formatted`. A null `resultUsdg` is reported as
 * "unreported" and NOT as zero: an epoch the indexer has not finished is not an epoch that broke even,
 * and collapsing the two would quietly understate a loss.
 */
export function pastEpochRows(epochs: readonly HouseEpoch[], timeZone?: string): HouseEpochRow[] {
  return epochs.map((epoch) => {
    const resultUsdg = epoch.resultUsdg === null ? null : BigInt(epoch.resultUsdg.raw);
    return {
      id: epoch.id,
      // `start`/`end` are nullable by design (api-schema.ts, houseEpochSchema): an unobserved
      // boundary is a gap, not a date. Label it as one; never coerce it to a timestamp.
      startLabel: epoch.start === null ? BOUNDARY_NOT_OBSERVED : boundaryText(epoch.start, timeZone),
      endLabel: epoch.end === null ? BOUNDARY_NOT_OBSERVED : boundaryText(epoch.end, timeZone),
      nav: epoch.nav === null
        ? navView({ atBoundary: false })
        : navView({ atBoundary: true, navUsdg: BigInt(epoch.nav.navUsdg.raw) }),
      navAtLabel: epoch.nav === null ? null : boundaryText(epoch.nav.at, timeZone),
      settlementPrice: epoch.nav === null ? null : epoch.nav.settlementPrice.formatted,
      resultUsdg,
      outcome: outcomeOf(resultUsdg),
      feeTakenUsdg: epoch.nav?.performanceFee === undefined ? null : BigInt(epoch.nav.performanceFee.raw),
      tx: epoch.nav?.tx ?? null,
      supply: epoch.nav?.supply === undefined ? null : BigInt(epoch.nav.supply),
    };
  });
}

/** The running epoch's countdown, as seconds and as the sentence a depositor is shown. */
export type HouseCountdown = {
  secondsRemaining: number;
  boundaryLabel: string;
  depositJoinsSentence: string;
};

/**
 * Null when this epoch's `end` has not been observed. All three fields are functions of that one
 * boundary, so there is no honest partial countdown: a zero would read as "the boundary is now" and
 * a 1970 label would read as a date. `HouseVault.tsx:125` already renders the null case as "Epoch
 * figures are unavailable.", which is why this returns null rather than inventing a sentence.
 */
export function houseCountdown(nowUnixSeconds: number, epoch: HouseEpoch, timeZone?: string): HouseCountdown | null {
  if (epoch.end === null) return null;
  return {
    secondsRemaining: secondsUntilBoundary(nowUnixSeconds, epoch.end),
    boundaryLabel: boundaryText(epoch.end, timeZone),
    depositJoinsSentence: depositJoinsSentence(epoch.end),
  };
}

/**
 * A MATURED CLAIM SHOWS THE VAULT'S OWN NUMBERS. Once the close has priced this wallet's request
 * `claimable(account)` (read in the page's vault multicall, chainReads.readHouseVault) answers exactly what `claim()`
 * pays -- the USDG and Stock of a processed withdrawal, plus any refused deposit returned in kind and any shares a
 * priced deposit bought. That is the one figure this panel may show, and it is passed through as the vault gives it:
 * never re-divided here, never assembled from events or epoch rates. (0, 0, 0) is a real answer for a matured request
 * that priced to zero, and is shown as such.
 *
 * BEFORE THE CLOSE THE IN-KIND PREVIEW IS UNAVAILABLE FROM THIS API, AND THAT IS DELIBERATE.
 *
 * `inKindPreview` needs the BOUNDARY-TIME, POST-FEE pools `HouseVault.rollEpoch` pays withdrawals from
 * (callhouse-contracts HouseVault.sol: `rollEpoch` calls `_computeBoundary`, whose pools are the anchor
 * `(uint256 usdgPool, uint256 stockPool) = _legsOf(`), measured after `orderBook.claimOwed()` has run and
 * after the performance fee has been transferred to the splitter:
 *   usdgPool  = usdg.balanceOf(vault) + clearinghouse.free(vault, usdg) + orderBook.owed(vault)
 *               − (pendingDepositUsdg + owedUsdg), floored at 0
 *   stockPool = underlying.balanceOf(vault) + clearinghouse.free(vault, underlying)
 *               − (pendingDepositStock + owedStock), floored at 0
 * The `orderBook.owed(vault)` term: USDG the book owes the vault counts in the pool, as it
 * does in `_nav`. (`houseEpoch.ts` cites the same code by older line numbers.) `HouseMarketResponse`
 * (`api-types.ts`, `export type HouseMarketResponse`) carries `currentEpoch`, `epochs`, `shares` and `queue` — and no pool
 * figures at all. Every component of that formula is readable on chain, so it is tempting to
 * assemble it here; that is the mistake. Mid-epoch the same expression is not merely stale but
 * wrong — the vault also holds open ERC-1155 positions that no pair of token balances describes —
 * and the client cannot tell from any of these fields that it is standing at a post-fee boundary.
 *
 * So this returns the `{atBoundary: false}` branch unconditionally: the depositor is shown
 * {NAV_NOT_AVAILABLE}, not a number that would be believed. When the API grows the boundary pool
 * fields, pass them through here and the {atBoundary: true} branch does the rest — the maths is
 * already written and already floored in two stages.
 */
export type HouseInKindPreview =
  | { available: false; message: string }
  /** `claimable(account)` for a matured claim: USDG, Stock Tokens and shares, in base units (houseClaim.ts). */
  | { available: true; usdgOut: bigint; stockOut: bigint; sharesOut: bigint };

export function houseInKindPreview(
  _market: HouseMarketResponse, claim?: HouseClaimState, claimable?: HouseClaimAmounts | null,
): HouseInKindPreview {
  if (claim?.kind === "ready" && claimable)
    return { available: true, usdgOut: claimable.usdg, stockOut: claimable.stock, sharesOut: claimable.shares };
  // Before the close: the running-epoch branch, which has no figure (above) and never answers `available`.
  const running: InKindPreview = inKindPreview({ atBoundary: false });
  return running.available ? { available: false, message: NAV_NOT_AVAILABLE } : running;
}

/** The label for a NAV cell: the figure's boundary, or the reason there is no figure. */
export function navCellLabel(row: HouseEpochRow): string {
  return row.navAtLabel === null ? NAV_NOT_AVAILABLE : `at the ${row.navAtLabel} boundary`;
}

/*//////////////////////////////////////////////////////////////
              -- VAULT PAGE VIEW MODELS
//////////////////////////////////////////////////////////////*/

/** One boundary on the share-price chart. `supply` null means the wire did not carry it: no point is drawn. */
export type NavPoint = { epoch: string; at: number; navUsdg: bigint; supply: bigint | null; feeTaken: boolean };

/** The chart's points: every settled epoch, in order, with nothing filtered. */
export function navPoints(epochs: readonly HouseEpoch[]): NavPoint[] {
  return epochs.filter((e) => e.nav !== null).map((e) => ({
    epoch: e.id,
    at: e.nav!.at,
    navUsdg: BigInt(e.nav!.navUsdg.raw),
    supply: e.nav!.supply === undefined ? null : BigInt(e.nav!.supply),
    feeTaken: e.nav!.performanceFee !== undefined && BigInt(e.nav!.performanceFee.raw) > 0n,
  }));
}

const USDG_DP = 6;
/**
 * USDG base units as display text, at most `maximumFractionDigits` places and at least two when the caller allows two.
 * The minimum is clamped to the maximum because Intl throws a RangeError when min > max: a fixed minimum of 2 made the
 * Quoter limits row's whole-USDG call (max 0) throw, and with it every House page render once the limits were read.
 */
export const usdgText = (raw: bigint, maximumFractionDigits: number) =>
  `${Number(formatUnits(raw, USDG_DP)).toLocaleString("en-US", {
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  })} USDG`;

/** The newest settled boundary's timestamp, or null when no epoch has closed. */
export function lastBoundaryAt(epochs: readonly HouseEpoch[]): number | null {
  let at: number | null = null;
  for (const e of epochs) if (e.nav !== null && (at === null || e.nav.at > at)) at = e.nav.at;
  return at;
}

export type HouseHeroModel = { value: LabelledValue; tvl: LabelledValue; positionAtMark: LabelledValue | null };

/**
 * Hero cells. Value and TVL are `nav()` MARKS, labelled with the boundary they were struck at. Before
 * the first boundary `nav()` reverts NotSettled; that state has its own sentence, not "not read" and never 0.
 */
export function houseHeroModel(reads: HouseVaultReads | null, epochs: readonly HouseEpoch[], currentEnd: number | null,
  timeZone?: string): HouseHeroModel {
  const at = lastBoundaryAt(epochs);
  if (at === null) {
    const label = currentEnd === null
      ? "No boundary yet — the first price is struck at the first boundary."
      : `No boundary yet — the first price is struck at ${boundaryText(currentEnd, timeZone)}.`;
    return { value: { text: "No boundary yet", label }, tvl: { text: "No boundary yet", label }, positionAtMark: null };
  }
  const label = vaultMarkLabel(boundaryText(at, timeZone));
  const nav = reads?.nav ?? null;
  const perShare = markPerShare(nav, reads?.totalSupply ?? null);
  const balance = reads?.balance ?? null;
  const position = perShare === null || balance === null ? null : (balance * perShare) / 10n ** 18n;
  return {
    value: { text: perShare === null ? null : usdgText(perShare, 4), label },
    tvl: { text: nav === null ? null : usdgText(nav, 2), label },
    positionAtMark: balance === null ? null : { text: position === null ? null : usdgText(position, 2), label: "at the mark" },
  };
}

type Fees = ConfigResponse["fees"];

/** Cost block inputs: the vault fee from chain reads, protocol fees from /v2/config, route from burnBps. */
export function houseCostsModel(reads: HouseVaultReads | null, fees: Fees | null, feeChangeDelayS: number | null, splitter: SplitterReads | null) {
  const hwm = reads?.highWaterMark ?? null;
  return {
    // The rate in force, which the next close charges; a change the treasury has only staged is not it.
    // And a staged change (performanceFeeBps), when it differs, as the rate from the next epoch.
    vaultFeeLine: houseFeeLine(reads?.epochPerformanceFeeBps ?? null, reads?.performanceFeeCeilBps ?? null, reads?.performanceFeeBps ?? null),
    rateBps: reads?.epochPerformanceFeeBps ?? null,
    ceilBps: reads?.performanceFeeCeilBps ?? null,
    highWaterMark: hwm === null ? null : `${usdgText(hwm, 4)} / share`,
    protocol: [
      { label: "Seller fee on premium", value: fees ? bpsPct(fees.premiumFeeBps) : null },
      { label: "Taker fee", value: fees ? `${fees.takerFeeFlat.formatted} USDG, capped at ${bpsPct(fees.takerFeeCapBps)} of premium` : null },
      { label: "Exercise fee", value: fees ? bpsPct(fees.exerciseFeeBps) : null },
      { label: "Maker rebate", value: fees ? `${bpsPct(fees.makerRebateBps)} of the taker fee back` : null },
    ],
    feeRoute: feeRouteLine(splitter?.burnBps ?? null),
    feeDelaySentence: feeChangeDelayS === null ? null : `Fee changes wait ${Math.round(feeChangeDelayS / 3600)} h after being scheduled.`,
  };
}

export type HouseProofRow = { label: string; kind: "address" | "token" | "tx"; value: string | null; note?: string | null };

/** Proof rows. Every address is a read or the registry row; a row that was not read has no link. */
export function houseProofRows(vault: string | null, reads: HouseVaultReads | null, underlying: string | null,
  splitter: SplitterReads | null, epochs: readonly HouseEpoch[], timeZone?: string): HouseProofRow[] {
  const settled = epochs.filter((e) => e.nav !== null);
  const last = settled.length ? settled[settled.length - 1]!.nav! : null;
  const burn = splitter?.burnBps ?? null;
  const l = reads?.limits ?? null;
  return [
    { label: "Vault", kind: "address", value: vault },
    { label: "Shares (ERC-20)", kind: "token", value: vault },
    { label: "Fee splitter", kind: "address", value: reads?.splitter ?? null, note: burn === null ? null : `burnBps ${burn}` },
    { label: "Last boundary", kind: "tx", value: last?.tx ?? null, note: last ? `${boundaryText(last.at, timeZone)} · settlement ${last.settlementPrice.formatted} USDG` : null },
    { label: "Oracle", kind: "address", value: reads?.oracle ?? null },
    { label: "Underlying", kind: "token", value: underlying },
    { label: "Quoter limits", kind: "address", value: vault, note: l === null ? null
      : `maxSeriesUnits ${l.maxSeriesUnits} · maxTotalNotional ${usdgText(l.maxTotalNotional, 0)} · askTolerance ${bpsPct(l.askToleranceBps)} · maxBid ${bpsPct(l.maxBidBpsOfSpot)} of spot` },
  ];
}
