/**
 * The OrderBook's `owed` balance: read from the chain (the credit has no log), shown only when observed and
 * positive, and claimed with the book's own caller-only `claimOwed()`.
 */
import { describe, expect, it, vi } from "vitest";

import { orderBookAbi } from "../abi/v2/orderBook";
import { requireV2Address } from "./config";
import { claimOrderBookOwed, owedBanner, readOrderBookOwed } from "./owed";

const account = "0x0000000000000000000000000000000000000044" as const;

describe("owedBanner", () => {
  it("shows an observed positive balance in USDG", () => {
    expect(owedBanner(12_345_678n)).toEqual({ amount: "12.34 USDG", raw: 12_345_678n });
  });

  it("shows nothing for zero, and nothing for a balance that was not read (which is not zero, and not claimable)", () => {
    expect(owedBanner(0n)).toBeNull();
    expect(owedBanner(null)).toBeNull();
    expect(owedBanner(undefined)).toBeNull();
  });
});

describe("the owed read and the claim", () => {
  it("reads owed(account) from the registry's order book", async () => {
    const readContract = vi.fn(async () => 7n);
    await expect(readOrderBookOwed(account, { readContract } as never)).resolves.toBe(7n);
    expect(readContract).toHaveBeenCalledWith({
      address: requireV2Address("orderBook"), abi: orderBookAbi, functionName: "owed", args: [account],
    });
  });

  it("claims through the order book's claimOwed() with no arguments, simulated before the wallet is asked", async () => {
    const request = { marker: "simulated" };
    const simulateContract = vi.fn(async () => ({ request }));
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success", logs: [] }));
    const writeContract = vi.fn(async () => `0x${"ab".repeat(32)}`);
    const context = {
      account,
      client: { simulateContract, waitForTransactionReceipt },
      wallet: { getChainId: async () => 4663, writeContract },
    } as never;
    await claimOrderBookOwed(context);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      account, address: requireV2Address("orderBook"), functionName: "claimOwed", args: [],
    }));
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ marker: "simulated", account }));
  });

  it("refuses on the wrong chain before simulating anything", async () => {
    const simulateContract = vi.fn();
    const context = { account, client: { simulateContract }, wallet: { getChainId: async () => 1 } } as never;
    await expect(claimOrderBookOwed(context)).rejects.toThrow(/Robinhood Chain/);
    expect(simulateContract).not.toHaveBeenCalled();
  });
});
