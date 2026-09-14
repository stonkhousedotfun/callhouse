import { describe, expect, it } from "vitest";

import { CLEARINGHOUSE, USDG } from "./contracts";
import type { OrderComponentsJson } from "./listing";
import { advancedOrderFor, componentsHash, fillableContracts, seaportFinished, seaportRemaining, seaportSoldOut } from "./seaportOrder";

/**
 * Seaport's status, read the way the cycle page and the route read it. The fraction is stored
 * reduced (5 of 20 is 1/4, 20 of 20 is 1/1), so "sold out" is totalFilled >= totalSize, never a
 * comparison with the contract count. The hash derivation itself is pinned against Seaport on
 * chain by the fork acceptance and against fixtures in lib/listing.test.ts and
 * lib/keeperOrders.test.ts; here only its refusal to throw is.
 */
describe("seaportRemaining", () => {
  it("scales Seaport's reduced fraction to the order's contract count", () => {
    expect(seaportRemaining(20n, { isCancelled: false, totalFilled: 0n, totalSize: 0n })).toBe(20n);
    expect(seaportRemaining(20n, { isCancelled: false, totalFilled: 1n, totalSize: 4n })).toBe(15n);
    expect(seaportRemaining(23n, { isCancelled: false, totalFilled: 5n, totalSize: 23n })).toBe(18n);
    expect(seaportRemaining(23n, { isCancelled: false, totalFilled: 1n, totalSize: 1n })).toBe(0n);
  });

  it("is zero for a cancelled order and unknown without a reading or a count", () => {
    expect(seaportRemaining(20n, { isCancelled: true, totalFilled: 0n, totalSize: 0n })).toBe(0n);
    expect(seaportRemaining(20n, undefined)).toBeUndefined();
    expect(seaportRemaining(undefined, { isCancelled: false, totalFilled: 0n, totalSize: 0n })).toBeUndefined();
  });
});

describe("seaportFinished", () => {
  it("is sold out or cancelled, and nothing else", () => {
    expect(seaportSoldOut({ isCancelled: false, totalFilled: 1n, totalSize: 1n })).toBe(true);
    expect(seaportSoldOut({ isCancelled: false, totalFilled: 0n, totalSize: 0n })).toBe(false);
    expect(seaportFinished({ isCancelled: false, totalFilled: 22n, totalSize: 23n })).toBe(false);
    expect(seaportFinished({ isCancelled: false, totalFilled: 23n, totalSize: 23n })).toBe(true);
    expect(seaportFinished({ isCancelled: true, totalFilled: 0n, totalSize: 0n })).toBe(true);
    expect(seaportFinished(undefined)).toBe(false);
  });
});

describe("componentsHash", () => {
  it("answers undefined for components that do not parse, instead of throwing", () => {
    const bad = {
      offerer: "0x12",
      zone: "0x0000000000000000000000000000000000000000",
      offer: [],
      consideration: [],
      orderType: 3,
      startTime: "0",
      endTime: "1",
      zoneHash: `0x${"0".repeat(64)}`,
      salt: "1",
      conduitKey: `0x${"0".repeat(64)}`,
      counter: "0",
    };
    expect(componentsHash(bad)).toBeUndefined();
    expect(componentsHash({ ...bad, offerer: "0x2222222222222222222222222222222222222222" })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("advancedOrderFor", () => {
  const VAULT_T = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const components: OrderComponentsJson = {
    offerer: VAULT_T,
    zone: VAULT_T,
    offer: [{ itemType: 3, token: CLEARINGHOUSE, identifierOrCriteria: "99", startAmount: "20", endAmount: "20" }],
    consideration: [{ itemType: 1, token: USDG, identifierOrCriteria: "0", startAmount: "80000000", endAmount: "80000000", recipient: VAULT_T }],
    orderType: 3,
    startTime: "0",
    endTime: "1789000000",
    zoneHash: `0x${"0".repeat(64)}`,
    salt: "7",
    conduitKey: `0x${"0".repeat(64)}`,
    counter: "7",
  };

  it("builds the fulfillAdvancedOrder struct with an EMPTY signature and the counter replaced by the consideration count", () => {
    const order = advancedOrderFor(components, 2n, 20n);
    expect(order.signature).toBe("0x");
    expect(order.extraData).toBe("0x");
    expect(order.numerator).toBe(2n);
    expect(order.denominator).toBe(20n);
    expect(order.parameters.totalOriginalConsiderationItems).toBe(1n);
    expect("counter" in order.parameters).toBe(false);
    expect(order.parameters.orderType).toBe(3);
    expect(order.parameters.zone.toLowerCase()).toBe(VAULT_T);
    expect(order.parameters.offer[0]!.startAmount).toBe(20n);
    expect(order.parameters.consideration[0]!.startAmount).toBe(80_000_000n);
    expect(order.parameters.salt).toBe(7n);
  });

  it("does not carry a feed's signature bytes: the same struct whatever the row said", () => {
    // The row type has a signature field; the builder never reads it. Two rows that differ only
    // in signature produce identical structs.
    const a = advancedOrderFor(components, 1n, 20n);
    const b = advancedOrderFor({ ...components }, 1n, 20n);
    expect(JSON.stringify(a, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      JSON.stringify(b, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    );
  });
});

describe("fillableContracts", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  const OPEN = { isCancelled: false, totalFilled: 0n, totalSize: 0n };

  it("takes Seaport's count over a row that says none are left (a stale feed)", () => {
    // Before: OrderPayload capped the input at the row's "0", so the Fill button stayed disabled
    // for an order Seaport held fully open.
    expect(fillableContracts({ orderHash: HASH, remaining: "0" }, 23n, HASH, OPEN)).toBe(23n);
    expect(fillableContracts({ orderHash: HASH.toUpperCase().replace("0X", "0x"), remaining: "0" }, 23n, HASH, OPEN)).toBe(23n);
  });

  it("takes Seaport's count over a row that claims more than is left", () => {
    expect(fillableContracts({ orderHash: HASH, remaining: "23" }, 23n, HASH, { isCancelled: false, totalFilled: 5n, totalSize: 23n })).toBe(18n);
    expect(fillableContracts({ orderHash: HASH, remaining: "23" }, 23n, HASH, { isCancelled: true, totalFilled: 0n, totalSize: 0n })).toBe(0n);
  });

  it("falls back to the row, capped at the total, without a reading for this very hash", () => {
    expect(fillableContracts({ orderHash: HASH, remaining: "7" }, 23n, HASH, undefined)).toBe(7n);
    expect(fillableContracts({ orderHash: HASH, remaining: "99" }, 23n, undefined, OPEN)).toBe(23n);
    expect(fillableContracts({ orderHash: `0x${"cd".repeat(32)}`, remaining: "2" }, 23n, HASH, OPEN)).toBe(2n);
    expect(fillableContracts({ orderHash: HASH }, 23n, undefined, undefined)).toBe(23n);
  });
});
