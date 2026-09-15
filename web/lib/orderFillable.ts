import type { Hex } from "viem";

import { seaportRemaining, type SeaportFillStatus } from "./seaportOrder";

/**
 * How many contracts of the vault's live order a buyer can still take, as the input to
 * lib/cycleTerms.ts `cycleTerms(…, { fillableContracts })`, and where that count came from.
 *
 * WHY THIS FILE EXISTS: the home page and the cycle page both print "Order total if every
 * remaining contract sells", from two sources that can each be missing. Both pages read Seaport's
 * getOrderStatus for the vault's listingHash (lib/hooks.ts useOrderStatus), which fails soft to
 * undefined; the order feed (app/api/keeper/orders) carries rows whose `remaining` the ROUTE
 * computed from its own getOrderStatus read for the same hash (lib/keeperOrders.ts
 * verifyKeeperOrders), not the keeper's figure. One function decides the order of preference, so
 * the two pages cannot disagree about a sold-out order or quote a total for a week whose sale
 * window has shut.
 *
 * PREFERENCE, first that applies:
 *   nothing        the vault has no live listing (hash unread or zero), is not Listed, its listing
 *                  size is unread or zero, or the sale window has closed (the fill hook refuses
 *                  every fill from the exercise time): undefined, so no order figure is shown.
 *   seaport        the page's own getOrderStatus reading for the hash.
 *   route          the checked feed row for the same hash: its `remaining`, capped at the size.
 *   closed         the route says this hash is sold out, cancelled or past its end time: 0.
 *   (none)         neither Seaport nor the route has given a count: undefined, and the page shows
 *                  "—". There is deliberately no fallback to the whole listing: after any partial
 *                  fill it overstates what is left, and the order total and fee with it, under
 *                  labels that read as the order's current state.
 *
 * DELIBERATELY ABSENT: React, fetch, a clock. `windowClosed` is the caller's comparison.
 */

export type FillableSource = "seaport" | "route" | "closed";

export type FillableInput = {
  phase: number | undefined;
  listingHash: Hex | undefined;
  listingAmount: bigint | undefined;
  /** True once the chain's clock (as the page sees it) has reached the cycle's exercise time. */
  windowClosed: boolean;
  /** Seaport's getOrderStatus for `listingHash`, when the page has read it. */
  seaportStatus?: SeaportFillStatus;
  /** Checked feed rows (KeeperOrderBook.listings). Only a row whose hash is `listingHash` counts. */
  rows?: ReadonlyArray<{ orderHash: string; remaining?: string }>;
  /** The feed's lifecycle states (KeeperOrderBook.closed). */
  closed?: ReadonlyArray<{ orderHash: string | null; state: string }>;
};

export type Fillable = { contracts: bigint; source: FillableSource };

const PHASE_LISTED = 1;
const DECIMAL = /^[0-9]{1,30}$/;
const FINISHED_STATES = new Set(["soldOut", "cancelled", "expired"]);

function sameHash(a: string | null | undefined, b: string | undefined): boolean {
  return typeof a === "string" && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export function fillableForTerms(input: FillableInput): Fillable | undefined {
  const { listingHash, listingAmount } = input;
  if (listingHash === undefined || /^0x0*$/.test(listingHash)) return undefined;
  if (input.phase !== PHASE_LISTED || input.windowClosed) return undefined;
  if (listingAmount === undefined || listingAmount <= 0n) return undefined;

  const fromSeaport = seaportRemaining(listingAmount, input.seaportStatus);
  if (fromSeaport !== undefined) return { contracts: fromSeaport, source: "seaport" };

  const row = input.rows?.find((r) => sameHash(r.orderHash, listingHash));
  if (row !== undefined && DECIMAL.test(row.remaining ?? "")) {
    const remaining = BigInt(row.remaining!);
    return { contracts: remaining > listingAmount ? listingAmount : remaining, source: "route" };
  }

  if (input.closed?.some((c) => sameHash(c.orderHash, listingHash) && FINISHED_STATES.has(c.state))) {
    return { contracts: 0n, source: "closed" };
  }

  return undefined;
}
