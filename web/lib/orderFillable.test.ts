import { describe, expect, it } from "vitest";

import { cycleTerms } from "./cycleTerms";
import { fillableForTerms, type FillableInput } from "./orderFillable";

const HASH = `0x${"ab".repeat(32)}` as const;
const OTHER = `0x${"cd".repeat(32)}` as const;
const ZERO = `0x${"00".repeat(32)}` as const;

function live(overrides: Partial<FillableInput> = {}): FillableInput {
  return { phase: 1, listingHash: HASH, listingAmount: 23n, windowClosed: false, ...overrides };
}

describe("fillableForTerms: no order figure without a live, sellable order", () => {
  it.each([
    ["hash unread", { listingHash: undefined }],
    ["hash zero", { listingHash: ZERO }],
    ["Idle", { phase: 0 }],
    ["Exercisable", { phase: 2 }],
    ["phase unread", { phase: undefined }],
    ["size unread", { listingAmount: undefined }],
    ["size zero", { listingAmount: 0n }],
    ["sale window closed", { windowClosed: true }],
  ] as const)("%s", (_name, overrides) => {
    const seaportStatus = { isCancelled: false, totalFilled: 0n, totalSize: 0n };
    expect(fillableForTerms(live({ ...overrides, seaportStatus }))).toBeUndefined();
  });
});

describe("fillableForTerms: preference", () => {
  it("Seaport's own reading wins over the feed row", () => {
    const got = fillableForTerms(
      live({
        seaportStatus: { isCancelled: false, totalFilled: 5n, totalSize: 23n },
        rows: [{ orderHash: HASH, remaining: "23" }],
      }),
    );
    expect(got).toEqual({ contracts: 18n, source: "seaport" });
  });

  it("Seaport's reduced fraction scales to the size, and cancelled is 0", () => {
    expect(fillableForTerms(live({ listingAmount: 20n, seaportStatus: { isCancelled: false, totalFilled: 1n, totalSize: 4n } }))).toEqual({
      contracts: 15n,
      source: "seaport",
    });
    expect(fillableForTerms(live({ seaportStatus: { isCancelled: true, totalFilled: 0n, totalSize: 0n } }))).toEqual({
      contracts: 0n,
      source: "seaport",
    });
  });

  it("the route's row for the same hash (case-insensitive), capped at the size", () => {
    expect(fillableForTerms(live({ rows: [{ orderHash: OTHER, remaining: "1" }, { orderHash: HASH.toUpperCase().replace("0X", "0x"), remaining: "18" }] }))).toEqual({
      contracts: 18n,
      source: "route",
    });
    expect(fillableForTerms(live({ rows: [{ orderHash: HASH, remaining: "99" }] }))).toEqual({ contracts: 23n, source: "route" });
  });

  it("a row for another hash, or with a malformed remaining, is not used", () => {
    expect(fillableForTerms(live({ rows: [{ orderHash: OTHER, remaining: "1" }] }))).toBeUndefined();
    expect(fillableForTerms(live({ rows: [{ orderHash: HASH, remaining: "-1" }] }))).toBeUndefined();
    expect(fillableForTerms(live({ rows: [{ orderHash: HASH }] }))).toBeUndefined();
  });

  it("neither Seaport nor the route has a count: no figure, never the whole listing", () => {
    expect(fillableForTerms(live())).toBeUndefined();
    expect(fillableForTerms(live({ rows: [], closed: [] }))).toBeUndefined();
  });

  it.each(["soldOut", "cancelled", "expired"])("the route reports this hash %s: 0", (state) => {
    expect(fillableForTerms(live({ closed: [{ orderHash: HASH, state }] }))).toEqual({ contracts: 0n, source: "closed" });
  });

  it("a closed state for another hash, or notCurrent, gives no figure", () => {
    expect(fillableForTerms(live({ closed: [{ orderHash: OTHER, state: "soldOut" }] }))).toBeUndefined();
    expect(fillableForTerms(live({ closed: [{ orderHash: HASH, state: "notCurrent" }] }))).toBeUndefined();
    expect(fillableForTerms(live({ closed: [{ orderHash: null, state: "soldOut" }] }))).toBeUndefined();
  });

  it("Seaport's count wins over a route closed state for the same hash", () => {
    expect(
      fillableForTerms(live({ seaportStatus: { isCancelled: false, totalFilled: 5n, totalSize: 23n }, closed: [{ orderHash: HASH, state: "soldOut" }] })),
    ).toEqual({ contracts: 18n, source: "seaport" });
  });
});

describe("fillableForTerms into cycleTerms", () => {
  const snapshot = {
    phase: 1,
    cycleStrikeUsdg: 222_000_000n,
    cycleExerciseTs: 1789761600,
    cycleExpiryTs: 1789848000,
    spotUsdg: 212_345_678n,
    listingGrossUsdg: 23n * 414_137n,
    listingAmount: 23n,
    contractsWritten: 5n,
    capacity: 18n,
    policy: { minOtmBps: 300, maxOtmBps: 1200, minPremiumBps: 5, maxUtilizationBps: 9000, protocolFeeBps: 500, maxContractsCap: 1000n },
  };

  it("the route's count is capped at capacity by cycleTerms", () => {
    const fillable = fillableForTerms(live({ rows: [{ orderHash: HASH, remaining: "23" }] }));
    const terms = cycleTerms(snapshot, { fillableContracts: fillable?.contracts });
    expect(terms?.fillableContracts).toBe(18n);
    expect(terms?.orderGrossIfAllFill6).toBe(18n * 414_137n);
    expect(terms?.orderFeeIfAllFill6).toBe((18n * 414_137n * 500n) / 10_000n);
  });

  it("23 listed, 5 sold, capacity 30: 18 left with Seaport read, and no figure (not 23) without it", () => {
    const roomy = { ...snapshot, capacity: 30n };
    const read = cycleTerms(roomy, {
      fillableContracts: fillableForTerms(live({ seaportStatus: { isCancelled: false, totalFilled: 5n, totalSize: 23n } }))?.contracts,
    });
    expect(read?.fillableContractsFmt).toBe("18");
    expect(read?.orderGrossIfAllFill6).toBe(18n * 414_137n);
    const unread = cycleTerms(roomy, { fillableContracts: fillableForTerms(live({ rows: [], closed: [] }))?.contracts });
    expect(unread?.fillableContractsFmt).toBe("—");
    expect(unread?.orderGrossIfAllFillFmt).toBe("—");
    expect(unread?.orderFeeIfAllFillFmt).toBe("—");
  });

  it("no fillable figure, no order total", () => {
    const terms = cycleTerms(snapshot, { fillableContracts: fillableForTerms(live({ windowClosed: true }))?.contracts });
    expect(terms?.orderGrossIfAllFillFmt).toBe("—");
    expect(terms?.orderFeeIfAllFillFmt).toBe("—");
  });
});
