import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { HistoryItem, LongPosition, PositionsResponse } from "./api-types";
import { assertResaleFeeMatches, expiryCountdown, orderIdentityMatches, payoffSentence, positionOutcome, quoteSell, splitResale, verifySellOrders } from "./portfolio";

const positions = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../ops/fixtures/api/v2/accounts/0xE37876AcBfbA6186E4687f4ef465D9AC21558De3/positions.json", import.meta.url)), "utf8")) as PositionsResponse;
const [settled, settling, open] = positions.longs;

describe("portfolio position states", () => {
  it("distinguishes an open long, settlement in progress, and an unpaid settled long", () => {
    expect(payoffSentence(open!)).toMatch(/above \$222/);
    expect(expiryCountdown(open!.series.expiry, open!.series.expiry - 3_600)).toBe("1 hour left");
    expect(positionOutcome(open!, "long", [], open!.series.expiry - 86_400).label).toBe("Position is open.");
    expect(positionOutcome(settling!, "long", [], settling!.series.expiry + 1).label).toMatch(/finalized/);
    expect(positionOutcome(settled!, "long", [], settled!.series.expiry + 1)).toMatchObject({ collect: false, withdraw: false });
    expect(positionOutcome(settled!, "long", [], settled!.series.expiry + 1, 100n)).toMatchObject({ collect: true, withdraw: false });
    const defaultUsdg = { ...settled!, claimable: null };
    expect(positionOutcome(defaultUsdg, "long", [], settled!.series.expiry + 1, 100n).collect).toBe(true);
    expect(positionOutcome({ ...settled!, claimable: { raw: "0", decimals: 6, formatted: "0" } }, "long", [],
      settled!.series.expiry + 1, 100n).collect).toBe(true);
  });

  it("uses redemption history to identify wallet payouts and ledger balances", () => {
    const event = { kind: "redemption", longId: settled!.series.longId, data: {
      side: "long", amount: { raw: "2500000", decimals: 6, formatted: "2.5" }, toLedger: false,
    } } as HistoryItem;
    expect(positionOutcome(settled!, "long", [event], settled!.series.expiry + 1)).toEqual({
      label: "Paid 2.5 USDG to your wallet.", collect: false, withdraw: false,
    });
    expect(positionOutcome(settled!, "long", [{ ...event, data: { ...event.data, toLedger: true } } as HistoryItem], settled!.series.expiry + 1))
      .toMatchObject({ label: "Held in your Stonkhouse balance: 2.5 USDG.", withdraw: true });
  });

  it("rejects an order that changed between a displayed sell quote and chain preflight", () => {
    const quote = quoteSell([{ price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "40", orders: [
      { orderId: "17", maker: "0x1111111111111111111111111111111111111111", kind: "Bid", units: "40", onChainRemainingUnits: "40", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }, { price: { raw: "400000", decimals: 6, formatted: "0.4" }, units: "70", orders: [
      { orderId: "18", maker: "0x2222222222222222222222222222222222222222", kind: "Bid", units: "70", onChainRemainingUnits: "70", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }], 100n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1000 });
    expect(quote).toMatchObject({ filled: 100n, premium: 440_000n, fee: 44_000n, sellerFee: 0n, net: 396_000n, limitPrice: 400_000n,
      orderIds: ["17", "18"] });
    const current = quote.selected.map((row) => ({ orderId: BigInt(row.orderId), maker: row.maker, longId: 2n,
      kind: 0, price: row.price, units: row.units, filled: 0n, validUntil: 100, cancelled: false }));
    expect(verifySellOrders(quote, current, 2n, 99)).toBe(true);
    expect(verifySellOrders(quote, [{ ...current[0]!, price: 490_000n }, current[1]!], 2n, 99)).toBe(false);
    const feeQuote = quoteSell([{ price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "100", orders: [
      { orderId: "17", maker: "0x1111111111111111111111111111111111111111", kind: "Bid", units: "100", onChainRemainingUnits: "100", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
      { orderId: "18", maker: "0x2222222222222222222222222222222222222222", kind: "Bid", units: "100", onChainRemainingUnits: "100", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }], 100n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1000 }, 500,
    "0x1111111111111111111111111111111111111111");
    expect(feeQuote).toMatchObject({ orderIds: ["18"], sellerFee: 25_000n, net: 425_000n });
    const crossing = splitResale([{ price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "40", orders: [
      { orderId: "17", maker: "0x1111111111111111111111111111111111111111", kind: "Bid", units: "40", onChainRemainingUnits: "40", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }], 100n, 450_000n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1000 }, 0,
    "0x2222222222222222222222222222222222222222");
    expect(crossing).toMatchObject({ crossing: { filled: 40n, limitPrice: 500_000n }, restingUnits: 60n });
  });

  it("rejects an effective resale fee that would reduce proceeds below the displayed quote", () => {
    const quote = quoteSell([{ price: { raw: "10000000", decimals: 6, formatted: "10" }, units: "100", orders: [
      { orderId: "17", maker: "0x1111111111111111111111111111111111111111", kind: "Bid", units: "100", onChainRemainingUnits: "100", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }], 100n, { takerFeeFlat: 0n, takerFeeCapBps: 0 }, 100);
    expect(quote.sellerFee).toBe(100_000n);
    expect(() => assertResaleFeeMatches(100, 100)).not.toThrow();
    expect(() => assertResaleFeeMatches(100, 500)).toThrow(/on-chain resale fee changed/);
  });

  it("refuses to cancel or edit a different on-chain order disguised by an API row", () => {
    const displayed = positions.orders[0]!;
    const longId = BigInt(displayed.series.longId);
    expect(orderIdentityMatches(displayed, { longId, kind: 0 })).toBe(true);
    expect(orderIdentityMatches(displayed, { longId: longId + 2n, kind: 0 })).toBe(false);
    expect(orderIdentityMatches(displayed, { longId, kind: 1 })).toBe(false);
  });
});
