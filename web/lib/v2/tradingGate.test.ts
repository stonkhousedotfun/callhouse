/**
 * The OrderBook trading brake on the app's trade buttons (lib/v2/tradingGate.ts). OrderBook.sol `_whenTrading`
 * reverts TradingPaused in place, placeFor, replace and take; the page shuts from /v2/markets' brake and each click
 * re-reads `tradingPaused()` on chain before its first write.
 */
import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { V2_ERROR_TEXT } from "./errors";
import { assertTradingOpen, TRADING_PAUSED_LINE, tradingOpen } from "./tradingGate";

const ORDER_BOOK = "0x0000000000000000000000000000000000000022";

vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  requireV2Address: (key: string) => {
    if (key !== "orderBook") throw new Error(`unexpected ${key}`);
    return ORDER_BOOK;
  },
}));

function book(paused: boolean) {
  const readContract = vi.fn(async (request: { functionName: string }) => {
    if (request.functionName !== "tradingPaused") throw new Error(`unexpected ${request.functionName}`);
    return paused;
  });
  return { readContract } as unknown as PublicClient & { readContract: typeof readContract };
}

describe("tradingOpen: the page's half, from /v2/markets", () => {
  it("shuts only on an explicit brake", () => {
    expect(tradingOpen({ tradingPaused: true })).toBe(false);
    expect(tradingOpen({ tradingPaused: false })).toBe(true);
  });

  it("an unread list or a market with no row is not a pause (the click still asks the chain)", () => {
    expect(tradingOpen(undefined)).toBe(true);
    expect(tradingOpen(null)).toBe(true);
  });

  it("says the brake covers every market, and names only what OrderBook._whenTrading leaves open", () => {
    expect(TRADING_PAUSED_LINE).toBe(
      "Trading is paused on every market right now. You can still cancel your open orders, close matched positions and collect payouts.");
    // A decoded revert keeps the chain error's own copy: HouseVault and FeeSplitter revert TradingPaused too.
    expect(TRADING_PAUSED_LINE).not.toBe(V2_ERROR_TEXT.TradingPaused);
  });
});

describe("assertTradingOpen: the click's half, on chain", () => {
  it("throws the brake's line when OrderBook.tradingPaused() is set", async () => {
    const client = book(true);
    await expect(assertTradingOpen(client)).rejects.toThrow(TRADING_PAUSED_LINE);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: ORDER_BOOK, functionName: "tradingPaused" }));
  });

  it("passes when the brake is off", async () => {
    await expect(assertTradingOpen(book(false))).resolves.toBeUndefined();
  });

  it("reads at the caller's block when one is given, and at latest otherwise", async () => {
    const pinned = book(false);
    await assertTradingOpen(pinned, 77n);
    expect(pinned.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 77n }));
    const latest = book(false);
    await assertTradingOpen(latest);
    expect(latest.readContract.mock.calls[0]![0]).not.toHaveProperty("blockNumber");
  });

  it("a failed read throws rather than guessing open", async () => {
    const client = { readContract: vi.fn(async () => { throw new Error("rpc down"); }) } as unknown as PublicClient;
    await expect(assertTradingOpen(client)).rejects.toThrow("rpc down");
  });
});
