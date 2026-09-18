import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADDRESSES = {
  V2_CLEARINGHOUSE: "0x0000000000000000000000000000000000000011",
  V2_ORDER_BOOK: "0x0000000000000000000000000000000000000022",
  V2_SETTLEMENT_ORACLE: "0x0000000000000000000000000000000000000033",
  V2_AUTO_ROLLER: "0x0000000000000000000000000000000000000044",
  V2_MAKER_REGISTRY: "0x0000000000000000000000000000000000000055",
} as const;

const V2_NAMES = ["Clearinghouse", "OrderBook", "SettlementOracle", "AutoRoller", "MakerRegistry"];

beforeEach(() => {
  vi.resetModules();
  for (const key of [
    "VAULT_ADDRESS", "VAULT", "FACTORY_ADDRESS", "FACTORY", "START_BLOCK",
    "V2_CLEARINGHOUSE", "V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER",
    "V2_MAKER_REGISTRY", "V2_EXPIRY_CALENDAR", "V2_KEEPER_REWARDS", "V2_START_BLOCK", "PRICING_URL",
  ]) vi.stubEnv(key, undefined);
  vi.stubEnv("PONDER_RPC_URL_4663", "https://example.invalid/rpc");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function setV2() {
  for (const [key, value] of Object.entries(ADDRESSES)) vi.stubEnv(key, value);
  vi.stubEnv("V2_START_BLOCK", "64000000");
}

describe("v2 Ponder deployment config", () => {
  it("leaves the v1 source set intact with no V2 env", async () => {
    vi.stubEnv("VAULT_ADDRESS", "0x00000000000000000000000000000000000000aa");
    vi.stubEnv("START_BLOCK", "1234");
    vi.stubEnv("PRICING_URL", "unused-by-legacy");
    const { default: config } = await import("../../ponder.config");
    const names = Object.keys(config.contracts);
    expect(names).toEqual([
      "Vault", "Clear", "Seaport", "StockTokenIn", "StockTokenOut", "StockToken", "UsdgIn", "UsdgOut",
    ]);
    expect(names).not.toContain("Clearinghouse");
    expect(config.contracts.Vault?.startBlock).toBe(1234);
    expect(Object.keys(config.blocks)).toEqual([]);
  });

  it("allows v2 by itself and registers all five contracts from V2_START_BLOCK", async () => {
    setV2();
    const { default: config } = await import("../../ponder.config");
    expect(Object.keys(config.contracts)).toEqual(V2_NAMES);
    expect(config.blocks.V2Clock).toMatchObject({ chain: "robinhood", startBlock: 64000000, interval: 600 });
    for (const [name, address] of Object.entries(ADDRESSES)) {
      const source = config.contracts[V2_NAMES[Object.keys(ADDRESSES).indexOf(name)] as keyof typeof config.contracts];
      expect(source?.address).toBe(address);
      expect(source?.startBlock).toBe(64000000);
    }
  });

  it("adds each optional periphery source only when its address is set", async () => {
    setV2();
    vi.stubEnv("V2_EXPIRY_CALENDAR", "0x0000000000000000000000000000000000000066");
    vi.stubEnv("V2_KEEPER_REWARDS", "0x0000000000000000000000000000000000000077");
    const { default: config } = await import("../../ponder.config");
    expect(Object.keys(config.contracts)).toEqual([...V2_NAMES, "ExpiryCalendar", "KeeperRewards"]);
    expect(config.contracts.ExpiryCalendar?.startBlock).toBe(64000000);
    expect(config.contracts.KeeperRewards?.startBlock).toBe(64000000);
  });

  it("refuses an optional periphery source without the v2 group", async () => {
    vi.stubEnv("VAULT_ADDRESS", "0x00000000000000000000000000000000000000aa");
    vi.stubEnv("START_BLOCK", "1234");
    vi.stubEnv("V2_EXPIRY_CALENDAR", "0x0000000000000000000000000000000000000066");
    await expect(import("../../ponder.config")).rejects.toThrow("without V2_CLEARINGHOUSE");
  });

  it("can index legacy and v2 sources together with separate start blocks", async () => {
    setV2();
    vi.stubEnv("FACTORY_ADDRESS", "0x00000000000000000000000000000000000000bb");
    vi.stubEnv("START_BLOCK", "1000");
    vi.stubEnv("MARKET", "NVDA");
    const { default: config } = await import("../../ponder.config");
    expect(config.contracts.Factory?.startBlock).toBe(1000);
    expect(config.contracts.Clearinghouse?.startBlock).toBe(64000000);
    expect(Object.keys(config.contracts)).toEqual(["Factory", "WriterAccount", ...V2_NAMES]);
  });

  it("requires the dedicated v2 start block", async () => {
    setV2();
    vi.stubEnv("V2_START_BLOCK", undefined);
    await expect(import("../../ponder.config")).rejects.toThrow("V2_START_BLOCK");
  });

  it("still requires START_BLOCK for a legacy group when v2 is enabled", async () => {
    setV2();
    vi.stubEnv("VAULT_ADDRESS", "0x00000000000000000000000000000000000000aa");
    await expect(import("../../ponder.config")).rejects.toThrow("START_BLOCK");
  });

  it("rejects an incomplete v2 address set", async () => {
    setV2();
    vi.stubEnv("V2_ORDER_BOOK", undefined);
    await expect(import("../../ponder.config")).rejects.toThrow("V2_ORDER_BOOK");
  });

  it("rejects a stray v2 address without its clearinghouse", async () => {
    vi.stubEnv("VAULT_ADDRESS", "0x00000000000000000000000000000000000000aa");
    vi.stubEnv("START_BLOCK", "1234");
    vi.stubEnv("V2_ORDER_BOOK", ADDRESSES.V2_ORDER_BOOK);
    await expect(import("../../ponder.config")).rejects.toThrow("without V2_CLEARINGHOUSE");
  });

  it("rejects a malformed v2 address and start block", async () => {
    setV2();
    vi.stubEnv("V2_ORDER_BOOK", "not-an-address");
    await expect(import("../../ponder.config")).rejects.toThrow("V2_ORDER_BOOK");

    vi.resetModules();
    setV2();
    vi.stubEnv("V2_START_BLOCK", "-1");
    await expect(import("../../ponder.config")).rejects.toThrow("V2_START_BLOCK");
  });

  it("validates the optional pricing URL when v2 is active", async () => {
    setV2();
    vi.stubEnv("PRICING_URL", "not-a-url");
    await expect(import("../../ponder.config")).rejects.toThrow("PRICING_URL");
  });
});
