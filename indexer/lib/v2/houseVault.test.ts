import { describe, expect, it } from "vitest";

import {
  applyTransferSupply,
  decodeLimits,
  epochRowId,
  houseFillRows,
  lower,
  meta,
  nextShareBalance,
  queueId,
  shareBalanceId,
} from "./houseVault";

const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0x00000000000000000000000000000000000000AA";
const B = "0x00000000000000000000000000000000000000BB";
const TX = `0x${"c".repeat(64)}` as const;

const event = (maker: string, taker: string) => ({
  block: { timestamp: 1_700_000_000n, number: 42n },
  log: { logIndex: 3, address: "0x000000000000000000000000000000000000Ab0C" as const },
  transaction: { hash: TX },
  args: {
    orderId: 7n, longId: 9n, maker: maker as `0x${string}`, taker: taker as `0x${string}`,
    units: 5n, price: 1_250_000n, premium: 6_250_000n, sellerFee: 12_500n, makerRebate: 2_500n,
  },
});

describe("house vault row keys", () => {
  it("lower-cases addresses in every composite key", () => {
    expect(lower("0xAbC")).toBe("0xabc");
    expect(epochRowId(A, 12n)).toBe(`${A.toLowerCase()}-12`);
    expect(shareBalanceId(A, B)).toBe(`${A.toLowerCase()}-${B.toLowerCase()}`);
    expect(queueId(B, A)).toBe(`${B.toLowerCase()}-${A.toLowerCase()}`);
  });

  it("builds provenance from tx hash and log index with a lower-cased source", () => {
    expect(meta(event(A, B))).toEqual({
      id: `${TX}-3`,
      sourceAddress: "0x000000000000000000000000000000000000ab0c",
      ts: 1_700_000_000n,
      block: 42n,
      logIndex: 3,
      tx: TX,
    });
  });
});

describe("decodeLimits", () => {
  const expected = {
    maxSeriesUnits: 100n,
    maxTotalNotional: 5_000_000_000n,
    askToleranceBps: 250,
    maxBidBpsOfSpot: 9_000,
    maxOrderLifetime: 86_400,
    maxDailyOutflow: 1_000_000n,
  };

  it("decodes the positional 6-tuple form, coercing numbers and strings", () => {
    expect(decodeLimits([100, "5000000000", 250n, "9000", 86_400n, 1_000_000])).toEqual(expected);
  });

  it("decodes the named-object form", () => {
    expect(decodeLimits({ ...expected, askToleranceBps: 250n, maxDailyOutflow: "1000000" })).toEqual(expected);
  });

  it("treats a short array as an object and fails loudly instead of inventing limits", () => {
    expect(() => decodeLimits([1, 2, 3])).toThrow();
  });
});

describe("share balance and supply reducers", () => {
  it("accumulates balances from an unseen holder and refuses a negative balance", () => {
    expect(nextShareBalance(undefined, 10n)).toBe(10n);
    expect(nextShareBalance(10n, -10n)).toBe(0n);
    expect(() => nextShareBalance(5n, -6n)).toThrow("share balance went negative");
  });

  it("adds on mint, subtracts on burn, and ignores holder-to-holder transfers", () => {
    expect(applyTransferSupply(undefined, ZERO, A, 100n)).toBe(100n);
    expect(applyTransferSupply(100n, A, ZERO, 40n)).toBe(60n);
    expect(applyTransferSupply(60n, A, B, 60n)).toBe(60n);
    expect(applyTransferSupply(undefined, A, B, 5n)).toBe(0n);
    // A zero-to-zero log (not emitted by an ERC20, but decodable) counts as a mint.
    expect(applyTransferSupply(1n, ZERO, ZERO, 2n)).toBe(3n);
  });

  it("refuses a burn larger than the recorded supply", () => {
    expect(() => applyTransferSupply(10n, A, ZERO, 11n)).toThrow("share supply went negative");
    expect(() => applyTransferSupply(undefined, A, ZERO, 1n)).toThrow("share supply went negative");
  });
});

describe("houseFillRows", () => {
  it("emits a maker row only when the maker is a tracked vault", () => {
    const rows = houseFillRows(event(A, B), new Set([A.toLowerCase()]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `${TX}-3-maker`, vault: A.toLowerCase(), side: "maker",
      maker: A.toLowerCase(), taker: B.toLowerCase(),
      units: 5n, price: 1_250_000n, premium: 6_250_000n, sellerFee: 12_500n, makerRebate: 2_500n,
      orderId: 7n, longId: 9n, ts: 1_700_000_000n, block: 42n, logIndex: 3, tx: TX,
    });
  });

  it("emits a taker row, and both rows when both sides are vaults", () => {
    expect(houseFillRows(event(A, B), new Set([B.toLowerCase()])).map((r) => [r.side, r.vault]))
      .toEqual([["taker", B.toLowerCase()]]);
    expect(houseFillRows(event(A, B), new Set([A.toLowerCase(), B.toLowerCase()])).map((r) => r.id))
      .toEqual([`${TX}-3-maker`, `${TX}-3-taker`]);
  });

  it("records a self-fill by one vault once, and nothing for untracked parties", () => {
    expect(houseFillRows(event(A, A), new Set([A.toLowerCase()])).map((r) => r.side)).toEqual(["maker"]);
    expect(houseFillRows(event(A, B), new Set())).toEqual([]);
  });
});
