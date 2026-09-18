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

describe("v2 take fee deadline", () => {
  const blockNumber = 42n;
  const chainTime = 1_789_620_000n;
  const request = { longId: 7n, buying: true, orderIds: [3n], units: 100n, minUnits: 100n,
    limitPrice: 250_000n, writeToSell: false, recipient: account as `0x${string}` };
  const expected = { filled: 100n, premium: 250_000n, fee: 1_000n };

  function context(effectiveAt: number, feeBps = 40) {
    const reads: { functionName: string; blockNumber: bigint; deadline?: number }[] = [];
    const client = { getBlock: vi.fn(async () => ({ number: blockNumber, timestamp: chainTime })),
      readContract: vi.fn(async (args: { functionName: string; blockNumber: bigint; args?: [{ deadline: number }] }) => {
        reads.push({ functionName: args.functionName, blockNumber: args.blockNumber, deadline: args.args?.[0].deadline });
        if (args.functionName === "pendingFeeParams") return [{}, effectiveAt];
        if (args.functionName === "feeParams") return { resaleFeeBps: feeBps };
        if (args.functionName === "quoteTake") return [expected.filled, expected.premium, expected.fee];
        throw new Error("Unexpected contract read");
      }),
    } as unknown as PublicClient;
    return { reads, client, writeContext: { account, client, wallet: {} as WalletClient } as WriteContext };
  }

  it("caps the deadline at the second before activation using the quote block timestamp", async () => {
    const { reads, writeContext } = context(Number(chainTime) + 120);
    const params = await recheckTakeQuote(writeContext, request, { ...expected, resaleFeeBps: 40 });
    expect(params.deadline).toBe(Number(chainTime) + 119);
    expect(reads).toEqual([
      { functionName: "pendingFeeParams", blockNumber },
      { functionName: "feeParams", blockNumber },
      { functionName: "quoteTake", blockNumber, deadline: Number(chainTime) + 119 },
    ]);
  });

  it("stops when activation is the next second, before any quote or wallet write", async () => {
    const { client, writeContext } = context(Number(chainTime) + 1);
    await expect(recheckTakeQuote(writeContext, request, expected)).rejects.toThrow("fee change is too close");
    expect(client.readContract).toHaveBeenCalledTimes(1);
  });

  it("uses current effective fees when the pending schedule already activated", async () => {
    const { writeContext } = context(Number(chainTime), 60);
    const params = await recheckTakeQuote(writeContext, request, { ...expected, resaleFeeBps: 60 });
    expect(params.deadline).toBe(Number(chainTime) + 300);
  });

  it("recomputes the deadline if a schedule changes between approval checks", async () => {
    const { client, writeContext } = context(0);
    expect((await recheckTakeQuote(writeContext, request, expected)).deadline).toBe(Number(chainTime) + 300);
    vi.mocked(client.readContract).mockImplementation(async (args) => {
      if (args.functionName === "pendingFeeParams") return [{}, Number(chainTime) + 90] as never;
      if (args.functionName === "quoteTake") return [expected.filled, expected.premium, expected.fee] as never;
      throw new Error("Unexpected contract read");
    });
    expect((await recheckTakeQuote(writeContext, request, expected)).deadline).toBe(Number(chainTime) + 89);
  });

  it("rejects a changed resale fee even if the taker quote is unchanged", async () => {
    const { writeContext } = context(0, 60);
    await expect(recheckTakeQuote(writeContext, { ...request, buying: false },
      { ...expected, resaleFeeBps: 40 })).rejects.toThrow("resale fee changed");
  });

  it("rechecks after an approval and rejects a changed taker quote", async () => {
    const { client, writeContext } = context(0);
    await recheckTakeQuote(writeContext, request, expected);
    vi.mocked(client.readContract).mockImplementation(async (args) => {
      if (args.functionName === "pendingFeeParams") return [{}, 0] as never;
      if (args.functionName === "quoteTake") return [100n, 250_000n, 2_000n] as never;
      throw new Error("Unexpected contract read");
    });
    await expect(recheckTakeQuote(writeContext, request, expected)).rejects.toThrow("on-chain quote changed");
  });
});

describe("v2 confirmed take amount", () => {
  const params = { longId: 7n, buying: true, orderIds: [3n], units: 100n, minUnits: 1n,
    limitPrice: 250_000n, writeToSell: false, recipient: account as `0x${string}`, deadline: 1_789_620_300 };

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
