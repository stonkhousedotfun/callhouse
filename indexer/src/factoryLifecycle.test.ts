/**
 * lib/factoryLifecycle.ts: the pure decisions the factory-market handlers delegate, pinned
 * against contracts/src/solo/Account.sol and AccountFactory.sol. The handlers themselves
 * (src/factory.ts, src/writerAccount.ts) import `ponder:registry` and cannot be unit-tested
 * (vitest.config.ts); everything they decide is here.
 */
import { describe, expect, it } from "vitest";

import {
  ZERO_WEEK_TOTALS,
  accountAfterSettled,
  accountExpiryTs,
  factorySettings,
  marketWeekId,
  nextStatus,
  pendingContribution,
  pendingLotsAfter,
  settlementOutcome,
  txLogId,
  weekAfterFill,
  weekAfterListing,
  weekAfterSettlement,
  weekTotals,
  type FactoryPolicyTuple,
  type WriterAccountStatus,
} from "../lib/factoryLifecycle";
import { writerAccountStatus } from "../ponder.schema";

const LOT = 10n ** 18n;
const FACTORY = "0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb" as const;

describe("nextStatus (WriteRequested / LotsListed / Settled)", () => {
  it("WriteRequested(0) is idle: the owner withdrew the request", () => {
    expect(nextStatus({ kind: "WriteRequested", lots: 0n })).toBe("idle");
  });

  it("WriteRequested(n) is pending: in the keeper's list until listFor", () => {
    expect(nextStatus({ kind: "WriteRequested", lots: 1n })).toBe("pending");
    expect(nextStatus({ kind: "WriteRequested", lots: 50n })).toBe("pending");
  });

  it("LotsListed is listed, Settled is settled", () => {
    expect(nextStatus({ kind: "LotsListed" })).toBe("listed");
    expect(nextStatus({ kind: "Settled" })).toBe("settled");
  });

  it("every status the helpers produce is a schema enum value, and every enum value is produced (X-2)", () => {
    const produced = new Set<WriterAccountStatus>(["idle"]);
    produced.add(nextStatus({ kind: "WriteRequested", lots: 0n }));
    produced.add(nextStatus({ kind: "WriteRequested", lots: 3n }));
    produced.add(nextStatus({ kind: "LotsListed" }));
    produced.add(nextStatus({ kind: "Settled" }));
    produced.add(accountAfterSettled({ optionId: 1n }, "expired").status);
    expect([...produced].sort()).toEqual([...writerAccountStatus.enumValues].sort());
  });
});

describe("pendingLots (the keeper's work queue)", () => {
  it("only a pending account contributes, and it contributes its whole request", () => {
    expect(pendingContribution({ status: "pending", requestedLots: 7n })).toBe(7n);
    expect(pendingContribution({ status: "idle", requestedLots: 7n })).toBe(0n);
    // `requestedLots` stays on chain through the listing; it must not count while listed.
    expect(pendingContribution({ status: "listed", requestedLots: 7n })).toBe(0n);
    expect(pendingContribution({ status: "settled", requestedLots: 0n })).toBe(0n);
  });

  it("a request adds, a re-request replaces, a zero request removes", () => {
    const idle = { status: "idle" as const, requestedLots: 0n };
    const five = { status: "pending" as const, requestedLots: 5n };
    const eight = { status: "pending" as const, requestedLots: 8n };
    expect(pendingLotsAfter(10n, idle, five)).toBe(15n);
    expect(pendingLotsAfter(15n, five, eight)).toBe(18n);
    expect(pendingLotsAfter(18n, eight, { status: "idle", requestedLots: 0n })).toBe(10n);
  });

  it("listing takes the request out of the queue; settling a listed account changes nothing", () => {
    const five = { status: "pending" as const, requestedLots: 5n };
    const listed = { status: "listed" as const, requestedLots: 5n };
    const settled = { status: "settled" as const, requestedLots: 0n };
    expect(pendingLotsAfter(15n, five, listed)).toBe(10n);
    expect(pendingLotsAfter(10n, listed, settled)).toBe(10n);
  });

  it("floors at zero for a replay that missed the request", () => {
    const five = { status: "pending" as const, requestedLots: 5n };
    expect(pendingLotsAfter(0n, five, { status: "listed", requestedLots: 5n })).toBe(0n);
  });
});

describe("settlementOutcome (Settled(nvdaReturned, strikeUsdg) against the listing's fills)", () => {
  it("no fills is unfilled: Settled(0, 0) with no claim, the most likely outcome", () => {
    expect(settlementOutcome({ filledLots: 0n, assetReturned: 0n, strikeUsdg: 0n })).toBe("unfilled");
  });

  it("strike USDG in is assigned, with or without collateral coming back beside it", () => {
    expect(settlementOutcome({ filledLots: 3n, assetReturned: 0n, strikeUsdg: 3n * 223_000000n })).toBe("assigned");
    // Partial assignment: two of three taken at the strike, one lot's collateral back.
    expect(settlementOutcome({ filledLots: 3n, assetReturned: LOT, strikeUsdg: 2n * 223_000000n })).toBe("assigned");
  });

  it("collateral back and no USDG is expired out of the money", () => {
    expect(settlementOutcome({ filledLots: 3n, assetReturned: 3n * LOT, strikeUsdg: 0n })).toBe("expired");
  });

  it("fills and nothing back at all is unredeemed: the redeem reverted and the account keeps its claim", () => {
    expect(settlementOutcome({ filledLots: 3n, assetReturned: 0n, strikeUsdg: 0n })).toBe("unredeemed");
  });
});

describe("accountAfterSettled", () => {
  it("resets the request, the listing and the pinned week, exactly as settle() does", () => {
    expect(accountAfterSettled({ optionId: 77n }, "expired")).toEqual({
      status: "settled",
      requestedLots: 0n,
      listedLots: 0n,
      filledLots: 0n,
      listedWeekId: null,
      listedAskUsdg: 0n,
      optionId: null,
    });
    expect(accountAfterSettled({ optionId: 77n }, "unfilled").optionId).toBeNull();
    expect(accountAfterSettled({ optionId: 77n }, "assigned").optionId).toBeNull();
  });

  it("keeps the option id on an unredeemed week, as optionId() on chain still names the stuck claim's type", () => {
    expect(accountAfterSettled({ optionId: 77n }, "unredeemed").optionId).toBe(77n);
    expect(accountAfterSettled({ optionId: 77n }, "unredeemed").status).toBe("settled");
  });
});

describe("week totals", () => {
  it("accumulate listings, fills and settlements, starting from a row of zeros", () => {
    let w = ZERO_WEEK_TOTALS;
    w = weekAfterListing(w, 3n);
    w = weekAfterListing(w, 2n);
    expect(w).toEqual({ ...ZERO_WEEK_TOTALS, lotsListed: 5n, accountsListed: 2 });

    w = weekAfterFill(w, 1_000000n);
    w = weekAfterFill(w, 1_000000n);
    w = weekAfterFill(w, 1_000000n);
    expect(w.lotsFilled).toBe(3n);
    expect(w.premiumUsdg).toBe(3_000000n);

    // Account A (3 lots, all filled) assigned at 223; account B (2 lots, unfilled) flat.
    w = weekAfterSettlement(w, { assetReturned: 0n, strikeUsdg: 3n * 223_000000n });
    w = weekAfterSettlement(w, { assetReturned: 0n, strikeUsdg: 0n });
    expect(w).toEqual({
      lotsListed: 5n,
      lotsFilled: 3n,
      premiumUsdg: 3_000000n,
      accountsListed: 2,
      accountsSettled: 2,
      assetReturned: 0n,
      assignedUsdg: 669_000000n,
    });
  });

  it("return only the seven totals, so a market_week row can be passed in and the result spread into a patch", () => {
    const row = { id: "x", factory: FACTORY, weekId: 1, strikeUsdg: 223_000000n, ...ZERO_WEEK_TOTALS };
    expect(Object.keys(weekAfterListing(row, 1n)).sort()).toEqual(Object.keys(ZERO_WEEK_TOTALS).sort());
    expect(weekTotals(row)).toEqual(ZERO_WEEK_TOTALS);
  });
});

describe("keys", () => {
  it("market_week is factory-weekId, lower-cased; fills and settlements are tx-logIndex", () => {
    expect(marketWeekId(FACTORY, 1)).toBe("0xc4a5cd0de91cab7f5ebe2114bc63fbb43e642bbb-1");
    expect(marketWeekId(FACTORY, 12n)).toBe("0xc4a5cd0de91cab7f5ebe2114bc63fbb43e642bbb-12");
    expect(txLogId(`0x${"AB".repeat(32)}`, 7)).toBe(`0x${"ab".repeat(32)}-7`);
  });

  it("an account's expiry is the week's base expiry plus its index, one second each (Account.sol list())", () => {
    expect(accountExpiryTs(1_800_000_000n, 1)).toBe(1_800_000_001n);
    expect(accountExpiryTs(1_800_000_000n, 35)).toBe(1_800_000_035n);
  });
});

describe("factorySettings (Factory:setup)", () => {
  // policy() on the live NVDA factory at 2026-09-15: (300, 1200, 40, 9500, 500, 50), per ops/markets/tier1.json.
  const POLICY: FactoryPolicyTuple = [300, 1200, 40, 9500, 500, 50n];
  const ASSET = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
  const FEED = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15";
  const CLEAR = "0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6";
  const IMPL = "0xe412A596B000f73ad19B39f51dfd0B17A15F45EC";
  const ADMIN = "0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b";
  const MAX = 2n ** 256n - 1n;

  it("seeds every column that answered: the four immutables, the six policy fields, the recipient and the cap", () => {
    expect(
      factorySettings({ asset: ASSET, feed: FEED, clear: CLEAR, implementation: IMPL, policy: POLICY, feeRecipient: ADMIN, depositCap: MAX }),
    ).toEqual({
      asset: ASSET,
      feed: FEED,
      clear: CLEAR,
      implementation: IMPL,
      minOtmBps: 300,
      maxOtmBps: 1200,
      minPremiumBps: 40,
      maxUtilizationBps: 9500,
      protocolFeeBps: 500,
      maxContractsCap: 50n,
      feeRecipient: ADMIN,
      depositCap: MAX,
    });
  });

  it("seeds nothing it could not read (no archive RPC), so the columns stay null and unverified rather than zero", () => {
    expect(factorySettings({ asset: null, feed: null, clear: null, implementation: null, policy: null, feeRecipient: null, depositCap: null })).toEqual({});
    // The immutables answer at the head on the public RPC while the pinned batch does not.
    expect(factorySettings({ asset: ASSET, feed: FEED, clear: CLEAR, implementation: IMPL, policy: null, feeRecipient: null, depositCap: null })).toEqual({
      asset: ASSET,
      feed: FEED,
      clear: CLEAR,
      implementation: IMPL,
    });
  });

  it("treats a zero address as no factory at that block: the constructor reverts ZeroAddr on every one of them", () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    expect(factorySettings({ asset: ZERO, feed: ZERO, clear: ZERO, implementation: ZERO, policy: null, feeRecipient: ZERO, depositCap: 0n })).toEqual({ depositCap: 0n });
  });
});
