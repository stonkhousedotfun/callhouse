import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { KeeperOrderBook } from "./api";
import {
  NOTICE_ITEMS,
  feedNotice,
  listingNotice,
  shouldAskFeed,
  windowClosed,
  type CycleListingState,
  type Notice,
} from "./cycleNotices";

/**
 * What the cycle page says about the vault's listing. Each case is a screen a reviewer found
 * saying something false: a sold-out week rendered as an alarm and then as "escalate", a
 * finished order still being fetched from the feed, and an RPC failure blamed on the keeper.
 *
 * The vault's order is 23 contracts. Seaport's fraction is reduced, as Seaport stores it.
 */
const HASH = "0x4a5b6c7d8e9f00112233445566778899aabbccddeeff00112233445566778899" as Hex;
const OLD_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const NOW = 1_789_000_000;

function state(overrides: Partial<CycleListingState> = {}): CycleListingState {
  return {
    vaultConfigured: true,
    phase: 1,
    listingHash: HASH,
    listingAmount: 23n,
    seaportStatus: { isCancelled: false, totalFilled: 0n, totalSize: 0n },
    cycleExerciseTs: NOW + 3_600,
    nowSeconds: NOW,
    ...overrides,
  };
}

function feed(overrides: Partial<KeeperOrderBook> = {}): KeeperOrderBook {
  return { configured: true, listings: [], rejected: [], closed: [], unchecked: [], ...overrides };
}

function text(notice: Notice | "loading" | null): string {
  if (notice === null || notice === "loading") throw new Error(`expected a notice, got ${String(notice)}`);
  return `${notice.heading} ${notice.body} ${(notice.items ?? []).join(" ")}`;
}

const SOLD_OUT = { isCancelled: false, totalFilled: 1n, totalSize: 1n };

describe("a finished order (Seaport decides)", () => {
  it("a sold-out week is a neutral notice, the feed is not asked, and nothing says escalate", () => {
    const s = state({ seaportStatus: SOLD_OUT });
    expect(shouldAskFeed(s)).toBe(false);
    const notice = listingNotice(s);
    expect(notice).toMatchObject({ tone: "info", heading: "Every contract in the vault's order has been bought, per Seaport." });
    expect(text(notice)).not.toMatch(/escalate|unfilled week|did not check out/);
    expect(feedNotice(s, undefined, false)).toBeNull();
  });

  it("a cancelled order is information, not an alarm", () => {
    const s = state({ seaportStatus: { isCancelled: true, totalFilled: 0n, totalSize: 0n } });
    expect(shouldAskFeed(s)).toBe(false);
    expect(listingNotice(s)).toMatchObject({ tone: "info", heading: "Seaport reports the vault's order as cancelled." });
  });

  it("when the route saw the sale before the page did, the feed notice says sold, in info", () => {
    const s = state({ seaportStatus: undefined });
    const notice = feedNotice(s, feed({ closed: [{ orderHash: HASH, state: "soldOut" }] }), false);
    expect(notice).toMatchObject({ tone: "info", heading: "Every contract in the vault's order has been bought, per Seaport." });
  });

  it("a superseded order the keeper still serves does not soften the missing-order warning", () => {
    const notice = feedNotice(state(), feed({ closed: [{ orderHash: OLD_HASH, state: "notCurrent" }] }), false);
    expect(notice).toMatchObject({ tone: "warn", heading: "The keeper is not serving the order the vault has authorised." });
    expect(text(notice)).toContain("An unserved order is an unfilled week; this is the thing to escalate.");
  });
});

describe("the chain's own state comes first", () => {
  it("says nothing before the vault has been read, and 'no listing' once it has", () => {
    expect(listingNotice(state({ listingHash: undefined }))).toBeNull();
    const zero = listingNotice(state({ listingHash: `0x${"0".repeat(64)}` as Hex }));
    expect(zero).toMatchObject({ tone: "info", heading: "No listing is authorised on chain right now." });
    expect(text(zero)).toContain("armed this week's option type but the keeper has not yet authorised an order");
    expect(text(listingNotice(state({ listingHash: `0x${"0".repeat(64)}` as Hex, phase: 0 })))).toContain("nothing to buy until then");
    expect(shouldAskFeed(state({ listingHash: `0x${"0".repeat(64)}` as Hex }))).toBe(false);
  });

  it("the sale window closing is information with Seaport's unsold count, not a keeper fault", () => {
    const s = state({ cycleExerciseTs: NOW - 1, seaportStatus: { isCancelled: false, totalFilled: 3n, totalSize: 23n } });
    expect(windowClosed(s)).toBe(true);
    const notice = listingNotice(s);
    expect(notice).toMatchObject({ tone: "info", heading: "This week's sale window has closed." });
    expect(text(notice)).toContain("WriteWindowClosed");
    expect(text(notice)).toContain("Seaport shows 20 of 23 contracts still unsold.");
    // The clock has not started: nothing is closed yet.
    expect(windowClosed(state({ cycleExerciseTs: NOW - 1, nowSeconds: 0 }))).toBe(false);
  });

  it("a vault outside Listed cannot be filled, whatever the slot says", () => {
    for (const [phase, word] of [
      [2, "Exercisable"],
      [3, "Settling"],
      [0, "Idle"],
    ] as const) {
      const notice = listingNotice(state({ phase }));
      expect(notice).toMatchObject({ tone: "info", heading: "The vault is not in its Listed phase, so its order cannot be filled." });
      expect(text(notice)).toContain(word);
    }
    expect(listingNotice(state())).toBeNull();
  });

  it("decides nothing about the feed before the clock has started", () => {
    expect(shouldAskFeed(state({ nowSeconds: 0 }))).toBe(false);
    expect(shouldAskFeed(state({ vaultConfigured: false }))).toBe(false);
    expect(shouldAskFeed(state())).toBe(true);
    expect(feedNotice(state(), "loading", false)).toBe("loading");
  });
});

describe("the feed notice: only integrity is red", () => {
  it("says the feed is not wired, in the operator's terms, when the route is unconfigured", () => {
    const notice = feedNotice(state(), feed({ configured: false }), false);
    expect(notice).toMatchObject({ tone: "warn", heading: "This deployment is not connected to the keeper's order feed." });
    expect(text(notice)).toContain("KEEPER_ORDERS_URL");
  });

  it("renders a rejection as an alarm, with at most a handful of items", () => {
    const rejected = Array.from({ length: 8 }, () => ({ orderHash: HASH, reasons: ["The payment leg does not pay the vault."] }));
    const notice = feedNotice(state(), feed({ rejected }), false);
    expect(notice).not.toBe("loading");
    expect((notice as Notice).tone).toBe("bad");
    expect((notice as Notice).items).toHaveLength(NOTICE_ITEMS + 1);
    expect((notice as Notice).items?.at(-1)).toBe(`and ${8 - NOTICE_ITEMS} more.`);
  });

  it("renders a chain read failure as a warning that does not blame the keeper", () => {
    const notice = feedNotice(
      state(),
      feed({ unchecked: [{ orderHash: HASH, reasons: ["The chain could not be read for this order, so it is not offered yet."] }] }),
      false,
    );
    expect(notice).toMatchObject({ tone: "warn", heading: "The order feed is unavailable right now." });
    expect(text(notice)).toContain("The chain could not be read, so the keeper's order is not offered yet.");
    expect(text(notice)).not.toContain("did not check out");
  });

  it("renders a route error under a source-neutral heading, in the route's words", () => {
    const notice = feedNotice(state(), feed({ error: "The vault could not be read from the chain, so the keeper's orders cannot be checked." }), false);
    expect(notice).toMatchObject({ tone: "warn", heading: "The order feed is unavailable right now." });
    expect((notice as Notice).heading).not.toContain("keeper could not be read");
  });

  it("names a closed state for the authorised hash as information", () => {
    for (const [stateName, heading] of [
      ["cancelled", "Seaport reports the vault's order as cancelled."],
      ["notListed", "The vault is no longer in its Listed phase, so its order cannot be filled."],
      ["expired", "The vault's order has passed its end time."],
    ] as const) {
      const notice = feedNotice(state(), feed({ closed: [{ orderHash: HASH, state: stateName }] }), false);
      expect(notice).toMatchObject({ tone: "info", heading });
    }
  });

  it("says nothing when the order's card is on the page or the feed was not asked", () => {
    expect(feedNotice(state(), feed({ rejected: [{ orderHash: OLD_HASH, reasons: ["x"] }] }), true)).toBeNull();
    expect(feedNotice(state(), undefined, false)).toBeNull();
  });
});
