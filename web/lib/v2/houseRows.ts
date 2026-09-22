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
 * first-class value rather than a filtered-out one. The compliance table at disclosure policy (copy-lint enforced this until it was removed on 2026-09-21; nothing checks it now):52-66`
 * catches the forward-looking vocabulary; it cannot catch a silently dropped negative row, which is
 * why that is asserted in this module's test instead.
 *
 * NAV IS A BOUNDARY FIGURE. Every NAV that reaches a row comes from `HouseEpoch.nav`, which the API
 * populates from a settled boundary (`HouseNav.at` is that boundary's timestamp and `HouseNav.settlementPrice`
 * the price it was struck at). A running epoch has `nav: null` and gets {NAV_NOT_AVAILABLE} through
 * `navView`, never a number.
 */
import type { HouseEpoch, HouseMarketResponse } from "./api-types";
import {
  depositJoinsSentence, formatNewYork, inKindPreview, navView, secondsUntilBoundary,
  NAV_NOT_AVAILABLE, type InKindPreview, type NavView,
} from "./houseEpoch";

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
export function pastEpochRows(epochs: readonly HouseEpoch[]): HouseEpochRow[] {
  return epochs.map((epoch) => {
    const resultUsdg = epoch.resultUsdg === null ? null : BigInt(epoch.resultUsdg.raw);
    return {
      id: epoch.id,
      // `start`/`end` are nullable by design (api-schema.ts, houseEpochSchema): an unobserved
      // boundary is a gap, not a date. Label it as one; never coerce it to a timestamp.
      startLabel: epoch.start === null ? BOUNDARY_NOT_OBSERVED : formatNewYork(epoch.start),
      endLabel: epoch.end === null ? BOUNDARY_NOT_OBSERVED : formatNewYork(epoch.end),
      nav: epoch.nav === null
        ? navView({ atBoundary: false })
        : navView({ atBoundary: true, navUsdg: BigInt(epoch.nav.navUsdg.raw) }),
      navAtLabel: epoch.nav === null ? null : formatNewYork(epoch.nav.at),
      settlementPrice: epoch.nav === null ? null : epoch.nav.settlementPrice.formatted,
      resultUsdg,
      outcome: outcomeOf(resultUsdg),
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
export function houseCountdown(nowUnixSeconds: number, epoch: HouseEpoch): HouseCountdown | null {
  if (epoch.end === null) return null;
  return {
    secondsRemaining: secondsUntilBoundary(nowUnixSeconds, epoch.end),
    boundaryLabel: formatNewYork(epoch.end),
    depositJoinsSentence: depositJoinsSentence(epoch.end),
  };
}

/**
 * THE IN-KIND PREVIEW IS ALWAYS UNAVAILABLE FROM THIS API TODAY, AND THAT IS DELIBERATE.
 *
 * `inKindPreview` needs a BOUNDARY-TIME, POST-FEE pool: `usdg.balanceOf(vault) − pendingDepositUsdg
 * − owedUsdg + clearinghouse.free(vault, usdg)` struck after the performance fee has moved
 * (`houseEpoch.ts` cites HouseVault.rollEpoch:440-455 for both halves). `HouseMarketResponse`
 * (`api-types.ts:380-387`) carries `currentEpoch`, `epochs`, `shares` and `queue` — and no pool
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
export function houseInKindPreview(_market: HouseMarketResponse): InKindPreview {
  return inKindPreview({ atBoundary: false });
}

/** The label for a NAV cell: the figure's boundary, or the reason there is no figure. */
export function navCellLabel(row: HouseEpochRow): string {
  return row.navAtLabel === null ? NAV_NOT_AVAILABLE : `at the ${row.navAtLabel} boundary`;
}
