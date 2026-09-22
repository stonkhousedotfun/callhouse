import { describe, expect, it, vi } from "vitest";
import type { PublicClient, WalletClient } from "viem";

import { USDG } from "../contracts";
import { createSeries, preflightAsk, readWriterRent } from "./earnTx";

const account = "0x0000000000000000000000000000000000000044";
const underlying = "0x0000000000000000000000000000000000000055";
const hash = `0x${"1".repeat(64)}` as `0x${string}`;

vi.mock("./config", () => ({
  V2_DEPLOYMENT: { contracts: { orderBook: "0x0000000000000000000000000000000000000022" } },
  requireV2Address: (key: string) => ({ clearinghouse: "0x0000000000000000000000000000000000000011",
    orderBook: "0x0000000000000000000000000000000000000022",
    expiryCalendar: "0x0000000000000000000000000000000000000033" })[key as "clearinghouse" | "orderBook" | "expiryCalendar"],
}));

function chain(free: bigint, options: { ppm?: number; existingFee?: bigint; premiumFeeBps?: number } = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string; args?: readonly unknown[] }) => {
    switch (functionName) {
      case "market": return { enabled: true, mintPaused: false, strikeTick: 1_000_000n, mintFeePpm: options.ppm ?? 0 };
      case "isValidExpiry": return true;
      case "isOperator": return false;
      case "free": return free;
      case "feeParams": return { premiumFeeBps: options.premiumFeeBps ?? 500 };
      case "longIdOf": return 42n;
      case "seriesExists": return options.existingFee !== undefined;
      case "mintFee": return options.existingFee;
      case "series": return { mintFeePpm: 80 };
      case "mintCutoff": return Math.floor(Date.now() / 1000) + 3600;
      default: throw new Error(`unexpected ${functionName}`);
    }
  });
  return { readContract, getBlock: vi.fn(async () => ({ number: 123n, timestamp: BigInt(Math.floor(Date.now() / 1000)) })) } as unknown as PublicClient & { readContract: typeof readContract };
}

describe("cash-secured put ask preflight", () => {
  const strike = 200_000_000n;
  const expiry = Math.floor(Date.now() / 1000) + 86_400;

  it("checks USDG collateral and the put series ID on chain", async () => {
    const client = chain(strike);
    const result = await preflightAsk(account, underlying, true, strike, expiry, 100n, 500, client);
    expect(result).toMatchObject({ longId: 42n, exists: false, free: strike });
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "free", args: [account, USDG] }));
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "longIdOf", args: [underlying, true, strike, expiry] }));
  });

  it("rejects an underfunded put even when some USDG is free", async () => {
    await expect(preflightAsk(account, underlying, true, strike, expiry, 100n, 500, chain(strike - 1n)))
      .rejects.toThrow("Deposit enough free USDG");
  });

  it("keeps the covered-call collateral path on the Stock Token", async () => {
    const client = chain(10n ** 18n);
    await preflightAsk(account, underlying, false, strike, expiry, 100n, 500, client);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "free", args: [account, underlying] }));
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "longIdOf", args: [underlying, false, strike, expiry] }));
  });

  it("rejects balances below the complete on-chain collateral requirement for calls and puts", async () => {
    await expect(preflightAsk(account, underlying, true, strike, expiry, 100n, 0, chain(strike, { ppm: 1200, premiumFeeBps: 0 }))).rejects.toThrow(/enough free USDG/);
    await expect(preflightAsk(account, underlying, false, strike, expiry, 100n, 0, chain(10n ** 18n, { ppm: 1200, premiumFeeBps: 0 }))).rejects.toThrow(/enough free Stock Tokens/);
  });

  it("uses the existing series mintFee view, even when the market rate differs", async () => {
    const client = chain(strike + 1n, { ppm: 5000, existingFee: 1n, premiumFeeBps: 0 });
    const result = await preflightAsk(account, underlying, true, strike, expiry, 100n, 0, client);
    expect(result).toMatchObject({ exists: true, rent: 1n, collateralRequired: strike + 1n });
    for (const [request] of client.readContract.mock.calls) expect(request).toMatchObject({ blockNumber: 123n });
  });

  it("shows existing-series rent and free balance from the same block", async () => {
    const client = chain(strike + 1n, { ppm: 5000, existingFee: 1n });
    expect(await readWriterRent(underlying, true, strike, expiry, 100n, account, client)).toMatchObject({ rent: 1n, free: strike + 1n, mintFeePpm: 80 });
    for (const [request] of client.readContract.mock.calls) expect(request).toMatchObject({ blockNumber: 123n });
  });

  it("simulates creation with isPut=true before sending", async () => {
    const simulateContract = vi.fn(async (request: unknown) => ({ request }));
    const client = { simulateContract, waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) } as unknown as PublicClient;
    const wallet = { getChainId: vi.fn(async () => 4663), writeContract: vi.fn(async () => hash) } as unknown as WalletClient;
    await expect(createSeries({ account, client, wallet }, underlying, true, strike, expiry)).resolves.toBe(hash);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "createSeries", args: [underlying, true, strike, expiry] }));
  });

  it("retains the createSeries hash when its receipt is temporarily unavailable", async () => {
    const client = { simulateContract: vi.fn(async (request: unknown) => ({ request })),
      waitForTransactionReceipt: vi.fn(async () => { throw new Error("RPC timeout"); }) } as unknown as PublicClient;
    const wallet = { getChainId: vi.fn(async () => 4663), writeContract: vi.fn(async () => hash) } as unknown as WalletClient;
    const onConfirmed = vi.fn();
    await expect(createSeries({ account, client, wallet, onConfirmed }, underlying, true, strike, expiry))
      .rejects.toMatchObject({ name: "V2ReceiptUnknownError", hash, operation: "createSeries" });
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
