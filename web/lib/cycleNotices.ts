import type { Hex } from "viem";

import type { KeeperOrderBook } from "./api";
import { shortHash } from "./format";
import { seaportFinished, seaportRemaining, type SeaportFillStatus } from "./seaportOrder";

/**
 * What the cycle page says about the vault's listing, decided as pure functions of what it has
 * read: the vault's slot, Seaport's status for the authorised hash, the clock, and the order
 * feed (app/api/keeper/orders) when it was asked.
 *
 * WHY THIS FILE EXISTS: the page reads sources that can disagree, and the words it prints are
 * claims about a week of premium. Three rules, each once a bug:
 *
 *   1. SEAPORT DECIDES WHAT IS LEFT. A sold-out or cancelled order is finished: a neutral notice,
 *      no feed query, and none of the "not being served / escalate" copy. Otherwise the last
 *      fill of the week reads as an alarm and then as an unfilled week.
 *   2. ONLY INTEGRITY IS RED. A feed order that claims the authorised hash and is not that order
 *      is an alarm. A chain or network failure is a warning that names no culprit, and a
 *      lifecycle state (sold out, cancelled, not Listed, window closed) is information.
 *   3. THE FEED IS THE ONLY VENUE. There is no other book. When the vault has authorised a hash
 *      and the feed is not serving it, that is an unfilled week in the making and the page says
 *      so, once, in the words the operator needs to act on.
 *
 * DELIBERATELY ABSENT: React, fetch, a clock. The page renders what these return; the vitest run
 * (lib/cycleNotices.test.ts) pins the decisions and the sentences that were wrong.
 */

export type Notice = { tone: "info" | "warn" | "bad"; heading: string; body: string; items?: string[] };

/** How many feed reasons a notice lists before it says how many more there are. */
export const NOTICE_ITEMS = 3;

export type CycleListingState = {
  vaultConfigured: boolean;
  /** The vault's phase(): undefined until read. 0 Idle, 1 Listed, 2 Exercisable, 3 Settling. */
  phase: number | undefined;
  /** The vault's listingHash(): undefined until read, zero when nothing is authorised. */
  listingHash: Hex | undefined;
  listingAmount: bigint | undefined;
  /** Seaport's getOrderStatus for listingHash, when read. */
  seaportStatus: SeaportFillStatus | undefined;
  /** This cycle's exercise timestamp: the sale window closes here whether or not lockBook ran. */
  cycleExerciseTs: number | undefined;
  nowSeconds: number;
};

export function hasOnChainListing(s: CycleListingState): boolean {
  return s.listingHash !== undefined && !/^0x0*$/.test(s.listingHash);
}

export function orderFinished(s: CycleListingState): boolean {
  return hasOnChainListing(s) && seaportFinished(s.seaportStatus);
}

/** The sale window has closed: the vault's fill hook refuses every fill from `cycleExerciseTs`. */
export function windowClosed(s: CycleListingState): boolean {
  return s.cycleExerciseTs !== undefined && s.nowSeconds > 0 && s.nowSeconds >= s.cycleExerciseTs;
}

/** Seaport before the feed: the feed is asked only when the vault has a live hash and Seaport
 *  has contracts left. Nothing is decided before the clock has started. */
export function shouldAskFeed(s: CycleListingState): boolean {
  return s.vaultConfigured && hasOnChainListing(s) && s.nowSeconds > 0 && !orderFinished(s);
}

function seaportLeftSentence(s: CycleListingState): string | undefined {
  const left = seaportRemaining(s.listingAmount, s.seaportStatus);
  return left === undefined ? undefined : `Seaport shows ${left.toString()} of ${(s.listingAmount ?? 0n).toString()} contracts still unsold.`;
}

/**
 * The notice about the order's own state on chain, before the feed is consulted. Null when the
 * order is live and fillable as far as the chain says, so the page goes on to the feed.
 */
export function listingNotice(s: CycleListingState): Notice | null {
  const hash = shortHash(s.listingHash);

  if (!s.vaultConfigured) return null;

  if (!hasOnChainListing(s)) {
    if (s.listingHash === undefined) return null;
    return {
      tone: "info",
      heading: "No listing is authorised on chain right now.",
      body:
        s.phase === 1
          ? "The vault has armed this week's option type but the keeper has not yet authorised an order for it. When it does, the order appears here and can be filled from this page."
          : "The vault authorises an order by hash with approveListing() after arming a cycle; there is nothing to buy until then.",
    };
  }

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

  if (windowClosed(s)) {
    return {
      tone: "info",
      heading: "This week's sale window has closed.",
      body: `The exercise window opened at the option's exercise time, and the vault refuses every fill from that moment (WriteWindowClosed). ${seaportLeftSentence(s) ?? ""} Nothing more is written this week; the calls already sold can be exercised until expiry.`.replace(/\s+/g, " ").trim(),
    };
  }

  if (s.phase !== undefined && s.phase !== 1) {
    return {
      tone: "info",
      heading: "The vault is not in its Listed phase, so its order cannot be filled.",
      body: `The vault still records ${hash} as its listing, but a fill only goes through while the vault is Listed; it is ${
        s.phase === 0 ? "Idle" : s.phase === 2 ? "Exercisable" : s.phase === 3 ? "Settling" : "in another phase"
      } now.`,
    };
  }

  return null;
}

/**
 * The notice about the feed, when it was asked. `feedServing`: the feed's verified card for
 * listingHash is rendered on the page (nothing to say then). "loading" is the reading card.
 */
export function feedNotice(s: CycleListingState, feed: KeeperOrderBook | undefined | "loading", feedServing: boolean): Notice | "loading" | null {
  if (feed === "loading") return "loading";
  if (feed === undefined || feedServing) return null;

  if (!feed.configured) {
    return {
      tone: "warn",
      heading: "This deployment is not connected to the keeper's order feed.",
      body: `The vault has authorised ${shortHash(s.listingHash)} on chain, but the order's parameters (its salt, times and counter) live with the keeper that built it, and KEEPER_ORDERS_URL is not set here. Nothing can be filled from this page until it is.`,
    };
  }

  if (feed.rejected.length > 0) {
    const n = feed.rejected.length;
    const items = feed.rejected
      .slice(0, NOTICE_ITEMS)
      .map((r) => `${r.orderHash ? `${shortHash(r.orderHash)}: ` : ""}${r.reasons.join(" ")}`);
    if (n > NOTICE_ITEMS) items.push(`and ${n - NOTICE_ITEMS} more.`);
    return {
      tone: "bad",
      heading: `The keeper served ${n === 1 ? "an order" : `${n} orders`} that did not check out against the chain, so nothing is offered here.`,
      body: "",
      items,
    };
  }

  if (feed.error || feed.unchecked.length > 0) {
    return {
      tone: "warn",
      heading: "The order feed is unavailable right now.",
      body: `${feed.error ?? "The chain could not be read, so the keeper's order is not offered yet."} Nothing is offered until the feed answers and its order checks out against the chain. This page asks again by itself.`,
    };
  }

  const closed = feed.closed.find(
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
      body: `The keeper still has ${shortHash(s.listingHash)} on record; nothing is left to buy from it this cycle.`,
    };
  }

  return {
    tone: "warn",
    heading: "The keeper is not serving the order the vault has authorised.",
    body: `The vault has authorised ${shortHash(s.listingHash)} on chain, but nothing the keeper serves carries that hash. An unserved order is an unfilled week; this is the thing to escalate. This page asks again by itself.`,
  };
}
