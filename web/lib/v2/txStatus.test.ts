import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import { findV2ReceiptUnknown, V2ReceiptUnknownError, waitForV2Receipt } from "./txStatus";

const hash = `0x${"1".repeat(64)}` as const;

describe("v2 submitted transaction status", () => {
  it("preserves a submitted hash when the receipt RPC rejects", async () => {
    const client = { waitForTransactionReceipt: vi.fn(async () => { throw new Error("RPC unavailable"); }) } as unknown as PublicClient;
    await expect(waitForV2Receipt(client, hash, "take")).rejects.toMatchObject({
      name: "V2ReceiptUnknownError", hash, operation: "take",
    });
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith({ hash });
  });

  it("keeps an explicit reverted receipt distinct from an unknown outcome", async () => {
    const client = { waitForTransactionReceipt: vi.fn(async () => ({ status: "reverted" })) } as unknown as PublicClient;
    await expect(waitForV2Receipt(client, hash, "take")).rejects.toThrow("reverted on chain");
    try { await waitForV2Receipt(client, hash, "take"); }
    catch (error) { expect(findV2ReceiptUnknown(error)).toBeNull(); }
  });

  it("finds the hash through a contextual error from a later step", () => {
    const submitted = new V2ReceiptUnknownError(hash, "place", new Error("timeout"));
    const wrapped = new Error("The crossing buy confirmed", { cause: submitted });
    expect(findV2ReceiptUnknown(wrapped)).toBe(submitted);
  });
});
