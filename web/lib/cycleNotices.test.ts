import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { KeeperOrderBook } from "./api";
import {
  NOTICE_ITEMS,
  bookContext,
  bookNotice,
  keeperCardHeading,
  keeperNotice,
  shouldAskKeeper,
  type CycleListingState,
  type Notice,
} from "./cycleNotices";

/**
 * What the cycle page says about the vault's listing. Each case is a screen a reviewer found
 * saying something false: a sold-out week rendered as a keeper alarm and then as "escalate", a
 * notice calling a working keeper card unfillable, a keeper card saying Overcall does not show an
 * order the page lists, and an RPC failure blamed on the keeper.
 *
 * The vault's order is 23 contracts. Seaport's fraction is reduced, as Seaport stores it.
 */
const HASH = "0x4a5b6c7d8e9f00112233445566778899aabbccddeeff00112233445566778899" as Hex;
const OLD_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

function state(
  overrides: Partial<Omit<CycleListingState, "book">> & { book?: Partial<CycleListingState["book"]> } = {},
): CycleListingState {
  const { book, ...rest } = overrides;
  return {
    vaultConfigured: true,
    listingHash: HASH,
    listingAmount: 23n,
    seaportStatus: { isCancelled: false, totalFilled: 0n, totalSize: 0n },
    nowSeconds: 1_789_000_000,
    overcallVerified: false,
    ...rest,
    book: { loading: false, answered: true, error: undefined, ourRowStatus: undefined, liveCount: 0, ...book },
  };
}

function keeperBook(overrides: Partial<KeeperOrderBook> = {}): KeeperOrderBook {
  return { configured: true, listings: [], rejected: [], closed: [], unchecked: [], ...overrides };
}

function text(notice: Notice | "loading" | null): string {
  if (notice === null || notice === "loading") throw new Error(`expected a notice, got ${String(notice)}`);
  return `${notice.heading} ${notice.body} ${(notice.items ?? []).join(" ")}`;
}

const SOLD_OUT = { isCancelled: false, totalFilled: 1n, totalSize: 1n };

describe("a finished order (Seaport decides)", () => {
  it("a sold-out week is a neutral notice, the keeper is not asked, and nothing says escalate", () => {
    // L-04: the book never showed the order, buyers took all 23 from the keeper's card.
    const s = state({ seaportStatus: SOLD_OUT });
    expect(shouldAskKeeper(s)).toBe(false);
    const notice = bookNotice(s, false);
    expect(notice).toMatchObject({ tone: "info", heading: "Every contract in the vault's order has been bought, per Seaport." });
    expect(text(notice)).not.toMatch(/escalate|unfilled week|did not check out/);
    expect(keeperNotice(s, undefined, false)).toBeNull();
  });

  it("outranks every book notice, including the book's own 'filled' and a failed book read", () => {
    for (const book of [{ ourRowStatus: "filled" }, { ourRowStatus: "open", liveCount: 1 }, { answered: false, error: "Overcall is down." }]) {
      expect(bookNotice(state({ seaportStatus: SOLD_OUT, book }), false)).toMatchObject({ tone: "info" });
    }
  });

  it("a cancelled order is information, not an alarm", () => {
    const s = state({ seaportStatus: { isCancelled: true, totalFilled: 0n, totalSize: 0n } });
    expect(shouldAskKeeper(s)).toBe(false);
    expect(bookNotice(s, false)).toMatchObject({ tone: "info", heading: "Seaport reports the vault's order as cancelled." });
  });

  it("when the route saw the sale before the page did, the keeper notice says sold, in info", () => {
    const s = state({ seaportStatus: undefined });
    const notice = keeperNotice(s, keeperBook({ closed: [{ orderHash: HASH, state: "soldOut" }] }), false);
    expect(notice).toMatchObject({ tone: "info", heading: "Every contract in the vault's order has been bought, per Seaport." });
  });

  it("a superseded order the keeper still serves does not change what the page says", () => {
    const notice = keeperNotice(state(), keeperBook({ closed: [{ orderHash: OLD_HASH, state: "notCurrent" }] }), false);
    expect(notice).toMatchObject({ tone: "info", heading: "The vault's keeper is not serving a live order for this vault either." });
  });
});

describe("the book notice says what is on the page", () => {
  it("names the keeper's card when the book misses the hash but lists other open orders", () => {
    // After a relist Overcall still shows H1 open and refused H2; the keeper serves H2 below.
    const s = state({ book: { liveCount: 1 } });
    const withKeeper = text(bookNotice(s, true));
    expect(withKeeper).toContain(
      "The vault's keeper is serving the authorised order directly, checked against the chain; the other open order is shown for the record and cannot be filled from this page.",
    );
    expect(withKeeper).not.toContain("The order open below is shown for the record");
    expect(text(bookNotice(s, false))).toContain("The order open below is shown for the record and cannot be filled from this page.");
  });

  it("keeps the exact sentence the fork acceptance reads when the book is empty", () => {
    expect(bookNotice(state(), true)).toMatchObject({
      heading: "Overcall's book has no listing matching the vault's current order hash.",
      body: expect.stringMatching(/The vault's keeper is serving that order directly, and it is below, checked against the chain\.$/),
    });
    expect(text(bookNotice(state(), false))).toContain("An invisible listing is an unfilled week; this is the thing to escalate.");
  });

  it("names the keeper's card when the book did not answer", () => {
    const s = state({ book: { answered: false, error: "Overcall's API timed out." } });
    const notice = bookNotice(s, true);
    expect(notice).toMatchObject({ tone: "warn", heading: "Overcall's book did not answer." });
    expect(text(notice)).toContain("The vault's keeper is serving the authorised order directly");
    expect(text(notice)).not.toContain("the signed payload below is everything a buyer needs");
    expect(bookContext(s)).toEqual({ state: "unreachable" });
  });

  it("does not say every contract was bought when Overcall marks the order filled but Seaport has contracts left", () => {
    // 3 of 23 bought; Overcall says filled. The keeper's bookVerdict leaves the order serving.
    const s = state({ seaportStatus: { isCancelled: false, totalFilled: 3n, totalSize: 23n }, book: { ourRowStatus: "filled" } });
    expect(shouldAskKeeper(s)).toBe(true);
    expect(bookContext(s)).toEqual({ state: "notLive", status: "filled" });
    const withKeeper = text(bookNotice(s, true));
    expect(withKeeper).not.toContain("Every contract has been bought");
    expect(withKeeper).toContain("Seaport shows 20 of 23 contracts still unsold.");
    expect(text(bookNotice(s, false))).toContain("Overcall marks it filled, but Seaport shows 20 of 23 contracts still unsold.");
  });

  it("explains an unverified Overcall row for the hash next to the keeper's verified card", () => {
    const s = state({ book: { ourRowStatus: "open", liveCount: 1 }, overcallVerified: false });
    expect(shouldAskKeeper(s)).toBe(true);
    expect(bookContext(s)).toEqual({ state: "unverified" });
    const notice = bookNotice(s, true);
    expect(notice).toMatchObject({ tone: "warn", heading: "Overcall's row for the vault's order did not check out against the chain." });
    expect(text(notice)).toContain("its card is shown first");
  });

  it("does not ask the keeper while Overcall's row for the hash checks out", () => {
    const s = state({ book: { ourRowStatus: "open", liveCount: 1 }, overcallVerified: true });
    expect(shouldAskKeeper(s)).toBe(false);
    expect(bookNotice(s, false)).toBeNull();
  });

  it("decides nothing before the clock has started or while the book loads", () => {
    expect(shouldAskKeeper(state({ nowSeconds: 0 }))).toBe(false);
    expect(shouldAskKeeper(state({ book: { loading: true, answered: false } }))).toBe(false);
    expect(bookNotice(state({ book: { loading: true, answered: false } }), false)).toBe("loading");
  });
});

describe("the keeper card's heading matches what the book shows", () => {
  it("does not say the book is not showing an order the page lists", () => {
    expect(keeperCardHeading({ state: "missing" })).toBe("Listed directly by the vault's keeper; Overcall's book is not showing it.");
    expect(keeperCardHeading({ state: "unreachable" })).toBe("Listed directly by the vault's keeper; Overcall's book did not answer.");
    expect(keeperCardHeading({ state: "notLive", status: "filled" })).toBe(
      "Listed directly by the vault's keeper; Overcall's book lists this order as filled.",
    );
    expect(keeperCardHeading({ state: "unverified" })).toBe(
      "Listed directly by the vault's keeper; Overcall's row for this order did not check out against the chain.",
    );
    // The page derives the state from the book: a filled row for the hash is "notLive", not "missing".
    const s = state({ seaportStatus: { isCancelled: false, totalFilled: 3n, totalSize: 23n }, book: { ourRowStatus: "filled" } });
    expect(keeperCardHeading(bookContext(s))).not.toContain("not showing it");
  });
});

describe("the keeper notice: only integrity is red", () => {
  it("renders a rejection as an alarm, with at most a handful of items", () => {
    const rejected = Array.from({ length: 8 }, () => ({ orderHash: HASH, reasons: ["The premium leg does not pay the vault."] }));
    const notice = keeperNotice(state(), keeperBook({ rejected }), false);
    expect(notice?.tone).toBe("bad");
    expect(notice?.items).toHaveLength(NOTICE_ITEMS + 1);
    expect(notice?.items?.at(-1)).toBe(`and ${8 - NOTICE_ITEMS} more.`);
  });

  it("renders a chain read failure as a warning that does not blame the keeper", () => {
    const notice = keeperNotice(
      state(),
      keeperBook({ unchecked: [{ orderHash: HASH, reasons: ["The chain could not be read for this order, so it is not offered yet."] }] }),
      false,
    );
    expect(notice).toMatchObject({ tone: "warn", heading: "The keeper fallback is unavailable right now." });
    expect(text(notice)).toContain("The chain could not be read, so the keeper's order is not offered yet.");
    expect(text(notice)).not.toContain("did not check out");
  });

  it("renders a route error under a source-neutral heading, in the route's words", () => {
    const notice = keeperNotice(state(), keeperBook({ error: "The vault could not be read from the chain, so the keeper's orders cannot be checked." }), false);
    expect(notice).toMatchObject({ tone: "warn", heading: "The keeper fallback is unavailable right now." });
    expect(notice?.heading).not.toContain("keeper could not be read");
  });

  it("says nothing when the keeper's card is on the page or the keeper was not asked", () => {
    expect(keeperNotice(state(), keeperBook({ rejected: [{ orderHash: OLD_HASH, reasons: ["x"] }] }), true)).toBeNull();
    expect(keeperNotice(state(), undefined, false)).toBeNull();
  });
});
