import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { conversionFloorBps, readConversionFloor } from "./conversion";
vi.mock("./config", () => ({ requireV2Address: () => "0x0000000000000000000000000000000000000001" }));
describe("per-market payout conversion floor", () => {
  it("adds the market route fee, caps it, and clamps the overall bound", () => {
    expect(conversionFloorBps(50, 5)).toBe(9945);
    expect(conversionFloorBps(50, 100)).toBe(9850);
    expect(conversionFloorBps(250, 100)).toBe(9700);
    expect(conversionFloorBps(50, 10000)).toBe(9850);
    expect(() => conversionFloorBps(-1, 1)).toThrow();
  });
  it("reads the current adapter, slippage and route at one block", async () => {
    const asset = "0x0000000000000000000000000000000000000002";
    const readContract = vi.fn(async () => 30n);
    const client = { getBlockNumber: vi.fn(async () => 12n), multicall: vi.fn(async () => [asset, 50]), readContract } as unknown as PublicClient;
    expect(await readConversionFloor(asset, client)).toBe(9920);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "routeFeeBps", args: [asset], blockNumber: 12n }));
  });
});
