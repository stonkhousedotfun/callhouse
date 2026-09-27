import { describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, UserRejectedRequestError, encodeAbiParameters,
  encodeErrorResult, encodeEventTopics, parseAbiParameters, type PublicClient, type WalletClient,
} from "viem";
import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { orderBookAbi } from "../abi/v2/orderBook";
import { TOKEN_ERROR_TEXT, V2_ERROR_TEXT, WALLET_REJECTED_TEXT, explainV2Error } from "./errors";
import {
  RESTING_ORDER_LIFETIME_SECONDS, approveExact, cancel, chainNow, exactApprovalAmount, place, recheckTakeQuote, restingValidUntil,
  simulatedWrite, take, type WriteContext,
} from "./tx";

vi.mock("./config", () => ({ requireV2Address: () => "0x0000000000000000000000000000000000000003" }));

const account = "0x0000000000000000000000000000000000000001";
const token = "0x0000000000000000000000000000000000000002";
const spender = "0x0000000000000000000000000000000000000003";
const hash = `0x${"1".repeat(64)}` as const;

describe("v2 exact approval", () => {
  it("approves the exact trade amount only if existing allowance is insufficient", () => {
    expect(exactApprovalAmount(0n, 374_500_000n)).toBe(374_500_000n);
    expect(exactApprovalAmount(100n, 374_500_000n)).toBe(374_500_000n);
    expect(exactApprovalAmount(374_500_000n, 374_500_000n)).toBe(0n);
    expect(() => exactApprovalAmount(0n, 0n)).toThrow();
  });

  it("reads allowance, simulates exact approval, sends, then waits for inclusion", async () => {
    const events: string[] = [];
    const client = {
      multicall: vi.fn(async () => [500n, 5n]),
      simulateContract: vi.fn(async (request: { args: bigint[] }) => {
        expect(request.args).toEqual([spender, 125n]);
        events.push("simulate");
        return { request };
      }),
      waitForTransactionReceipt: vi.fn(async () => { events.push("receipt"); return { status: "success" }; }),
    } as unknown as PublicClient;
    const wallet = {
      getChainId: vi.fn(async () => 4663),
      writeContract: vi.fn(async () => { events.push("send"); return hash; }),
    } as unknown as WalletClient;
    expect(await approveExact({ account, client, wallet, onConfirmed: () => { events.push("invalidate"); } }, token, spender, 125n)).toBe(hash);
    expect(events).toEqual(["simulate", "send", "receipt", "invalidate"]);
  });

  it("skips approval when allowance already covers the trade", async () => {
    const client = { multicall: vi.fn(async () => [500n, 125n]), simulateContract: vi.fn() } as unknown as PublicClient;
    const wallet = { writeContract: vi.fn() } as unknown as WalletClient;
    expect(await approveExact({ account, client, wallet }, token, spender, 125n)).toBeNull();
    expect(client.simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("returns the confirmed hash even when the cache refresh fails", async () => {
    const client = {
      multicall: vi.fn(async () => [500n, 0n]),
      simulateContract: vi.fn(async (request: unknown) => ({ request })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    } as unknown as PublicClient;
    const wallet = {
      getChainId: vi.fn(async () => 4663),
      writeContract: vi.fn(async () => hash),
    } as unknown as WalletClient;
    const onConfirmed = vi.fn(() => { throw new Error("cache offline"); });
    expect(await approveExact({ account, client, wallet, onConfirmed }, token, spender, 125n)).toBe(hash);
    expect(onConfirmed).toHaveBeenCalledWith(hash);
  });

  it("does not continue an approval-dependent trade when the receipt RPC fails", async () => {
    const client = {
      multicall: vi.fn(async () => [500n, 0n]),
      simulateContract: vi.fn(async (request: unknown) => ({ request })),
      waitForTransactionReceipt: vi.fn(async () => { throw new Error("RPC timeout"); }),
    } as unknown as PublicClient;
    const wallet = {
      getChainId: vi.fn(async () => 4663),
      writeContract: vi.fn(async () => hash),
    } as unknown as WalletClient;
    const onConfirmed = vi.fn();
    await expect(approveExact({ account, client, wallet, onConfirmed }, token, spender, 125n))
      .rejects.toMatchObject({ name: "V2ReceiptUnknownError", hash, operation: "approve" });
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

describe("v2 take fee cap", () => {
  const blockNumber = 42n;
  const chainTime = 1_789_620_000n;
  const maxUint128 = (1n << 128n) - 1n;
  const request = { longId: 7n, buying: true, orderIds: [3n], units: 100n, minUnits: 100n,
    limitPrice: 250_000n, writeToSell: false, recipient: account as `0x${string}` };
  const expected = { filled: 100n, premium: 250_000n, takerFee: 1_000n, sellerFees: 0n };

  function context(quote: readonly [bigint, bigint, bigint, bigint] =
    [expected.filled, expected.premium, expected.takerFee, expected.sellerFees]) {
    const reads: { functionName: string; blockNumber: bigint; account?: string;
      params?: { deadline: number; maxTotalFee: bigint } }[] = [];
    // quoteTake is no longer a view, so the requote is a simulation from the taker's account. A plain
    // contract read of it is refused here, as the typed ABI now refuses it.
    const client = { getBlock: vi.fn(async () => ({ number: blockNumber, timestamp: chainTime })),
      readContract: vi.fn(async () => { throw new Error("quoteTake is not a view since T-OP-835: simulate it"); }),
      simulateContract: vi.fn(async (args: { functionName: string; blockNumber: bigint; account?: string;
        args?: [{ deadline: number; maxTotalFee: bigint }] }) => {
        reads.push({ functionName: args.functionName, blockNumber: args.blockNumber, account: args.account,
          params: args.args?.[0] });
        if (args.functionName === "quoteTake") return { result: quote };
        throw new Error("Unexpected contract simulation");
      }),
    } as unknown as PublicClient;
    return { reads, client, writeContext: { account, client, wallet: {} as WalletClient } as WriteContext };
  }

  it("quotes without a cap, then returns the exact buyer fee cap at one block", async () => {
    const { reads, writeContext } = context();
    const params = await recheckTakeQuote(writeContext, request, expected);
    expect(params.deadline).toBe(Number(chainTime) + 300);
    expect(params.maxTotalFee).toBe(expected.takerFee);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ functionName: "quoteTake", blockNumber,
      params: { deadline: Number(chainTime) + 300, maxTotalFee: maxUint128 } });
  });

  it("simulates the requote FROM the taker's account and never reads it as a view", async () => {
    // quoteTake runs take's own code and rolls it back: the answer is msg.sender's, and no `from` reverts
    // NotAuthorized. A readContract of it fails typecheck against the regenerated ABI and is refused by the mock.
    const { client, reads, writeContext } = context();
    await recheckTakeQuote(writeContext, request, expected);
    expect(client.simulateContract).toHaveBeenCalledTimes(1);
    expect(client.readContract).not.toHaveBeenCalled();
    expect(reads[0]).toMatchObject({ functionName: "quoteTake", account });
  });

  it("sets a seller's cap to the quoted taker fee plus seller fees", async () => {
    const seller = { ...expected, sellerFees: 5_000n };
    const { writeContext } = context([seller.filled, seller.premium, seller.takerFee, seller.sellerFees]);
    const params = await recheckTakeQuote(writeContext, { ...request, buying: false }, seller);
    expect(params.maxTotalFee).toBe(6_000n);
  });

  it("allows a zero cap when the authoritative quote has no fees", async () => {
    const free = { ...expected, takerFee: 0n, sellerFees: 0n };
    const { writeContext } = context([free.filled, free.premium, free.takerFee, free.sellerFees]);
    expect((await recheckTakeQuote(writeContext, request, free)).maxTotalFee).toBe(0n);
  });

  /**
   * A taker with a non-zero on-chain discount must be able to trade.
   *
   * The protected fact is "a discounted taker can buy, sell and buy-back-and-close". The old exact
   * equality broke that fact the moment FEE_MANAGER set a discount module, because `quoteTake`
   * applies the discount (through `_discountBps`) while the client estimate in payoff.ts has no discount
   * term. These fixtures are the chain answering with a DISCOUNTED taker fee against an undiscounted
   * estimate — which is exactly what a wired deployment with a discount module returns.
   */
  const DISCOUNT_BPS = 2_500n; // well inside MAX_DISCOUNT_BPS (5,000)
  const discounted = (fee: bigint) => fee - fee * DISCOUNT_BPS / 10_000n;

  it("lets a DISCOUNTED taker buy: the chain fee is lower than the estimate", async () => {
    const { writeContext } = context([expected.filled, expected.premium, discounted(expected.takerFee), 0n]);
    const params = await recheckTakeQuote(writeContext, request, expected);
    expect(params.maxTotalFee).toBe(discounted(expected.takerFee));
    expect(params.maxTotalFee).toBeLessThan(expected.takerFee);
  });

  it("lets a DISCOUNTED taker sell: seller fees stay exact while the taker fee is discounted", async () => {
    const seller = { ...expected, sellerFees: 5_000n };
    const { writeContext } = context([seller.filled, seller.premium, discounted(seller.takerFee), seller.sellerFees]);
    const params = await recheckTakeQuote(writeContext, { ...request, buying: false }, seller);
    expect(params.maxTotalFee).toBe(discounted(seller.takerFee) + seller.sellerFees);
  });

  it("lets a DISCOUNTED taker buy back and close", async () => {
    const buyBack = { ...request, buying: true, writeToSell: true };
    const { writeContext } = context([expected.filled, expected.premium, discounted(expected.takerFee), 0n]);
    await expect(recheckTakeQuote(writeContext, buyBack, expected)).resolves.toMatchObject({
      maxTotalFee: discounted(expected.takerFee),
    });
  });

  it("accepts a FULL discount to zero, the boundary of the bound", async () => {
    const { writeContext } = context([expected.filled, expected.premium, 0n, 0n]);
    expect((await recheckTakeQuote(writeContext, request, expected)).maxTotalFee).toBe(0n);
  });

  it("still REFUSES a taker fee HIGHER than quoted — the bound is one-directional", async () => {
    // The discount can only reduce (`base - base * discountBps / BPS`), so a higher fee is never a
    // discount and must still stop the trade. Relaxing this to `<=` on everything is the forbidden fix.
    const { writeContext } = context([expected.filled, expected.premium, expected.takerFee + 1n, 0n]);
    await expect(recheckTakeQuote(writeContext, request, expected)).rejects.toThrow("higher than quoted");
  });

  it("still REFUSES a changed filled or premium, discount or no discount", async () => {
    const { writeContext: a } = context([expected.filled + 1n, expected.premium, discounted(expected.takerFee), 0n]);
    await expect(recheckTakeQuote(a, request, expected)).rejects.toThrow("on-chain quote changed");
    const { writeContext: b } = context([expected.filled, expected.premium + 1n, discounted(expected.takerFee), 0n]);
    await expect(recheckTakeQuote(b, request, expected)).rejects.toThrow("on-chain quote changed");
  });

  it("rechecks after approval and rejects a changed taker or seller fee", async () => {
    const { client, writeContext } = context();
    await recheckTakeQuote(writeContext, request, expected);
    vi.mocked(client.simulateContract).mockResolvedValueOnce(
      { result: [expected.filled, expected.premium, expected.takerFee, 1n] } as never,
    );
    await expect(recheckTakeQuote(writeContext, request, expected)).rejects.toThrow("on-chain quote changed");
  });
});

describe("v2 confirmed take amount", () => {
  const params = { longId: 7n, buying: true, orderIds: [3n], units: 100n, minUnits: 1n,
    limitPrice: 250_000n, writeToSell: false, recipient: account as `0x${string}`, deadline: 1_789_620_300,
    maxTotalFee: 1_000n };

  function context(logs: unknown[]) {
    const client = { simulateContract: vi.fn(async (request: unknown) => ({ request })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs })),
    } as unknown as PublicClient;
    const wallet = { getChainId: vi.fn(async () => 4663), writeContract: vi.fn(async () => hash) } as unknown as WalletClient;
    return { account, client, wallet } as WriteContext;
  }

  it("reports actual partial units from the confirmed OrderBook Taken event", async () => {
    const log = { address: spender,
      topics: encodeEventTopics({ abi: orderBookAbi, eventName: "Taken", args: { taker: account, longId: 7n } }),
      data: encodeAbiParameters(parseAbiParameters("bool buying, uint64 units, uint256 premium, uint256 takerFee"),
        [true, 60n, 150_000n, 800n]),
    };
    expect(await take(context([log]), params)).toEqual({ hash, unitsFilled: 60n });
  });

  it("keeps a confirmed trade final when the receipt lacks a matching Taken event", async () => {
    expect(await take(context([]), params)).toEqual({ hash, unitsFilled: null });
  });

  it("exposes the submitted take hash when receipt status cannot be read", async () => {
    const writeContext = context([]);
    vi.mocked(writeContext.client!.waitForTransactionReceipt).mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(take(writeContext, params)).rejects.toMatchObject({
      name: "V2ReceiptUnknownError", hash, operation: "take",
    });
  });
});

/*
 * simulatedWrite hands the simulated call's decoded return to `onSimulated` (HouseVault.claim() returns what
 * it pays). Reading that return is informational: it can never stop the write it describes.
 */
describe("v2 simulated return", () => {
  function context() {
    const client = { simulateContract: vi.fn(async (request: unknown) => ({ request, result: [1n, 2n, 3n] })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
    } as unknown as PublicClient;
    const wallet = { getChainId: vi.fn(async () => 4663), writeContract: vi.fn(async () => hash) } as unknown as WalletClient;
    return { account, client, wallet } as WriteContext;
  }

  it("passes the simulation's decoded return to onSimulated before the wallet is asked", async () => {
    const writeContext = context();
    const seen: unknown[] = [];
    await simulatedWrite(writeContext, spender, clearinghouseAbi, "claim", [], undefined, (result) => {
      seen.push(result);
      expect(vi.mocked(writeContext.wallet.writeContract)).not.toHaveBeenCalled();
    });
    expect(seen).toEqual([[1n, 2n, 3n]]);
  });

  it("an onSimulated that throws does not stop the write", async () => {
    const writeContext = context();
    await expect(simulatedWrite(writeContext, spender, clearinghouseAbi, "claim", [], undefined, () => { throw new Error("unreadable"); }))
      .resolves.toBe(hash);
    expect(vi.mocked(writeContext.wallet.writeContract)).toHaveBeenCalledTimes(1);
  });
});

/*
 * A failed send must say what actually happened. The two cases below used to read "The transaction could not
 * be completed. Refresh the quote and try again.": a wallet refusal (the quote was fine) and an ERC-1155 approval revert
 * bubbled up from the Clearinghouse through OrderBook.place (the order book ABI cannot name it).
 */
describe("v2 write failure copy", () => {
  function failing(fail: { simulate?: unknown; send?: unknown }) {
    const client = { simulateContract: vi.fn(async (request: unknown) => { if (fail.simulate) throw fail.simulate; return { request }; }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
      // place() reads chain time for its validUntil guard; here the chain agrees with the wall clock.
      getBlock: vi.fn(async () => ({ number: 1n, timestamp: BigInt(Math.floor(Date.now() / 1000)) })),
    } as unknown as PublicClient;
    const wallet = { getChainId: vi.fn(async () => 4663),
      writeContract: vi.fn(async () => { if (fail.send) throw fail.send; return hash; }) } as unknown as WalletClient;
    return { account, client, wallet } as WriteContext;
  }

  it("a send the user rejects in the wallet says so", async () => {
    const refused = new UserRejectedRequestError(new Error("User denied transaction signature."));
    await expect(cancel(failing({ send: refused }), [5n])).rejects.toMatchObject({ name: "V2WriteError", message: WALLET_REJECTED_TEXT });
  });

  it("a resale ask whose escrow the Clearinghouse refuses for a missing approval says so", async () => {
    const data = encodeErrorResult({ abi: clearinghouseAbi, errorName: "ERC1155MissingApprovalForAll", args: [spender, account] });
    const simulate = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: orderBookAbi, data, functionName: "place" }),
      { abi: orderBookAbi, functionName: "place", args: [], contractAddress: spender, sender: account });
    const validUntil = Math.floor(Date.now() / 1000) + 3_600;
    await expect(place(failing({ simulate }), 7n, 1, 250_000n, 100n, validUntil))
      .rejects.toMatchObject({ name: "V2WriteError", message: TOKEN_ERROR_TEXT.ERC1155MissingApprovalForAll });
  });
});

/*
 * A resting order's validUntil is judged by OrderBook against block.timestamp, so it is set and checked
 * against CHAIN time. Each case below pins the browser clock (Date.now) a long way from the block the client reports:
 * a result that moved with Date.now would be the old bug.
 */
describe("resting-order validUntil uses chain time", () => {
  const CHAIN_NOW = 1_790_000_000;
  const DAY = 86_400;

  function chainAt(timestamp: number) {
    return { getBlock: vi.fn(async () => ({ number: 9n, timestamp: BigInt(timestamp) })) } as unknown as PublicClient;
  }

  function withBrowserClock<T>(seconds: number, run: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(Date, "now").mockReturnValue(seconds * 1000);
    return run().finally(() => spy.mockRestore());
  }

  it("keeps the one-day lifetime this file exports", () => {
    expect(RESTING_ORDER_LIFETIME_SECONDS).toBe(DAY);
  });

  it("reads the latest block, not the wall clock", async () => {
    const client = chainAt(CHAIN_NOW);
    await withBrowserClock(CHAIN_NOW + 7 * DAY, async () => {
      expect(await chainNow(client)).toBe(CHAIN_NOW);
    });
    expect(client.getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
  });

  it("gives chain now + 1 day when the browser clock runs ahead of the chain", async () => {
    const expiry = CHAIN_NOW + 30 * DAY;
    await withBrowserClock(CHAIN_NOW + 3 * DAY, async () => {
      expect(await restingValidUntil(chainAt(CHAIN_NOW), expiry)).toBe(CHAIN_NOW + DAY);
    });
  });

  it("gives chain now + 1 day when the browser clock runs more than a day behind the chain", async () => {
    const expiry = CHAIN_NOW + 30 * DAY;
    await withBrowserClock(CHAIN_NOW - 2 * DAY, async () => {
      expect(await restingValidUntil(chainAt(CHAIN_NOW), expiry)).toBe(CHAIN_NOW + DAY);
    });
  });

  it("caps at expiry - 1, and refuses when that is not after chain now, whatever the browser says", async () => {
    await withBrowserClock(CHAIN_NOW - 2 * DAY, async () => {
      expect(await restingValidUntil(chainAt(CHAIN_NOW), CHAIN_NOW + 3_600)).toBe(CHAIN_NOW + 3_599);
      expect(await restingValidUntil(chainAt(CHAIN_NOW), CHAIN_NOW + 2)).toBe(CHAIN_NOW + 1);
      // The browser still thinks this series has two days left; the chain says it is at its last second.
      expect(await restingValidUntil(chainAt(CHAIN_NOW), CHAIN_NOW + 1)).toBeNull();
      expect(await restingValidUntil(chainAt(CHAIN_NOW), CHAIN_NOW)).toBeNull();
    });
  });

  function placing(timestamp: number) {
    const client = {
      getBlock: vi.fn(async () => ({ number: 9n, timestamp: BigInt(timestamp) })),
      simulateContract: vi.fn(async (request: unknown) => ({ request })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
    } as unknown as PublicClient;
    const wallet = { getChainId: vi.fn(async () => 4663), writeContract: vi.fn(async () => hash) } as unknown as WalletClient;
    return { context: { account, client, wallet } as WriteContext, client, wallet };
  }

  it("place refuses a validUntil the chain has passed even when the browser clock says it is in the future", async () => {
    const { context, client, wallet } = placing(CHAIN_NOW);
    await withBrowserClock(CHAIN_NOW - 2 * DAY, async () => {
      await expect(place(context, 7n, 0, 250_000n, 100n, CHAIN_NOW)).rejects.toBeInstanceOf(RangeError);
      await expect(place(context, 7n, 0, 250_000n, 100n, CHAIN_NOW - DAY)).rejects.toBeInstanceOf(RangeError);
    });
    expect(client.simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("place sends a validUntil the chain has not reached even when the browser clock is already past it", async () => {
    const { context, client } = placing(CHAIN_NOW);
    await withBrowserClock(CHAIN_NOW + 3 * DAY, async () => {
      expect(await place(context, 7n, 0, 250_000n, 100n, CHAIN_NOW + DAY)).toBe(hash);
    });
    expect(client.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "place", args: [7n, 0, 250_000n, 100n, CHAIN_NOW + DAY],
    }));
  });
});

/*
 * A quoted order cancelled or repriced between the ticket's preflight and the on-chain
 * requote makes quoteTake revert BelowMinUnits. The requote used to throw viem's raw error (~936 characters of request
 * dump) and the ticket printed it. It now throws V2WriteError: decoded buyer copy, viem's error kept as `cause`.
 */
describe("a reverting requote throws decoded buyer copy with the detail retained", () => {
  const request = { longId: 7n, buying: true, orderIds: [3n], units: 100n, minUnits: 100n,
    limitPrice: 250_000n, writeToSell: false, recipient: account as `0x${string}` };
  const expected = { filled: 100n, premium: 250_000n, takerFee: 1_000n, sellerFees: 0n };

  function reverting(data: `0x${string}`) {
    const revert = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: orderBookAbi, data, functionName: "quoteTake" }),
      { abi: orderBookAbi, functionName: "quoteTake", args: [], contractAddress: spender, sender: account });
    const client = { getBlock: vi.fn(async () => ({ number: 42n, timestamp: 1_789_620_000n })),
      simulateContract: vi.fn(async () => { throw revert; }) } as unknown as PublicClient;
    return { revert, context: { account, client, wallet: {} as WalletClient } as WriteContext };
  }

  it("fixture: viem's own message is the long dump the ticket used to print", () => {
    const { revert } = reverting(encodeErrorResult({ abi: orderBookAbi, errorName: "BelowMinUnits", args: [60n, 100n] }));
    expect(revert.message.length).toBeGreaterThan(300);
  });

  it("a known revert (BelowMinUnits) is its V2 copy, and the viem error is the cause", async () => {
    const { revert, context } = reverting(encodeErrorResult({ abi: orderBookAbi, errorName: "BelowMinUnits", args: [60n, 100n] }));
    const error = await recheckTakeQuote(context, request, expected).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ name: "V2WriteError", message: V2_ERROR_TEXT.BelowMinUnits });
    expect((error as Error).cause).toBe(revert);
  });

  it("an unknown revert is the generic line, never the raw text, and the detail is still the cause", async () => {
    const { revert, context } = reverting("0xdeadbeef");
    const error = await recheckTakeQuote(context, request, expected).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ name: "V2WriteError", message: explainV2Error(new Error("no v2 error here")) });
    expect((error as Error).message.length).toBeLessThan(120);
    expect((error as Error).cause).toBe(revert);
  });

  it("a failed block read is wrapped the same way (the requote never resolves with a stale default)", async () => {
    const down = new Error("RPC timeout");
    const client = { getBlock: vi.fn(async () => { throw down; }), simulateContract: vi.fn() } as unknown as PublicClient;
    const error = await recheckTakeQuote({ account, client, wallet: {} as WalletClient } as WriteContext, request, expected)
      .then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ name: "V2WriteError" });
    expect((error as Error).cause).toBe(down);
    expect(client.simulateContract).not.toHaveBeenCalled();
  });
});
