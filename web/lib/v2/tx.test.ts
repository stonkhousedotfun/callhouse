import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type PublicClient, type WalletClient } from "viem";
import { orderBookAbi } from "../abi/v2/orderBook";
import { approveExact, exactApprovalAmount, recheckTakeQuote, take, type WriteContext } from "./tx";

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
    const reads: { functionName: string; blockNumber: bigint; params?: { deadline: number; maxTotalFee: bigint } }[] = [];
    const client = { getBlock: vi.fn(async () => ({ number: blockNumber, timestamp: chainTime })),
      readContract: vi.fn(async (args: { functionName: string; blockNumber: bigint;
        args?: [{ deadline: number; maxTotalFee: bigint }] }) => {
        reads.push({ functionName: args.functionName, blockNumber: args.blockNumber, params: args.args?.[0] });
        if (args.functionName === "quoteTake") return quote;
        throw new Error("Unexpected contract read");
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
   * F-APP-01. A taker with a non-zero on-chain discount must be able to trade.
   *
   * The protected fact is "a discounted taker can buy, sell and buy-back-and-close". The old exact
   * equality broke that fact the moment FEE_MANAGER set a discount module, because `quoteTake`
   * applies the discount (OrderBook.sol:492) while the client estimate in payoff.ts has no discount
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
    vi.mocked(client.readContract).mockResolvedValueOnce(
      [expected.filled, expected.premium, expected.takerFee, 1n] as never,
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
