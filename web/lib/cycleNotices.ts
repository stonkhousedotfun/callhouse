import type { Hex } from "viem";

import type { KeeperOrderBook } from "./api";
import { shortHash } from "./format";
import { seaportFinished, seaportRemaining, type SeaportFillStatus } from "./seaportOrder";

/**
 * What the cycle page says about the vault's listing, decided as pure functions of what it has
 * read: the vault's slot, Seaport's status for the authorised hash, Overcall's book and, when it
 * was asked, the keeper fallback route.
 *
 * WHY THIS FILE EXISTS: the page reads three sources that can disagree, and the words it prints
 * are claims about a week of premium. Three rules, each once a bug:
 *
 *   1. SEAPORT DECIDES WHAT IS LEFT. A sold-out or cancelled order is finished: a neutral notice,
 *      no keeper query, and none of the "no listing / escalate" copy. Otherwise the last fill
 *      from the keeper's card (the L-04 case the fallback exists for) reads as a red alarm and
 *      then as an unfilled week.
 *   2. ONLY INTEGRITY IS RED. A keeper order that claims the authorised hash and is not that
 *      order is an alarm. A chain or network failure is a warning that names no culprit, and a
 *      lifecycle state (sold out, cancelled, not Listed) is information.
 *   3. SAY WHAT IS ON THE PAGE. When the keeper's verified card is below, every notice that
 *      describes the book says so, and the card itself says what the book shows for the order
 *      (missing, unreachable, listed as not live, or unverified) instead of one fixed sentence.
 *
 * DELIBERATELY ABSENT: React, fetch, a clock. The page renders what these return; the vitest run
 * (lib/cycleNotices.test.ts) pins the decisions and the sentences that were wrong.
 */

/** What Overcall's book shows for the vault's order, for the keeper card's label. */
export type BookContext =
  | { state: "missing" }
  | { state: "unreachable" }
  | { state: "notLive"; status: string }
  | { state: "unverified" };

/** The heading on the keeper's fill card: where the order came from and what the book shows. */
export function keeperCardHeading(book: BookContext): string {
  switch (book.state) {
    case "missing":
      return "Listed directly by the vault's keeper; Overcall's book is not showing it.";
    case "unreachable":
      return "Listed directly by the vault's keeper; Overcall's book did not answer.";
    case "notLive":
      return `Listed directly by the vault's keeper; Overcall's book lists this order as ${book.status}.`;
    case "unverified":
      return "Listed directly by the vault's keeper; Overcall's row for this order did not check out against the chain.";
  }
}

export type Notice = { tone: "info" | "warn" | "bad"; heading: string; body: string; items?: string[] };

/** How many keeper reasons a notice lists before it says how many more there are. */
export const NOTICE_ITEMS = 3;

export function isLiveStatus(status: string): boolean {
  return status === "open" || status === "partial";
}

export type CycleListingState = {
  vaultConfigured: boolean;
  /** The vault's listingHash(): undefined until read, zero when nothing is authorised. */
  listingHash: Hex | undefined;
  listingAmount: bigint | undefined;
  /** Seaport's getOrderStatus for listingHash, when read. */
  seaportStatus: SeaportFillStatus | undefined;
  nowSeconds: number;
  book: {
    loading: boolean;
    /** The book answered without an error. */
    answered: boolean;
    error: string | undefined;
    /** The status of the book row carrying listingHash, in any state; undefined when none does. */
    ourRowStatus: string | undefined;
    /** Rows in the book that are open or partial, ours included. */
    liveCount: number;
  };
  /** The book's live row for listingHash passed checkListingIsOurs (clock started). */
  overcallVerified: boolean;
};

export function hasOnChainListing(s: CycleListingState): boolean {
  return s.listingHash !== undefined && !/^0x0*$/.test(s.listingHash);
}

export function orderFinished(s: CycleListingState): boolean {
  return hasOnChainListing(s) && seaportFinished(s.seaportStatus);
}

function ourRowLive(s: CycleListingState): boolean {
  return s.book.ourRowStatus !== undefined && isLiveStatus(s.book.ourRowStatus);
}

function ourRowNotLive(s: CycleListingState): string | undefined {
  return s.book.ourRowStatus !== undefined && !isLiveStatus(s.book.ourRowStatus) ? s.book.ourRowStatus : undefined;
}

function overcallUnverified(s: CycleListingState): boolean {
  return ourRowLive(s) && s.nowSeconds > 0 && !s.overcallVerified;
}

/** Overcall first, Seaport before either: the keeper is asked only when the book has answered
 *  (or failed) without a verified live row for the hash, and Seaport has contracts left. */
export function shouldAskKeeper(s: CycleListingState): boolean {
  return (
    s.vaultConfigured &&
    hasOnChainListing(s) &&
    s.nowSeconds > 0 &&
    !s.book.loading &&
    !s.overcallVerified &&
    !orderFinished(s)
  );
}

export function bookContext(s: CycleListingState): BookContext {
  if (s.book.error) return { state: "unreachable" };
  const notLive = ourRowNotLive(s);
  if (notLive !== undefined) return { state: "notLive", status: notLive };
  if (overcallUnverified(s)) return { state: "unverified" };
  return { state: "missing" };
}

function seaportLeftSentence(s: CycleListingState): string | undefined {
  const left = seaportRemaining(s.listingAmount, s.seaportStatus);
  return left === undefined ? undefined : `Seaport shows ${left.toString()} of ${(s.listingAmount ?? 0n).toString()} contracts still unsold.`;
}

const KEEPER_BELOW = "The vault's keeper is serving the authorised order directly, checked against the chain, and its card is below.";

/**
 * The notice about the book (or about the finished order). "loading" is the reading card.
 * `keeperServing`: the keeper's verified card for listingHash is rendered on the page.
 */
export function bookNotice(s: CycleListingState, keeperServing: boolean): Notice | "loading" | null {
  const hash = shortHash(s.listingHash);

  if (orderFinished(s) && s.seaportStatus !== undefined) {
    return s.seaportStatus.isCancelled
      ? {
          tone: "info",
          heading: "Seaport reports the vault's order as cancelled.",
          body: `The vault authorised ${hash} on chain and Seaport will not fill it now, so there is nothing left to buy from this page this cycle.`,
        }
      : {
          tone: "info",
          heading: "Every contract in the vault's order has been bought, per Seaport.",
          body: `The vault authorised ${hash} on chain and Seaport records it as completely filled, so there is nothing left to buy this cycle.`,
        };
  }

  if (s.book.loading) return "loading";

  if (s.book.error) {
    return {
      tone: "warn",
      heading: "Overcall's book did not answer.",
      body: `${s.book.error} The on-chain facts above still stand. ${
        keeperServing
          ? KEEPER_BELOW
          : "If the listing exists but their front end does not show it, the signed payload below is everything a buyer needs."
      }`,
    };
  }

  const notLive = ourRowNotLive(s);
  if (notLive !== undefined) {
    const left = seaportRemaining(s.listingAmount, s.seaportStatus);
    const explain = keeperServing
      ? [KEEPER_BELOW, seaportLeftSentence(s)].filter(Boolean).join(" ")
      : notLive === "unfillable"
        ? "Overcall marks an order unfillable while the offerer's approval or balance is short; it recovers by itself when they return."
        : notLive === "filled"
          ? left !== undefined && left > 0n
            ? `Overcall marks it filled, but Seaport shows ${left.toString()} of ${(s.listingAmount ?? 0n).toString()} contracts still unsold.`
            : "Overcall marks every contract as bought."
          : notLive === "expired"
            ? "The order's end time has passed."
            : "The row is in the table below.";
    return {
      tone: "warn",
      heading: `Overcall's book lists the vault's order as ${notLive}.`,
      body: `The vault has authorised ${hash} on chain and the book carries that hash, but not as an open order, so the book's row cannot be filled from this page. ${explain}`,
    };
  }

  if (overcallUnverified(s)) {
    return {
      tone: "warn",
      heading: "Overcall's row for the vault's order did not check out against the chain.",
      body: `The book carries ${hash}, the hash the vault authorised, but the row under it is not that order in every field a fill spends against; its card lists what is wrong and has no fill button.${
        keeperServing
          ? " The vault's keeper is serving the authorised order directly, checked against the chain, and its card is shown first."
          : ""
      }`,
    };
  }

  if (hasOnChainListing(s) && s.book.answered && s.book.ourRowStatus === undefined) {
    const others = s.book.liveCount;
    const tail =
      others > 0
        ? keeperServing
          ? `The vault's keeper is serving the authorised order directly, checked against the chain; the other open ${others === 1 ? "order is" : "orders are"} shown for the record and cannot be filled from this page.`
          : `The ${others === 1 ? "order" : `${others} orders`} open below ${others === 1 ? "is" : "are"} shown for the record and cannot be filled from this page.`
        : keeperServing
          ? "The vault's keeper is serving that order directly, and it is below, checked against the chain."
          : "An invisible listing is an unfilled week; this is the thing to escalate.";
    return {
      tone: "warn",
      heading: "Overcall's book has no listing matching the vault's current order hash.",
      body: `The vault has authorised ${hash} on chain, but no row under its address, open or otherwise, carries that hash. ${tail}`,
    };
  }

  if (s.book.liveCount === 0) {
    return {
      tone: "info",
      heading: "Nothing open on Overcall's book for this vault.",
      body: "Either the keeper has not listed this cycle yet, the order was filled, or it was cancelled. An invisible listing is an unfilled week, so if the vault has authorised a hash above and nothing appears here, that is the thing to escalate.",
    };
  }
  return null;
}

/**
 * The notice about the keeper, when it was asked and has nothing to offer. `keeperBook` is the
 * route's answer only when the page asked and the deployment has the fallback configured.
 */
export function keeperNotice(s: CycleListingState, keeperBook: KeeperOrderBook | undefined, keeperServing: boolean): Notice | null {
  if (keeperBook === undefined || keeperServing) return null;

  if (keeperBook.rejected.length > 0) {
    const n = keeperBook.rejected.length;
    const items = keeperBook.rejected
      .slice(0, NOTICE_ITEMS)
      .map((r) => `${r.orderHash ? `${shortHash(r.orderHash)}: ` : ""}${r.reasons.join(" ")}`);
    if (n > NOTICE_ITEMS) items.push(`and ${n - NOTICE_ITEMS} more.`);
    return {
      tone: "bad",
      heading: `The vault's keeper served ${n === 1 ? "an order" : `${n} orders`} that did not check out against the chain, so nothing from the keeper is offered here.`,
      body: "",
      items,
    };
  }

  if (keeperBook.error || keeperBook.unchecked.length > 0) {
    return {
      tone: "warn",
      heading: "The keeper fallback is unavailable right now.",
      body: `${keeperBook.error ?? "The chain could not be read, so the keeper's order is not offered yet."} Nothing from the keeper is offered until it answers and its order checks out against the chain. This page asks again by itself.`,
    };
  }

  const closed = keeperBook.closed.find(
    (c) => c.state !== "notCurrent" && s.listingHash !== undefined && c.orderHash?.toLowerCase() === s.listingHash.toLowerCase(),
  );
  if (closed !== undefined) {
    return {
      tone: "info",
      heading:
        closed.state === "soldOut"
          ? "Every contract in the vault's order has been bought, per Seaport."
          : closed.state === "cancelled"
            ? "Seaport reports the vault's order as cancelled."
            : closed.state === "notListed"
              ? "The vault is no longer in its Listed phase, so its order cannot be filled."
              : "The vault's order has passed its end time.",
      body: `The vault's keeper still has ${shortHash(s.listingHash)} on record; nothing is left to buy from it this cycle.`,
    };
  }

  return {
    tone: "info",
    heading: "The vault's keeper is not serving a live order for this vault either.",
    body: "Nothing it served matches the hash the vault has authorised on chain.",
  };
}
