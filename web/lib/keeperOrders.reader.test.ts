/** lib/keeperOrders.ts: the production chain reader over a stubbed multicall, and the input gates the main suite skips. */
import type { Hex, PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ZERO_CONDUIT_KEY } from "./contracts";
import { isKeeperOrder, parseKeeperOrdersUrl, serveKeeperOrders, viemKeeperChainReader, type KeeperCheckConfig } from "./keeperOrders";

const VAULT = "0x00000000000000000000000000000000000000Aa";
const SEAPORT = "0x00000000000000000000000000000000000000dd";
const OFFERER = "0x00000000000000000000000000000000000000Ee";
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;

type Contract = { address: string; functionName: string; args?: readonly unknown[] };
const ok = (result: unknown) => ({ status: "success" as const, result });
const fail = { status: "failure" as const, error: new Error("revert") };

function client(answer: (contracts: Contract[]) => unknown[]) {
  const multicall = vi.fn(async ({ contracts }: { contracts: Contract[] }) => answer(contracts));
  return { multicall, client: { multicall } as unknown as PublicClient };
}

const SLOT = [ok(1), ok(H1), ok(20n), ok(80_000_000n), ok(99n), ok(ZERO_CONDUIT_KEY), ok("0x00000000000000000000000000000000000000Cc")];

afterEach(() => vi.restoreAllMocks());

describe("viemKeeperChainReader.readState", () => {
  it("reads the vault slot, Seaport counters and statuses in one unbatched multicall, in order", async () => {
    const { multicall, client: c } = client(() => [...SLOT, ok(7n), ok([true, false, 3n, 20n]), fail]);
    const reader = viemKeeperChainReader(c, { vault: VAULT, seaport: SEAPORT });
    const out = await reader.readState({ offerers: [OFFERER], orderHashes: [H1, H2] });
    expect(out.vault).toEqual({ phase: 1, listingHash: H1, listingAmount: 20n, listingGrossUsdg: 80_000_000n, optionId: 99n,
      conduitKey: ZERO_CONDUIT_KEY, clear: "0x00000000000000000000000000000000000000Cc" });
    expect(out.counters).toEqual([7n]);
    expect(out.statuses).toEqual([{ isCancelled: false, totalFilled: 3n, totalSize: 20n }, undefined]);
    const { contracts, allowFailure, batchSize } = multicall.mock.calls[0]![0] as unknown as { contracts: Contract[]; allowFailure: boolean; batchSize: number };
    expect(allowFailure).toBe(true);
    // One eth_call, so every answer describes the same block.
    expect(batchSize).toBe(0);
    expect(contracts.map((x) => [x.address, x.functionName])).toEqual([
      ...["phase", "listingHash", "listingAmount", "listingGrossUsdg", "optionId", "conduitKey", "clear"].map((f) => [VAULT, f]),
      [SEAPORT, "getCounter"], [SEAPORT, "getOrderStatus"], [SEAPORT, "getOrderStatus"],
    ]);
    expect(contracts[7]!.args).toEqual([OFFERER]);
    expect(contracts[9]!.args).toEqual([H2]);
  });

  it("refuses to answer when any vault slot read fails, rather than guessing a field", async () => {
    const { client: c } = client(() => [...SLOT.slice(0, 6), fail]);
    await expect(viemKeeperChainReader(c, { vault: VAULT, seaport: SEAPORT }).readState({ offerers: [], orderHashes: [] }))
      .rejects.toThrow("vault listing slot unreadable");
  });

  it("a failed counter read is undefined, not zero", async () => {
    const { client: c } = client(() => [...SLOT, fail]);
    const out = await viemKeeperChainReader(c, { vault: VAULT, seaport: SEAPORT }).readState({ offerers: [OFFERER], orderHashes: [] });
    expect(out.counters).toEqual([undefined]);
  });
});

describe("viemKeeperChainReader.getOrderHashes", () => {
  it("asks Seaport for each hash and leaves a failed one undefined", async () => {
    const { multicall, client: c } = client(() => [ok(H1), fail]);
    const components = [{ salt: 1n }, { salt: 2n }] as never;
    expect(await viemKeeperChainReader(c, { vault: VAULT, seaport: SEAPORT }).getOrderHashes(components)).toEqual([H1, undefined]);
    const { contracts } = multicall.mock.calls[0]![0] as unknown as { contracts: Contract[] };
    expect(contracts.map((x) => x.functionName)).toEqual(["getOrderHash", "getOrderHash"]);
  });
});

describe("isKeeperOrder gates", () => {
  const base = { orderHash: H1, parameters: { totalOriginalConsiderationItems: "1" } };

  it("refuses a malformed signature or chain id before looking at the parameters", () => {
    expect(isKeeperOrder({ ...base, signature: "nothex" })).toBe(false);
    expect(isKeeperOrder({ ...base, signature: 5 })).toBe(false);
    for (const chainId of [0, -1, 1.5, "4663"]) expect(isKeeperOrder({ ...base, chainId })).toBe(false);
  });

  it("refuses a missing or non-decimal totalOriginalConsiderationItems", () => {
    expect(isKeeperOrder({ orderHash: H1, parameters: {} })).toBe(false);
    expect(isKeeperOrder({ orderHash: H1, parameters: { totalOriginalConsiderationItems: "0x1" } })).toBe(false);
    expect(isKeeperOrder([base])).toBe(false);
  });
});

describe("parseKeeperOrdersUrl", () => {
  it("refuses a non-http scheme and an unparseable value without echoing it", () => {
    expect(parseKeeperOrdersUrl("ftp://keeper.internal/orders")).toEqual({ kind: "invalid", problem: "KEEPER_ORDERS_URL must be an http or https URL." });
    expect(parseKeeperOrdersUrl("file:///etc/passwd")).toMatchObject({ kind: "invalid" });
    expect(parseKeeperOrdersUrl("not a url")).toEqual({ kind: "invalid", problem: "KEEPER_ORDERS_URL is not a URL." });
    expect(parseKeeperOrdersUrl("   ")).toEqual({ kind: "unset" });
  });
});

describe("serveKeeperOrders without a vault or a custom log", () => {
  const config: KeeperCheckConfig = { vault: undefined as never, usdg: VAULT, clearinghouse: VAULT, seaport: SEAPORT, chainId: 4663 };
  const chain = { readState: vi.fn(), getOrderHashes: vi.fn() };

  it("answers 503 without fetching when the build has no vault", async () => {
    const fetchImpl = vi.fn();
    const out = await serveKeeperOrders({ keeperOrdersUrl: "http://keeper.internal/orders", config, chain, nowSeconds: 1, fetchImpl: fetchImpl as never });
    expect(out).toEqual({ status: 503, body: { configured: true, orders: [], rejected: [], closed: [], unchecked: [],
      error: "This build has no vault address configured, so nothing can be checked." } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(chain.readState).not.toHaveBeenCalled();
  });

  it("the default log writes one JSON line to console.warn for an error, naming the route and not the URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await serveKeeperOrders({ keeperOrdersUrl: "ftp://user:pw@keeper/orders", config, chain, nowSeconds: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({ service: "web", route: "/api/keeper/orders", level: "error", msg: "order feed misconfigured" });
    expect(String(warn.mock.calls[0]![0])).not.toContain("pw@");
  });
});
