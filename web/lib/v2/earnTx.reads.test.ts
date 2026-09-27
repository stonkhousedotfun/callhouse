/** lib/v2/earnTx.ts: the writer's reads, the AutoRoller/delegate writes, and the ask-expiry helper. The chain is stubbed. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClient, WalletClient } from "viem";

import { USDG } from "../contracts";

const CLEAR = "0x0000000000000000000000000000000000000011";
const BOOK = "0x0000000000000000000000000000000000000022";
const ROLLER = "0x0000000000000000000000000000000000000066" as const;

const deployment = vi.hoisted(() => ({ contracts: {} as { orderBook?: string; autoRoller?: string } }));
vi.mock("./config", () => ({
  V2_DEPLOYMENT: deployment,
  requireV2Address: (key: string) => ({ clearinghouse: "0x0000000000000000000000000000000000000011",
    orderBook: "0x0000000000000000000000000000000000000022", autoRoller: "0x0000000000000000000000000000000000000066" })[key],
}));

import {
  nextAskExpiry, readMintCutoff, readRollPosition, readRollState, readWriterBalance, readWriterFree, readWriterRent, setDelegate,
  setStrategy, stopStrategy,
} from "./earnTx";
import { V2ReceiptUnknownError } from "./txStatus";

const account = "0x0000000000000000000000000000000000000044" as const;
const asset = "0x0000000000000000000000000000000000000055" as const;
const hash = `0x${"1".repeat(64)}` as const;

type Read = { address: string; functionName: string; args?: readonly unknown[] };

beforeEach(() => {
  deployment.contracts = { orderBook: BOOK, autoRoller: ROLLER };
});

describe("readWriterBalance", () => {
  it("reads wallet and free in one multicall, then both operator grants against the clearinghouse", async () => {
    const multicall = vi.fn(async () => [7n, 3n]);
    const readContract = vi.fn(async ({ args }: Read) => args?.[1] === BOOK);
    const client = { multicall, readContract } as unknown as PublicClient;
    expect(await readWriterBalance(account, asset, client)).toEqual({ wallet: 7n, free: 3n, orderBookOperator: true, rollerOperator: false });
    const reads = readContract.mock.calls.map(([r]) => [r.address, r.functionName, r.args]);
    expect(reads).toEqual([[CLEAR, "isOperator", [account, BOOK]], [CLEAR, "isOperator", [account, ROLLER]]]);
  });

  it("reports no operator grant, without reading, when the deployment has no book or roller", async () => {
    deployment.contracts = {};
    const readContract = vi.fn();
    const client = { multicall: vi.fn(async () => [0n, 0n]), readContract } as unknown as PublicClient;
    expect(await readWriterBalance(account, asset, client)).toEqual({ wallet: 0n, free: 0n, orderBookOperator: false, rollerOperator: false });
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe("single reads", () => {
  it("readWriterFree reads the clearinghouse ledger for the asset", async () => {
    const readContract = vi.fn(async () => 9n);
    expect(await readWriterFree(account, asset, { readContract } as unknown as PublicClient)).toBe(9n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: CLEAR, functionName: "free", args: [account, asset] }));
  });

  it("readMintCutoff returns the cutoff as a number", async () => {
    const readContract = vi.fn(async () => 1_790_000_000n);
    expect(await readMintCutoff(42n, { readContract } as unknown as PublicClient)).toBe(1_790_000_000);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "mintCutoff", args: [42n] }));
  });
});

describe("roll state", () => {
  const multicall = vi.fn(async () => [{ active: true }, [42n, 7n, 1_790_000_000n]]);

  it("readRollPosition names the AutoRoller's strategy and position", async () => {
    expect(await readRollPosition(account, asset, { multicall } as unknown as PublicClient))
      .toEqual({ strategyActive: true, longId: 42n, orderId: 7n, expiry: 1_790_000_000 });
  });

  it("readRollState adds whether the roller is the account's book delegate", async () => {
    const readContract = vi.fn(async () => true);
    const client = { multicall, readContract } as unknown as PublicClient;
    expect((await readRollState(account, asset, client)).delegate).toBe(true);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: BOOK, functionName: "isDelegate", args: [account, ROLLER] }));
  });

  it("readRollState reports no delegate without a book in the deployment", async () => {
    deployment.contracts = { autoRoller: ROLLER };
    const readContract = vi.fn();
    expect((await readRollState(account, asset, { multicall, readContract } as unknown as PublicClient)).delegate).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe("nextAskExpiry", () => {
  it("caps a new ask at seven days or one second before cutoff, whichever is sooner", () => {
    expect(nextAskExpiry(1_000, 1_000 + 30 * 86_400)).toBe(1_000 + 7 * 86_400);
    expect(nextAskExpiry(1_000, 5_000)).toBe(4_999);
  });

  it("refuses when the ask would live a minute or less", () => {
    expect(() => nextAskExpiry(1_000, 1_061)).toThrow("This series is too close to cutoff for a new ask.");
    expect(nextAskExpiry(1_000, 1_062)).toBe(1_061);
  });
});

describe("readWriterRent", () => {
  it("estimates a new series' rent from the market rate at the block, and skips the free read without an account", async () => {
    const readContract = vi.fn(async ({ functionName }: Read) => {
      switch (functionName) {
        case "longIdOf": return 42n;
        case "seriesExists": return false;
        case "market": return { mintFeePpm: 100 };
        default: throw new Error(`unexpected ${functionName}`);
      }
    });
    const client = { readContract, getBlock: vi.fn(async () => ({ number: 5n, timestamp: 1_000n })) } as unknown as PublicClient;
    // One call unit (collateral 1e16 base units), 100 ppm per week, 1 000 s of life: ceil(1e16 * 100 * 1000 / (1e6 * 604800)).
    const out = await readWriterRent(asset, false, 200_000_000n, 2_000, 1n, undefined, client);
    expect(out.free).toBeNull();
    expect(out.mintFeePpm).toBe(100);
    expect(out.snapshotTimestamp).toBe(1_000);
    expect(out.rent).toBe(1_653_439_154n);
    expect(readContract.mock.calls.map(([r]) => r.functionName)).toEqual(["longIdOf", "seriesExists", "market"]);
  });

  it("reads a put writer's free USDG at the same block", async () => {
    const readContract = vi.fn(async ({ functionName }: Read) => {
      switch (functionName) {
        case "longIdOf": return 43n;
        case "seriesExists": return true;
        case "series": return { mintFeePpm: 80 };
        case "mintFee": return 12n;
        case "free": return 99n;
        default: throw new Error(`unexpected ${functionName}`);
      }
    });
    const client = { readContract, getBlock: vi.fn(async () => ({ number: 5n, timestamp: 1_000n })) } as unknown as PublicClient;
    expect(await readWriterRent(asset, true, 200_000_000n, 2_000, 1n, account, client)).toEqual({ rent: 12n, free: 99n, mintFeePpm: 80, snapshotTimestamp: 1_000 });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "free", args: [account, USDG], blockNumber: 5n }));
  });
});

describe("AutoRoller and delegate writes", () => {
  function harness(chainId = 4663) {
    const client = {
      simulateContract: vi.fn(async (request: Read) => ({ request })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    };
    const wallet = { getChainId: vi.fn(async () => chainId), writeContract: vi.fn(async () => hash) };
    return { client, wallet, context: { account, client: client as unknown as PublicClient, wallet: wallet as unknown as WalletClient } };
  }

  it("setDelegate targets the order book", async () => {
    const { client, context } = harness();
    await expect(setDelegate(context, ROLLER, true)).resolves.toBe(hash);
    expect(client.simulateContract.mock.calls[0]![0]).toMatchObject({ address: BOOK, functionName: "setDelegate", args: [ROLLER, true] });
  });

  it("setStrategy sends maxUnits as a bigint to the AutoRoller", async () => {
    const { client, context } = harness();
    const strategy = { active: true, weekly: true, smartPricing: false, otmBps: 500, askBps: 100, minAskBps: 50, maxAskBps: 200, maxUnits: "12" };
    await setStrategy(context, asset, strategy);
    expect(client.simulateContract.mock.calls[0]![0]).toMatchObject({ address: ROLLER, functionName: "setStrategy",
      args: [asset, { ...strategy, maxUnits: 12n }] });
  });

  it("stopStrategy calls stop(underlying)", async () => {
    const { client, context } = harness();
    await stopStrategy(context, asset);
    expect(client.simulateContract.mock.calls[0]![0]).toMatchObject({ address: ROLLER, functionName: "stop", args: [asset] });
  });

  it("refuses on another chain before simulating", async () => {
    const { client, context } = harness(1);
    await expect(stopStrategy(context, asset)).rejects.toThrow("Switch to Robinhood Chain to continue.");
    expect(client.simulateContract).not.toHaveBeenCalled();
  });

  it("explains a failed simulation and keeps the cause; a failed cache refresh after confirmation is ignored", async () => {
    const { client, context, wallet } = harness();
    const cause = new Error("raw viem error");
    client.simulateContract.mockRejectedValueOnce(cause);
    const error = (await stopStrategy(context, asset).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(cause);
    expect(wallet.writeContract).not.toHaveBeenCalled();
    await expect(stopStrategy({ ...context, onConfirmed: () => { throw new Error("cache"); } }, asset)).resolves.toBe(hash);
  });

  it("surfaces an unknown receipt with its hash rather than a retryable error", async () => {
    const { client, context } = harness();
    client.waitForTransactionReceipt.mockRejectedValueOnce(new Error("timeout"));
    const error = await stopStrategy(context, asset).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(V2ReceiptUnknownError);
    expect((error as V2ReceiptUnknownError).hash).toBe(hash);
  });
});
