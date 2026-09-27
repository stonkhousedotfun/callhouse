/** lib/v2/tx.ts: the thin write wrappers' input guards and calldata, the chain guard and the take/approval refusals. */
import { describe, expect, it, vi } from "vitest";
import type { PublicClient, WalletClient } from "viem";

import {
  V2WriteError, approveExact, cancel, close, deposit, insufficientBalanceText, place, recheckTakeQuote, redeem, replace, restingValidUntil, setOperator,
  setPayoutInKind, setPayoutToLedger, setTokenApproval, simulatedWrite, take, withdraw, type TakeParams, type WriteContext,
} from "./tx";

const BOOK = "0x0000000000000000000000000000000000000003" as const;
const CLEAR = "0x0000000000000000000000000000000000000004";
vi.mock("./config", () => ({
  requireV2Address: (name: string) => name === "orderBook" ? "0x0000000000000000000000000000000000000003" : "0x0000000000000000000000000000000000000004",
}));

const account = "0x0000000000000000000000000000000000000001" as const;
const asset = "0x0000000000000000000000000000000000000002" as const;
const operator = "0x0000000000000000000000000000000000000005" as const;
const hash = `0x${"1".repeat(64)}` as const;

type Sim = { address: string; functionName: string; args: unknown[]; account: string };

function harness(opts: { chainId?: number; now?: bigint; balance?: bigint; allowance?: bigint } = {}) {
  const client = {
    getBlock: vi.fn(async () => ({ timestamp: opts.now ?? 1_000n, number: 9n })),
    multicall: vi.fn(async () => [opts.balance ?? 0n, opts.allowance ?? 0n]),
    simulateContract: vi.fn(async (request: Sim) => ({ request, result: undefined })),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
  };
  const wallet = { getChainId: vi.fn(async () => opts.chainId ?? 4663), writeContract: vi.fn(async () => hash) };
  const context: WriteContext = { account, client: client as unknown as PublicClient, wallet: wallet as unknown as WalletClient };
  const lastCall = () => client.simulateContract.mock.calls.at(-1)![0];
  return { client, wallet, context, lastCall };
}

describe("simulatedWrite chain guard", () => {
  it("refuses before simulating when the wallet is on another chain", async () => {
    const { context, client, wallet } = harness({ chainId: 1 });
    await expect(simulatedWrite(context, BOOK, [], "cancel", [])).rejects.toThrow("Switch to Robinhood Chain to continue.");
    expect(client.simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("wraps a reverted receipt as a V2WriteError", async () => {
    const { context, client } = harness();
    client.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted", logs: [] });
    await expect(simulatedWrite(context, BOOK, [], "cancel", [[1n]])).rejects.toBeInstanceOf(V2WriteError);
  });

  it("an onMined that throws does not turn a confirmed write into an error", async () => {
    const { context } = harness();
    await expect(simulatedWrite(context, BOOK, [], "cancel", [[1n]], () => { throw new Error("bad log"); })).resolves.toBe(hash);
  });
});

describe("approveExact balance check", () => {
  it("refuses when the wallet holds less than the amount, without asking for an approval", async () => {
    const { context, client } = harness({ balance: 99n, allowance: 0n });
    await expect(approveExact(context, asset, BOOK, 100n)).rejects.toThrow("Your wallet does not have enough of this token.");
    expect(client.simulateContract).not.toHaveBeenCalled();
  });

  const labelled = (balance: bigint, symbol: unknown, decimals: unknown) => {
    const h = harness({ balance, allowance: 0n });
    const readContract = vi.fn(async ({ functionName }: { address: string; functionName: string }) => functionName === "symbol" ? symbol : decimals);
    Object.assign(h.client, { readContract });
    return { ...h, readContract };
  };

  it("names the token and both amounts, read from the token itself, only once the balance is short", async () => {
    const { context, client, readContract } = labelled(0n, "USDG", 6);
    await expect(approveExact(context, asset, BOOK, 100_000n))
      .rejects.toThrow("Your wallet does not have enough USDG: it holds 0.00 USDG and this needs 0.10 USDG.");
    expect(readContract.mock.calls.map(([call]) => [call.address, call.functionName]))
      .toEqual([[asset, "symbol"], [asset, "decimals"]]);
    expect(client.simulateContract).not.toHaveBeenCalled();

    const covered = labelled(100_000n, "USDG", 6);
    await approveExact(covered.context, asset, BOOK, 100_000n);
    expect(covered.readContract).not.toHaveBeenCalled();
  });

  it("quotes an 18-decimal Stock Token at its own decimals, every digit", async () => {
    const { context } = labelled(5n * 10n ** 17n + 1n, "NVDA", 18);
    await expect(approveExact(context, asset, BOOK, 10n ** 18n))
      .rejects.toThrow("Your wallet does not have enough NVDA: it holds 0.500000000000000001 NVDA and this needs 1.00 NVDA.");
  });

  it("keeps the refusal, in the old words, when the label cannot be read or makes no sense", async () => {
    for (const [symbol, decimals] of [["", 6], ["USDG", -1], ["USDG", 1.5], [42, 6]] as const) {
      const { context } = labelled(0n, symbol, decimals);
      await expect(approveExact(context, asset, BOOK, 1n)).rejects.toThrow("Your wallet does not have enough of this token.");
    }
    const failing = harness({ balance: 0n });
    Object.assign(failing.client, { readContract: vi.fn(async () => { throw new Error("rpc down"); }) });
    await expect(approveExact(failing.context, asset, BOOK, 1n)).rejects.toThrow("Your wallet does not have enough of this token.");
  });
});

describe("insufficientBalanceText", () => {
  it("names the token with both amounts, or falls back to the unlabelled refusal", () => {
    expect(insufficientBalanceText({ symbol: "USDG", decimals: 6 }, 1_551_017n, 2_000_000n))
      .toBe("Your wallet does not have enough USDG: it holds 1.551017 USDG and this needs 2.00 USDG.");
    expect(insufficientBalanceText(null, 0n, 1n)).toBe("Your wallet does not have enough of this token.");
  });
});

describe("thin write wrappers", () => {
  it.each([
    ["redeem (defaults the holder to the account)", (c: WriteContext) => redeem(c, 43n), CLEAR, "redeem", [43n, account]],
    ["redeem for a third party", (c: WriteContext) => redeem(c, 43n, operator), CLEAR, "redeem", [43n, operator]],
    ["close", (c: WriteContext) => close(c, 42n, 3n), CLEAR, "close", [42n, 3n]],
    ["deposit to self", (c: WriteContext) => deposit(c, asset, 5n), CLEAR, "deposit", [asset, 5n, account]],
    ["withdraw to self", (c: WriteContext) => withdraw(c, asset, 5n), CLEAR, "withdraw", [asset, 5n, account]],
    ["setOperator", (c: WriteContext) => setOperator(c, operator, true), CLEAR, "setOperator", [operator, true]],
    ["setTokenApproval", (c: WriteContext) => setTokenApproval(c, operator, false), CLEAR, "setApprovalForAll", [operator, false]],
    ["setPayoutInKind", (c: WriteContext) => setPayoutInKind(c, true), CLEAR, "setPayoutInKind", [true]],
    ["setPayoutToLedger", (c: WriteContext) => setPayoutToLedger(c, false), CLEAR, "setPayoutToLedger", [false]],
    ["cancel", (c: WriteContext) => cancel(c, [1n, 2n]), BOOK, "cancel", [[1n, 2n]]],
    ["replace on a tick", (c: WriteContext) => replace(c, 7n, 1_500n, 2n), BOOK, "replace", [7n, 1_500n, 2n]],
  ] as const)("%s simulates the right contract call from the account", async (_label, run, address, functionName, args) => {
    const { context, lastCall } = harness();
    await expect(run(context)).resolves.toBe(hash);
    expect(lastCall()).toMatchObject({ account, address, functionName, args });
  });

  it.each([
    ["close zero", (c: WriteContext) => close(c, 42n, 0n), "Close size must be positive."],
    ["deposit zero", (c: WriteContext) => deposit(c, asset, 0n), "Enter a positive deposit."],
    ["withdraw negative", (c: WriteContext) => withdraw(c, asset, -1n), "Enter a positive withdrawal."],
    ["cancel nothing", (c: WriteContext) => cancel(c, []), "Choose an order to cancel."],
    ["replace off-tick", (c: WriteContext) => replace(c, 7n, 1_550n, 2n), "Choose a positive tick price and size"],
    ["replace zero price", (c: WriteContext) => replace(c, 7n, 0n, 2n), "Choose a positive tick price and size"],
    ["replace zero size", (c: WriteContext) => replace(c, 7n, 100n, 0n), "Choose a positive tick price and size"],
  ] as const)("refuses %s before any chain call", async (_label, run, message) => {
    const { context, client } = harness();
    expect(() => run(context)).toThrow(RangeError);
    expect(() => run(context)).toThrow(message);
    expect(client.simulateContract).not.toHaveBeenCalled();
  });

  it("place refuses a validUntil at or before chain now, and a zero price or size", async () => {
    const { context, client } = harness({ now: 1_000n });
    await expect(place(context, 42n, 0, 100n, 1n, 1_000)).rejects.toThrow("Enter a positive price, quantity and future expiry.");
    await expect(place(context, 42n, 0, 0n, 1n, 2_000)).rejects.toThrow(RangeError);
    await expect(place(context, 42n, 0, 100n, 0n, 2_000)).rejects.toThrow(RangeError);
    expect(client.simulateContract).not.toHaveBeenCalled();
    await expect(place(context, 42n, 2, 100n, 1n, 1_001)).resolves.toBe(hash);
  });

  it("restingValidUntil is null when the series expires within a second of chain now", async () => {
    const { client } = harness({ now: 1_000n });
    expect(await restingValidUntil(client as unknown as PublicClient, 1_001)).toBeNull();
    expect(await restingValidUntil(client as unknown as PublicClient, 1_002)).toBe(1_001);
  });
});

describe("take input guards", () => {
  const base: TakeParams = { longId: 42n, buying: true, orderIds: [1n], units: 2n, minUnits: 1n, limitPrice: 100n,
    writeToSell: false, recipient: account, deadline: 2_000, maxTotalFee: 0n };

  it.each([
    ["zero units", { units: 0n }, "Select a positive quantity"],
    ["zero minUnits", { minUnits: 0n }, "Select a positive quantity"],
    ["minUnits above units", { minUnits: 3n }, "Select a positive quantity"],
    ["no orders", { orderIds: [] }, "Select a positive quantity"],
    ["a non-integer deadline", { deadline: 1.5 }, "Refresh this expired quote."],
    ["a zero deadline", { deadline: 0 }, "Refresh this expired quote."],
    ["a negative fee cap", { maxTotalFee: -1n }, "Refresh this invalid fee quote."],
    ["a fee cap above uint128", { maxTotalFee: 1n << 128n }, "Refresh this invalid fee quote."],
  ] as const)("refuses %s", async (_label, patch, message) => {
    const { context, client } = harness();
    await expect(take(context, { ...base, ...patch } as TakeParams)).rejects.toThrow(message);
    expect(client.simulateContract).not.toHaveBeenCalled();
  });
});

describe("recheckTakeQuote refusals", () => {
  const request = { longId: 42n, buying: true, orderIds: [1n], units: 5n, minUnits: 4n, limitPrice: 100n, writeToSell: false, recipient: account };

  it("refuses a quote that fills fewer than minUnits", async () => {
    const { context, client } = harness();
    client.simulateContract.mockResolvedValueOnce({ request: {} as Sim, result: [3n, 30n, 1n, 0n] as never });
    await expect(recheckTakeQuote(context, request, { filled: 3n, premium: 30n, takerFee: 1n, sellerFees: 0n }))
      .rejects.toThrow("There is not enough depth for this fill.");
  });

  it("refuses a fee total that does not fit uint128", async () => {
    const { context, client } = harness();
    const huge = 1n << 127n;
    client.simulateContract.mockResolvedValueOnce({ request: {} as Sim, result: [5n, 30n, huge, huge] as never });
    await expect(recheckTakeQuote(context, request, { filled: 5n, premium: 30n, takerFee: huge, sellerFees: huge }))
      .rejects.toThrow("The quoted fee is too large to submit.");
  });

  it("wraps a reverted requote as a V2WriteError", async () => {
    const { context, client } = harness();
    client.getBlock.mockRejectedValueOnce(new Error("rpc down"));
    await expect(recheckTakeQuote(context, request, { filled: 5n, premium: 30n, takerFee: 1n, sellerFees: 0n }))
      .rejects.toBeInstanceOf(V2WriteError);
  });
});
