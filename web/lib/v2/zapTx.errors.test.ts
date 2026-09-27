/**
 * A zap `BadPrice` is a slippage miss, not an order-ticket tick error.
 *
 * writeZap reverts `BadPrice` when the swap, or since v9 the Clearinghouse credit, is below
 * `minAssetOut` (StockZap.writeZap); exitZap gets it from PayoutRouter.swapToUsdg below
 * `minUsdgOut`. The shared copy for that name tells the user to put a price on
 * the tick, which a zap has no field for.
 *
 * A SEPARATE FILE for the same reason as zapTx.deadline.test.ts: zapTx.test.ts mocks the zap address
 * to THROW, so no write there reaches the revert handler.
 *
 * The reverts are real viem errors built from the generated StockZap ABI, wrapped the way
 * simulateContract wraps them, so the test reads the same cause chain a wallet error carries.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Hex,
} from "viem";

vi.mock("./config", () => ({
  requireV2Address: (key: string) => {
    if (key !== "stockZap") throw new Error(`unexpected ${key}`);
    return "0x0000000000000000000000000000000000000066";
  },
  V2_DEPLOYMENT: { contracts: { stockZap: "0x0000000000000000000000000000000000000066" } },
}));

import { stockZapAbi } from "../abi/v2/stockZap";
import { V2_ERROR_TEXT } from "./errors";
import type { WriteContext } from "./tx";
import { exitZap, explainZapError, writeZap, ZAP_ERROR_TEXT } from "./zapTx";

const account = "0x0000000000000000000000000000000000000044";
const asset = "0x0000000000000000000000000000000000000055";
const zap = "0x0000000000000000000000000000000000000066";

function revert(functionName: "writeZap" | "exitZap", errorName: string, args?: readonly unknown[]) {
  const data = encodeErrorResult({ abi: stockZapAbi, errorName, args } as never) as Hex;
  const reverted = new ContractFunctionRevertedError({ abi: stockZapAbi, data, functionName });
  return new ContractFunctionExecutionError(reverted, { abi: stockZapAbi, functionName, args: [], contractAddress: zap, sender: account });
}

function harness(failure: unknown) {
  const client = {
    getBlock: vi.fn(async () => ({ number: 1n, timestamp: 1_700_000_000n })),
    simulateContract: vi.fn(async () => { throw failure; }),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
  };
  const wallet = { getChainId: async () => 4663, writeContract: vi.fn(async () => `0x${"1".repeat(64)}`) };
  return { context: { account, client, wallet } as unknown as WriteContext, wallet };
}

describe("zap revert copy", () => {
  it("the ticket copy and the zap copy differ, so the assertions below can tell them apart", () => {
    expect(ZAP_ERROR_TEXT.BadPrice).not.toBe(V2_ERROR_TEXT.BadPrice);
    expect(V2_ERROR_TEXT.BadPrice).toMatch(/price tick/);
  });

  it("writeZap shows slippage copy for BadPrice, not the order-ticket tick copy", async () => {
    const { context, wallet } = harness(revert("writeZap", "BadPrice"));
    const failure = writeZap(context, asset, 215_500_000n, 215_500_000n, 6, 18);
    await expect(failure).rejects.toThrow(ZAP_ERROR_TEXT.BadPrice);
    await expect(failure).rejects.not.toThrow(/price tick/);
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("exitZap shows slippage copy for BadPrice (PayoutRouter.swapToUsdg below minUsdgOut)", async () => {
    const { context } = harness(revert("exitZap", "BadPrice"));
    await expect(exitZap(context, asset, 10n ** 18n, 215_500_000n, 6, 18)).rejects.toThrow(ZAP_ERROR_TEXT.BadPrice);
  });

  it("keeps the shared copy for every other v2 error", async () => {
    const { context } = harness(revert("writeZap", "DeadlinePassed"));
    await expect(writeZap(context, asset, 215_500_000n, 215_500_000n, 6, 18)).rejects.toThrow(V2_ERROR_TEXT.DeadlinePassed);
    expect(explainZapError(revert("exitZap", "UnsupportedAsset"))).toBe(V2_ERROR_TEXT.UnsupportedAsset);
  });

  it("keeps an unknown failure generic and leaks nothing", () => {
    const text = explainZapError(new Error("secret RPC internals"));
    expect(text).not.toContain("secret");
    expect(text).not.toBe(ZAP_ERROR_TEXT.BadPrice);
  });
});
