import { describe, expect, it, vi } from "vitest";
import { decodeFunctionResult, encodeAbiParameters, parseAbi, zeroAddress, type PublicClient } from "viem";
import { payoutAdapterAbi } from "../abi/v2/payoutAdapter";
import { conversionFloorBps, readConversionFloor, readConversionFloorState } from "./conversion";
vi.mock("./config", () => ({ requireV2Address: () => "0x0000000000000000000000000000000000000001" }));
describe("per-market payout conversion floor", () => {
  it("adds the market route fee, caps it, and clamps the overall bound", () => {
    expect(conversionFloorBps(50, 5)).toBe(9945);
    expect(conversionFloorBps(50, 100)).toBe(9850);
    expect(conversionFloorBps(250, 100)).toBe(9700);
    expect(conversionFloorBps(50, 10000)).toBe(9850);
    expect(() => conversionFloorBps(-1, 1)).toThrow();
  });
  it("distinguishes the router routes() tuple from the adapter tuple on the same bytes", () => {
    // IPayoutRouter.routes(address) and UniV3PayoutAdapter.routes(address) share selector 0xd7409659.
    // The router returns (uint8 venue, uint24 fee, int24 tickSpacing, address v3Pool, uint16 feeBps);
    // the adapter returns (address pool, uint24 fee). Decoding the router bytes with the adapter ABI
    // reads VENUE-AS-ADDRESS (0x...0001) and does not revert - the silent mis-decode T-69 closes.
    const pool = "0x0000000000000000000000000000000000000003";
    const routerData = encodeAbiParameters(
      [{ type: "tuple", name: "", components: [
        { name: "venue", type: "uint8" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "v3Pool", type: "address" },
        { name: "feeBps", type: "uint16" },
      ] }],
      [{ venue: 1, fee: 3_000, tickSpacing: 60, v3Pool: pool, feeBps: 30 }],
    );
    const router = decodeFunctionResult({ abi: payoutAdapterAbi, functionName: "routes", data: routerData });
    expect((router as { venue?: number }).venue).toBe(1);
    expect((router as { v3Pool?: string }).v3Pool).toBe(pool);
    expect((router as { feeBps?: number }).feeBps).toBe(30);

    const adapter = decodeFunctionResult({
      abi: parseAbi(["function routes(address) view returns (address pool, uint24 fee)"]),
      functionName: "routes",
      data: routerData,
    });
    const [adapterPool, adapterFee] = adapter as [string, number];
    expect(adapterPool.toLowerCase()).toBe("0x0000000000000000000000000000000000000001");
    expect(adapterPool).not.toBe(pool);
    expect(adapterFee).toBe(3_000);
  });

  it("reads the current adapter, slippage and route at one block", async () => {
    const asset = "0x0000000000000000000000000000000000000002";
    const pool = "0x0000000000000000000000000000000000000003";
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "routes" ? { venue: 1, fee: 3_000, tickSpacing: 0, v3Pool: pool, feeBps: 30 } as const : 30n);
    const client = { getBlockNumber: vi.fn(async () => 12n), multicall: vi.fn(async () => [asset, 50]), readContract } as unknown as PublicClient;
    expect(await readConversionFloorState(asset, client)).toEqual({ kind: "routed", floorBps: 9920 });
    expect(readContract).toHaveBeenNthCalledWith(1, expect.objectContaining({ functionName: "routes", args: [asset], blockNumber: 12n }));
    expect(readContract).toHaveBeenNthCalledWith(2, expect.objectContaining({ functionName: "routeFeeBps", args: [asset], blockNumber: 12n }));
  });
  it("recognises a v4 route even though its v3Pool field is zero", async () => {
    const asset = "0x0000000000000000000000000000000000000002";
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "routes"
        ? { venue: 2, fee: 3_000, tickSpacing: 60, v3Pool: zeroAddress, feeBps: 35 } as const
        : 35n);
    const client = { getBlockNumber: vi.fn(async () => 12n), multicall: vi.fn(async () => [asset, 50]), readContract } as unknown as PublicClient;
    expect(await readConversionFloorState(asset, client)).toEqual({ kind: "routed", floorBps: 9_915 });
    expect(readContract).toHaveBeenCalledTimes(2);
  });
  it("identifies an unrouted market without presenting a conversion floor", async () => {
    const asset = "0x0000000000000000000000000000000000000002";
    const readContract = vi.fn(async () =>
      ({ venue: 0, fee: 0, tickSpacing: 0, v3Pool: zeroAddress, feeBps: 0 }) as const);
    const client = { getBlockNumber: vi.fn(async () => 12n), multicall: vi.fn(async () => [asset, 50]), readContract } as unknown as PublicClient;
    expect(await readConversionFloorState(asset, client)).toEqual({ kind: "unrouted" });
    expect(readContract).toHaveBeenCalledOnce();
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "routes", args: [asset], blockNumber: 12n }));
  });
  it("identifies an unset adapter without reading a route", async () => {
    const asset = "0x0000000000000000000000000000000000000002";
    const readContract = vi.fn();
    const client = { getBlockNumber: vi.fn(async () => 12n), multicall: vi.fn(async () => [zeroAddress, 50]), readContract } as unknown as PublicClient;
    expect(await readConversionFloorState(asset, client)).toEqual({ kind: "unset" });
    expect(readContract).not.toHaveBeenCalled();
  });
  it("keeps the numeric floor API and returns null when conversion is unavailable", async () => {
    const asset = "0x0000000000000000000000000000000000000002";
    const routed = { getBlockNumber: vi.fn(async () => 12n), multicall: vi.fn(async () => [asset, 50]),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "routes"
          ? { venue: 1, fee: 3_000, tickSpacing: 0, v3Pool: asset, feeBps: 30 } as const
          : 30n) } as unknown as PublicClient;
    const unset = { getBlockNumber: vi.fn(async () => 12n), multicall: vi.fn(async () => [zeroAddress, 50]),
      readContract: vi.fn() } as unknown as PublicClient;
    expect(await readConversionFloor(asset, routed)).toBe(9_920);
    expect(await readConversionFloor(asset, unset)).toBeNull();
  });
});
