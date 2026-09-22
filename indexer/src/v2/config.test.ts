import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opsDir = fileURLToPath(new URL("../../../ops/", import.meta.url));

const ADDRESSES = {
  V2_CLEARINGHOUSE: "0x0000000000000000000000000000000000000011",
  V2_ORDER_BOOK: "0x0000000000000000000000000000000000000022",
  V2_SETTLEMENT_ORACLE: "0x0000000000000000000000000000000000000033",
  V2_AUTO_ROLLER: "0x0000000000000000000000000000000000000044",
  V2_MAKER_REGISTRY: "0x0000000000000000000000000000000000000055",
} as const;

const V2_NAMES = ["Clearinghouse", "OrderBook", "SettlementOracle", "AutoRoller", "MakerRegistry"];
const V8_ADDRESSES = {
  V2_ACCESS_MANAGER: "0x0000000000000000000000000000000000000066",
  V2_PAYOUT_ROUTER: "0x0000000000000000000000000000000000000077",
  V2_FEE_SPLITTER: "0x0000000000000000000000000000000000000088",
  V2_BUYBACK_EXECUTOR: "0x0000000000000000000000000000000000000099",
} as const;
const FLYWHEEL_TOKEN = "0x00000000000000000000000000000000000000aa";
const V8_NAMES = ["AccessManager", "PayoutRouter", "FeeSplitter", "BuybackExecutor"];

beforeEach(() => {
  vi.resetModules();
  for (const key of [
    "VAULT_ADDRESS", "VAULT", "FACTORY_ADDRESS", "FACTORY", "START_BLOCK",
    "V2_CLEARINGHOUSE", "V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER",
    "V2_MAKER_REGISTRY", "V2_EXPIRY_CALENDAR", "V2_KEEPER_REWARDS", "V2_ACCESS_MANAGER",
    "V2_PAYOUT_ROUTER", "V2_FEE_SPLITTER", "V2_BUYBACK_EXECUTOR", "V2_FLYWHEEL_TOKEN_ADDRESS",
    "V2_MAKER_VAULT", "V2_REWARDS_DISTRIBUTOR", "V2_REWARDS_DISTRIBUTORS", "V2_FLYWHEEL_START_BLOCK",
    "V2_EARN_VAULT", "V2_ZAP_HELPER", "V2_HOUSE_VAULT_FACTORY", "V2_EARN_START_BLOCK", "V2_HOUSE_START_BLOCK",
    "V2_START_BLOCK", "PRICING_URL",
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

function setV8Sources() {
  for (const [key, value] of Object.entries(V8_ADDRESSES)) vi.stubEnv(key, value);
  vi.stubEnv("V2_FLYWHEEL_TOKEN_ADDRESS", FLYWHEEL_TOKEN);
  vi.stubEnv("V2_FLYWHEEL_START_BLOCK", "63999990");
}

function clearFlywheel() {
  vi.stubEnv("V2_FEE_SPLITTER", undefined);
  vi.stubEnv("V2_BUYBACK_EXECUTOR", undefined);
  vi.stubEnv("V2_FLYWHEEL_TOKEN_ADDRESS", undefined);
  vi.stubEnv("V2_FLYWHEEL_START_BLOCK", undefined);
}

describe("v2 Ponder deployment config", () => {
  it("boots from the rendered production env when the flywheel and existing periphery are populated", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ponder-indexer-env-"));
    try {
      const registry = JSON.parse(readFileSync(path.join(opsDir, "markets/tier1.json"), "utf8"));
      const address = (suffix: number) => `0x${suffix.toString(16).padStart(40, "0")}`;
      Object.assign(registry.v2.contracts, {
        clearinghouse: address(1), orderBook: address(2), settlementOracle: address(3),
        autoRoller: address(4), makerRegistry: address(5), makerVault: address(6),
        rewardsDistributor: address(7),
      });
      registry.v2.deployBlock = 64000000;
      registry.v2.flywheel = { feeSplitter: address(8), buybackExecutor: address(9), deployBlock: 63999990 };
      registry.shared.token.address = address(10);
      const registryFile = path.join(scratch, "populated.json");
      writeFileSync(registryFile, JSON.stringify(registry));
      const render = spawnSync(process.execPath, [
        path.join(opsDir, "v2-env.mjs"), "--registry", registryFile,
        "--out", scratch, "--services", "indexer-v2",
      ], { encoding: "utf8" });
      expect(render.status, render.stderr).toBe(0);
      for (const line of readFileSync(path.join(scratch, "indexer-v2.env"), "utf8").split("\n")) {
        if (!/^[A-Z][A-Z0-9_]*=/.test(line)) continue;
        const separator = line.indexOf("=");
        vi.stubEnv(line.slice(0, separator), line.slice(separator + 1));
      }
      const { default: config } = await import("../../ponder.config");
      expect(config.contracts.FeeSplitter).toMatchObject({ address: address(8), startBlock: 63999990 });
      expect(config.contracts.BuybackExecutor).toMatchObject({ address: address(9), startBlock: 63999990 });
      expect(config.contracts.MakerVault).toMatchObject({ address: address(6), startBlock: 64000000 });
      expect(config.contracts.RewardsDistributor).toMatchObject({ address: [address(7)], startBlock: 64000000 });
      const { V2_FLYWHEEL_TOKEN_ADDRESS } = await import("../../lib/env");
      expect(V2_FLYWHEEL_TOKEN_ADDRESS).toBe(getAddress(address(10)));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

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
    vi.stubEnv("V2_MAKER_VAULT", "0x0000000000000000000000000000000000000088");
    vi.stubEnv("V2_REWARDS_DISTRIBUTOR", "0x0000000000000000000000000000000000000099");
    const { default: config } = await import("../../ponder.config");
    expect(Object.keys(config.contracts)).toEqual([
      ...V2_NAMES, "ExpiryCalendar", "KeeperRewards", "MakerVault", "RewardsDistributor",
    ]);
    expect(config.contracts.ExpiryCalendar?.startBlock).toBe(64000000);
    expect(config.contracts.KeeperRewards?.startBlock).toBe(64000000);
    expect(config.contracts.MakerVault?.startBlock).toBe(64000000);
    expect(config.contracts.RewardsDistributor).toMatchObject({
      address: ["0x0000000000000000000000000000000000000099"], startBlock: 64000000,
    });
  });

  it("indexes every configured distributor while keeping programme names open", async () => {
    setV2();
    vi.stubEnv("V2_REWARDS_DISTRIBUTORS", JSON.stringify([
      { program: "maker", address: "0x0000000000000000000000000000000000000099" },
      { program: "future-lenders", address: "0x00000000000000000000000000000000000000aa" },
    ]));
    const [{ default: config }, { V2_REWARDS_DISTRIBUTORS }] = await Promise.all([
      import("../../ponder.config"), import("../../lib/env"),
    ]);
    expect(config.contracts.RewardsDistributor).toMatchObject({
      address: [
        "0x0000000000000000000000000000000000000099",
        "0x00000000000000000000000000000000000000AA",
      ],
      startBlock: 64000000,
    });
    expect(V2_REWARDS_DISTRIBUTORS.map(({ program }) => program)).toEqual(["maker", "future-lenders"]);
  });

  it("adds every v8 source at its own deployment boundary", async () => {
    setV2();
    setV8Sources();
    const { default: config } = await import("../../ponder.config");
    expect(Object.keys(config.contracts)).toEqual([...V2_NAMES, ...V8_NAMES]);
    expect(config.contracts.AccessManager).toMatchObject({
      address: V8_ADDRESSES.V2_ACCESS_MANAGER, startBlock: 64000000,
    });
    expect(config.contracts.PayoutRouter).toMatchObject({
      address: V8_ADDRESSES.V2_PAYOUT_ROUTER, startBlock: 64000000,
    });
    expect(config.contracts.FeeSplitter).toMatchObject({
      address: V8_ADDRESSES.V2_FEE_SPLITTER, startBlock: 63999990,
    });
    expect(config.contracts.BuybackExecutor).toMatchObject({
      address: V8_ADDRESSES.V2_BUYBACK_EXECUTOR, startBlock: 63999990,
    });
  });

  it("configures BuybackExecutor from its generated ABI without duplicate events", async () => {
    setV2();
    setV8Sources();
    const [{ default: config }, { buybackExecutorAbi }] = await Promise.all([
      import("../../ponder.config"),
      import("../../abis/v2/buybackExecutor"),
    ]);
    expect(config.contracts.BuybackExecutor?.abi).toEqual(buybackExecutorAbi);
    for (const eventName of ["Bought", "Burned"]) {
      expect(config.contracts.BuybackExecutor?.abi.filter((item) =>
        item.type === "event" && item.name === eventName,
      )).toHaveLength(1);
    }
  });

  it("House sources consume the generated complete contract ABIs", async () => {
    setV2();
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", "0x00000000000000000000000000000000000000bb");
    vi.stubEnv("V2_HOUSE_START_BLOCK", "63999999");
    const [{ default: config }, { houseVaultAbi }, { houseVaultFactoryAbi }] = await Promise.all([
      import("../../ponder.config"),
      import("../../abis/v2/houseVault"),
      import("../../abis/v2/houseVaultFactory"),
    ]);
    expect(config.contracts.HouseVault?.abi).toEqual(houseVaultAbi);
    expect(config.contracts.HouseVaultFactory?.abi).toEqual(houseVaultFactoryAbi);
    expect(houseVaultAbi.some((item) => item.type === "event" && item.name === "Approval")).toBe(true);
    expect(houseVaultAbi.some((item) => item.type === "event" && item.name === "AuthorityUpdated")).toBe(true);
    expect(houseVaultFactoryAbi.some((item) => item.type === "event" && item.name === "AuthorityUpdated")).toBe(true);
  });

  it("refuses an optional periphery source without the v2 group", async () => {
    vi.stubEnv("VAULT_ADDRESS", "0x00000000000000000000000000000000000000aa");
    vi.stubEnv("START_BLOCK", "1234");
    vi.stubEnv("V2_EXPIRY_CALENDAR", "0x0000000000000000000000000000000000000066");
    await expect(import("../../ponder.config")).rejects.toThrow("without V2_CLEARINGHOUSE");
  });

  it.each(Object.entries(V8_ADDRESSES))("refuses v8 source %s without the v2 group", async (name, value) => {
    vi.stubEnv("VAULT_ADDRESS", "0x00000000000000000000000000000000000000aa");
    vi.stubEnv("START_BLOCK", "1234");
    vi.stubEnv(name, value);
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

  it("validates the flywheel source group and its earlier start block", async () => {
    setV2();
    vi.stubEnv("V2_BUYBACK_EXECUTOR", V8_ADDRESSES.V2_BUYBACK_EXECUTOR);
    await expect(import("../../ponder.config")).rejects.toThrow("without V2_FEE_SPLITTER");

    vi.resetModules();
    setV2();
    clearFlywheel();
    vi.stubEnv("V2_FEE_SPLITTER", V8_ADDRESSES.V2_FEE_SPLITTER);
    vi.stubEnv("V2_FLYWHEEL_TOKEN_ADDRESS", FLYWHEEL_TOKEN);
    await expect(import("../../ponder.config")).rejects.toThrow("V2_FLYWHEEL_START_BLOCK");

    vi.resetModules();
    setV2();
    clearFlywheel();
    vi.stubEnv("V2_FLYWHEEL_START_BLOCK", "63999990");
    await expect(import("../../ponder.config")).rejects.toThrow("without V2_FEE_SPLITTER");

    vi.resetModules();
    setV2();
    clearFlywheel();
    vi.stubEnv("V2_FEE_SPLITTER", V8_ADDRESSES.V2_FEE_SPLITTER);
    vi.stubEnv("V2_FLYWHEEL_TOKEN_ADDRESS", FLYWHEEL_TOKEN);
    vi.stubEnv("V2_FLYWHEEL_START_BLOCK", "0");
    await expect(import("../../ponder.config")).rejects.toThrow("above zero");

    vi.resetModules();
    setV2();
    clearFlywheel();
    vi.stubEnv("V2_FEE_SPLITTER", V8_ADDRESSES.V2_FEE_SPLITTER);
    await expect(import("../../ponder.config")).rejects.toThrow("V2_FLYWHEEL_TOKEN_ADDRESS");
  });

  it("rejects a malformed v8 source address", async () => {
    setV2();
    vi.stubEnv("V2_ACCESS_MANAGER", "not-an-address");
    await expect(import("../../ponder.config")).rejects.toThrow("V2_ACCESS_MANAGER");
  });

  it("validates the optional pricing URL when v2 is active", async () => {
    setV2();
    vi.stubEnv("PRICING_URL", "not-a-url");
    await expect(import("../../ponder.config")).rejects.toThrow("PRICING_URL");
  });
});
