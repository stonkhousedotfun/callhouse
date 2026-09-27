import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOUSE_FACTORY_NOT_REGISTRY,
  HOUSE_SOURCE_FACTORY_FALLBACK,
  HOUSE_VAULT_UNREGISTERED,
  assertProductionHouseFactory,
  houseRegistryHealth,
  houseVaultSourceFor,
  isUnregisteredHouseVault,
  launchFactoryMismatch,
} from "../../lib/v2/houseVaultSource";

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
    "V2_START_BLOCK", "PRICING_URL", "V2_PRODUCTION",
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
      // The Clearinghouse stays the registry's own. This registry is not a dev one, so the render sets
      // V2_PRODUCTION=1, and a production process refuses a V2_CLEARINGHOUSE its baked registry does not name. The
      // baked registry is generated from this same tier1.json, so its Clearinghouse is the one rendered here.
      Object.assign(registry.v2.contracts, {
        orderBook: address(2), settlementOracle: address(3),
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
      expect(process.env.V2_PRODUCTION).toBe("1");
      expect(process.env.V2_CLEARINGHOUSE?.toLowerCase()).toBe(registry.v2.contracts.clearinghouse.toLowerCase());
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

  it("House sources: the generated vault ABI, and the launch factory on the legacy VaultCreated", async () => {
    setV2();
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", "0x00000000000000000000000000000000000000bb");
    vi.stubEnv("V2_HOUSE_START_BLOCK", "63999999");
    const [{ default: config }, { houseVaultAbi }, { houseVaultFactoryAbi }, { houseVaultFactoryIndexingAbi }, { getAbiItem, toEventSelector }] = await Promise.all([
      import("../../ponder.config"),
      import("../../abis/v2/houseVault"),
      import("../../abis/v2/houseVaultFactory"),
      import("../../lib/v2/houseVaultEvents"),
      import("viem"),
    ]);
    expect(config.contracts.HouseVault?.abi).toEqual(houseVaultAbi);
    // The launch factory predates `bool weekly`, so its source is indexed
    // with the generated AuthorityUpdated plus the LEGACY 4-field VaultCreated, and clone discovery keys on
    // the legacy topic. The generated factory ABI's VaultCreated is a different topic the factory never emits.
    expect(config.contracts.HouseVaultFactory?.abi).toEqual([
      getAbiItem({ abi: houseVaultFactoryAbi, name: "AuthorityUpdated" }),
      ...houseVaultFactoryIndexingAbi,
    ]);
    const legacyCreated = houseVaultFactoryIndexingAbi[0];
    expect(legacyCreated.inputs).toHaveLength(4);
    expect(toEventSelector(legacyCreated)).not.toBe(
      toEventSelector(getAbiItem({ abi: houseVaultFactoryAbi, name: "VaultCreated" })));
    expect(houseVaultAbi.some((item) => item.type === "event" && item.name === "Approval")).toBe(true);
    expect(houseVaultAbi.some((item) => item.type === "event" && item.name === "AuthorityUpdated")).toBe(true);
    expect(houseVaultFactoryAbi.some((item) => item.type === "event" && item.name === "AuthorityUpdated")).toBe(true);
  });

  it("the registry's House factory indexes the registry vault list, not factory() discovery", async () => {
    setV2();
    // The launch factory, the House factories' deploy blocks and the vault list are read from the generated registry
    // (they were typed as the v8 values, so the v9 regen turned this case into the factory() fallback).
    const { V2_REGISTRY } = await import("../../lib/v2/marketRegistry.generated");
    const launch = getAddress(V2_REGISTRY.contracts.houseVaultFactory as string);
    const earliest = Math.min(...V2_REGISTRY.house.factories.map((f) => f.deployBlock as number));
    // An env start block later than every recorded factory block (by 82,100 blocks, as the v8 case had it).
    const envBlock = Math.max(...V2_REGISTRY.house.factories.map((f) => f.deployBlock as number)) + 82_100;
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", launch);
    vi.stubEnv("V2_HOUSE_START_BLOCK", String(envBlock));
    const { default: config } = await import("../../ponder.config");
    // The registry's House vaults (NVDA's and SPCX's), checksummed and sorted by lowercase address.
    const vaults = V2_REGISTRY.house.vaults.map((v) => getAddress(v.address)).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    expect(vaults.length, "the registry lists House vaults, so registry mode is what this case reaches").toBeGreaterThan(0);
    expect(config.contracts.HouseVault?.address).toEqual(vaults);
    // The earliest recorded start: the factory's deploy block is earlier than this env block, so it wins.
    expect(config.contracts.HouseVault?.startBlock).toBe(earliest);
    // The factory is still its own source, at the env block, so VaultCreated for an unlisted vault still arrives.
    expect(config.contracts.HouseVaultFactory?.address).toBe(launch);
    expect(config.contracts.HouseVaultFactory?.startBlock).toBe(envBlock);
  });

  it("a factory the registry does not name keeps factory() discovery, and says so", async () => {
    setV2();
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", "0x00000000000000000000000000000000000000bb");
    vi.stubEnv("V2_HOUSE_START_BLOCK", "63999999");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { default: config } = await import("../../ponder.config");
      const address = config.contracts.HouseVault?.address as unknown;
      expect(Array.isArray(address)).toBe(false);
      expect(address).toMatchObject({ address: "0x00000000000000000000000000000000000000bb", parameter: "vault" });
      expect(config.contracts.HouseVault?.startBlock).toBe(63999999);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("HouseVault source: factory() discovery");
    } finally {
      warn.mockRestore();
    }
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

describe("PONDER_RPC_URL_4663: one URL or several", () => {
  // Placeholders only: a real keyed URL must never appear in the repo.
  const KEYED = "https://robinhood-mainnet.g.alchemy.com/v2/<key-a>";
  const KEYED_B = "https://robinhood-mainnet.g.alchemy.com/v2/<key-b>";
  const OTHER = "https://archive.example.invalid/rpc";

  async function load(value: string | undefined) {
    vi.stubEnv("VAULT_ADDRESS", "0x00000000000000000000000000000000000000aa");
    vi.stubEnv("START_BLOCK", "1234");
    vi.stubEnv("PONDER_RPC_URL_4663", value);
    const env = await import("../../lib/env");
    const { default: config } = await import("../../ponder.config");
    return { env, rpc: config.chains.robinhood.rpc };
  }

  it("hands Ponder one URL as the plain string it has always received", async () => {
    const { env, rpc } = await load(KEYED);
    expect(rpc).toBe(KEYED);
    expect(typeof rpc).toBe("string");
    expect(env.RPC_URLS).toEqual([KEYED]);
  });

  it("still trims a single URL, as before", async () => {
    const { rpc } = await load(`  ${KEYED}\n`);
    expect(rpc).toBe(KEYED);
  });

  it("hands Ponder three comma-separated URLs as three array entries, in order", async () => {
    const { env, rpc } = await load(`${KEYED},${KEYED_B},${OTHER}`);
    expect(rpc).toEqual([KEYED, KEYED_B, OTHER]);
    expect(env.RPC_URLS).toEqual([KEYED, KEYED_B, OTHER]);
  });

  it("trims whitespace around each entry", async () => {
    const { rpc } = await load(` ${KEYED} ,\t${KEYED_B}\n, ${OTHER} `);
    expect(rpc).toEqual([KEYED, KEYED_B, OTHER]);
  });

  it("keeps a repeated URL as separate entries: each is its own Ponder limiter", async () => {
    const { rpc } = await load(`${KEYED},${KEYED}`);
    expect(rpc).toEqual([KEYED, KEYED]);
  });

  it.each([
    ["a trailing comma", `${KEYED},`, 2, 2],
    ["a leading comma", `,${KEYED}`, 1, 2],
    ["a doubled comma", `${KEYED},,${KEYED_B}`, 2, 3],
    ["a blank entry between commas", `${KEYED}, ,${KEYED_B}`, 2, 3],
  ])("refuses %s and does not echo the keyed URL", async (_label, value, position, total) => {
    let message = "";
    try {
      await load(value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`PONDER_RPC_URL_4663 has an empty entry at position ${position} of ${total}`);
    expect(message).not.toContain("<key-");
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("refuses a missing value (%s) exactly as before", async (_label, value) => {
    await expect(load(value)).rejects.toThrow(
      "Missing required environment variable PONDER_RPC_URL_4663",
    );
  });

  it("parseRpcUrls is the parser the module uses", async () => {
    const { env } = await load(KEYED);
    expect(env.parseRpcUrls(`${KEYED}, ${OTHER}`)).toEqual([KEYED, OTHER]);
    expect(env.parseRpcUrls(KEYED)).toEqual([KEYED]);
    expect(() => env.parseRpcUrls(",")).toThrow("empty entry at position 1 of 2");
  });
});

describe("houseVaultSourceFor and houseRegistryHealth", () => {
  const F = "0x5BEa4c9887C322d5Ec8C7ae547c25091599774d2";
  const D = "0x00000000000000000000000000000000000000dd";
  const V1 = "0xfb5CcB9CF9249E46D8Af0C4f8fe7Eaa9bD7BfF51";
  const V2 = "0x53eF3ff548Fe3EaA1A1c0a0E010ED0aBB5365201";
  const registry = (vaults: { ticker: string | null; kind: string; address: string }[], house = true) => ({
    contracts: { houseVaultFactory: F },
    ...(house ? { house: {
      factories: [{ kind: "weekly", address: F, deployBlock: 69_517_900 }, { kind: "daily", address: D, deployBlock: 69_700_000 }],
      vaults,
    } } : {}),
  });
  const source = (vaults: Parameters<typeof registry>[0], factory = F, envStartBlock = 70_000_000, house = true) =>
    houseVaultSourceFor({ factory: factory as `0x${string}`, envStartBlock, registry: registry(vaults, house) });
  /** A dev, rehearsal or fork process: V2_PRODUCTION unset, so nothing but an unregistered vault is an alert. */
  const DEV = { production: false, launchMismatch: null };

  it("lists every vault once, checksummed and sorted, from the earliest recorded factory block", () => {
    const s = source([
      { ticker: "NVDA", kind: "weekly", address: V1.toLowerCase() },
      { ticker: "SPCX", kind: "weekly", address: V2 },
      { ticker: null, kind: "weekly", address: V1 },
    ]);
    expect(s).toMatchObject({ mode: "registry", addresses: [V2, V1], startBlock: 69_517_900 });
  });

  it("keeps the env start block when it is the earlier one", () => {
    expect(source([{ ticker: "NVDA", kind: "weekly", address: V1 }], F, 60_000_000).startBlock).toBe(60_000_000);
  });

  it("recognises a daily factory too", () => {
    expect(source([{ ticker: "NVDA", kind: "daily", address: V1 }], D).mode).toBe("registry");
  });

  it.each([
    ["a factory the registry does not name", () => source([{ ticker: "NVDA", kind: "weekly", address: V1 }], "0x00000000000000000000000000000000000000bb"), "is not a registry House factory"],
    ["no vault yet (an empty address array would match every log)", () => source([]), "no House vault yet"],
    ["a registry generated before the house block existed", () => source([], F, 70_000_000, false), "carries no house block"],
  ])("falls back to factory() for %s", (_label, make, reason) => {
    const s = make();
    expect(s.mode).toBe("factory");
    expect(s.mode === "factory" ? s.reason : "").toContain(reason);
    expect(s.startBlock).toBe(70_000_000);
    expect(isUnregisteredHouseVault(s, "0x000000000000000000000000000000000000b0b1")).toBe(false);
  });

  it.each([
    ["a malformed vault", "0x1234", "is not an address"],
    ["the zero vault", "0x0000000000000000000000000000000000000000", "is the zero address"],
  ])("fails closed on %s", (_label, address, message) => {
    expect(() => source([{ ticker: "NVDA", kind: "weekly", address }])).toThrow(message);
  });

  it("health: ok when every indexed vault is listed, 503-worthy and named when one is not", () => {
    const s = source([{ ticker: "NVDA", kind: "weekly", address: V1 }]);
    const listed = { vault: V1.toLowerCase(), factory: F.toLowerCase(), createdBlock: 69_517_950n };
    expect(houseRegistryHealth(s, [listed], DEV)).toMatchObject({ ok: true, alert: null, mode: "registry", reason: null, indexed: 1, unregistered: [] });
    const stray = { vault: "0x000000000000000000000000000000000000b0b1", factory: F.toLowerCase(), createdBlock: 70_100_000n };
    expect(houseRegistryHealth(s, [listed, stray], DEV)).toMatchObject({
      ok: false,
      alert: HOUSE_VAULT_UNREGISTERED,
      registered: [V1],
      indexed: 2,
      unregistered: [{ vault: stray.vault, factory: stray.factory, createdBlock: "70100000" }],
    });
  });

  it("health: the factory() fallback reports its reason and flags nothing", () => {
    const s = source([]);
    const stray = { vault: "0x000000000000000000000000000000000000b0b1", factory: F.toLowerCase(), createdBlock: 1n };
    expect(houseRegistryHealth(s, [stray], DEV)).toMatchObject({ ok: true, alert: null, mode: "factory", registered: [], unregistered: [] });
    expect(houseRegistryHealth(s, [stray], DEV).reason).toContain("no House vault yet");
  });
});

describe("a production process never runs a House source the baked registry does not describe", () => {
  const V8_LAUNCH = "0x5BEa4c9887C322d5Ec8C7ae547c25091599774d2";
  const V9_LAUNCH = "0x000000000000000000000000000000000000F009";
  const VAULT = "0xfb5CcB9CF9249E46D8Af0C4f8fe7Eaa9bD7BfF51";
  const registry = (launch: string | null, vaults: { ticker: string | null; kind: string; address: string }[]) => ({
    contracts: { houseVaultFactory: launch },
    house: { factories: launch === null ? [] : [{ kind: "weekly", address: launch, deployBlock: 69_517_900 }], vaults },
  });
  const listed = [{ ticker: "NVDA", kind: "weekly", address: VAULT }];

  it("launchFactoryMismatch: null for the registry's launch factory in any case, a named sentence otherwise", () => {
    expect(launchFactoryMismatch(V8_LAUNCH.toLowerCase() as `0x${string}`, registry(V8_LAUNCH, listed))).toBeNull();
    expect(launchFactoryMismatch(V9_LAUNCH, registry(V8_LAUNCH, listed))).toBe(
      `V2_HOUSE_VAULT_FACTORY ${V9_LAUNCH} is not the baked registry's v2.contracts.houseVaultFactory (${V8_LAUNCH})`);
    expect(launchFactoryMismatch(V9_LAUNCH, registry(null, []))).toContain("v2.contracts.houseVaultFactory (null)");
  });

  it("assertProductionHouseFactory refuses a production launch factory the registry does not name, by name", () => {
    expect(() => assertProductionHouseFactory({ production: true, factory: V9_LAUNCH, registry: registry(V8_LAUNCH, listed) }))
      .toThrow(`${HOUSE_FACTORY_NOT_REGISTRY}: V2_HOUSE_VAULT_FACTORY ${V9_LAUNCH} is not the baked registry's`);
    // A registry generated before the House block, or before any factory: still a refusal, never a silent fallback.
    expect(() => assertProductionHouseFactory({ production: true, factory: V9_LAUNCH, registry: { contracts: {} } }))
      .toThrow(HOUSE_FACTORY_NOT_REGISTRY);
  });

  it.each([
    ["the registry's own launch factory in production", true, V8_LAUNCH],
    ["no launch factory in production (House off, or daily-only from the registry)", true, undefined],
    ["another deployment's factory outside production (dev, rehearsal, fork)", false, V9_LAUNCH],
  ])("assertProductionHouseFactory passes %s", (_label, production, factory) => {
    expect(() => assertProductionHouseFactory({
      production, factory: factory as `0x${string}` | undefined, registry: registry(V8_LAUNCH, listed),
    })).not.toThrow();
  });

  it("health: production turns the factory() fallback into a 503 alert; outside production it stays ok", () => {
    const noVaultYet = houseVaultSourceFor({ factory: V8_LAUNCH, envStartBlock: 70_000_000, registry: registry(V8_LAUNCH, []) });
    expect(noVaultYet.mode).toBe("factory");
    expect(houseRegistryHealth(noVaultYet, [], { production: false, launchMismatch: null })).toMatchObject({
      ok: true, alert: null, message: null, production: false, mode: "factory" });
    const prod = houseRegistryHealth(noVaultYet, [], { production: true, launchMismatch: null });
    expect(prod).toMatchObject({ ok: false, alert: HOUSE_SOURCE_FACTORY_FALLBACK, production: true, mode: "factory" });
    expect(prod.message).toContain("no House vault yet");
  });

  it("health: production names a launch-factory mismatch first, even over the fallback it causes", () => {
    const v9OnV8 = houseVaultSourceFor({ factory: V9_LAUNCH, envStartBlock: 70_100_000, registry: registry(V8_LAUNCH, listed) });
    expect(v9OnV8.mode).toBe("factory");
    const mismatch = launchFactoryMismatch(V9_LAUNCH, registry(V8_LAUNCH, listed));
    const prod = houseRegistryHealth(v9OnV8, [], { production: true, launchMismatch: mismatch });
    expect(prod).toMatchObject({ ok: false, alert: HOUSE_FACTORY_NOT_REGISTRY, production: true, mode: "factory" });
    expect(prod.message).toContain(`V2_HOUSE_VAULT_FACTORY ${V9_LAUNCH} is not the baked registry's`);
    // The same process without V2_PRODUCTION is the dev footing: 200, mode factory, the reason, no alert.
    expect(houseRegistryHealth(v9OnV8, [], { production: false, launchMismatch: mismatch })).toMatchObject({
      ok: true, alert: null, production: false, mode: "factory" });
  });

  it("health: a production process on its own registry is healthy, and an unregistered vault still alerts", () => {
    const own = houseVaultSourceFor({ factory: V8_LAUNCH, envStartBlock: 70_000_000, registry: registry(V8_LAUNCH, listed) });
    const row = { vault: VAULT.toLowerCase(), factory: V8_LAUNCH.toLowerCase(), createdBlock: 69_517_950n };
    expect(houseRegistryHealth(own, [row], { production: true, launchMismatch: null })).toMatchObject({
      ok: true, alert: null, message: null, production: true, mode: "registry" });
    const stray = { vault: "0x000000000000000000000000000000000000b0b1", factory: V8_LAUNCH.toLowerCase(), createdBlock: 70_100_000n };
    expect(houseRegistryHealth(own, [row, stray], { production: true, launchMismatch: null })).toMatchObject({
      ok: false, alert: HOUSE_VAULT_UNREGISTERED, production: true });
  });
});

describe("the kinded (daily) factories are a source of their own, and a daily-only registry indexes House", () => {
  const REGISTRY_MODULE = "../../lib/v2/marketRegistry.generated";
  const LAUNCH = "0x5BEa4c9887C322d5Ec8C7ae547c25091599774d2";
  const DAILY = "0x000000000000000000000000000000000000dA11";
  const NVDA_DAILY = "0x000000000000000000000000000000000000B0d1";
  const SPCX_DAILY = "0x000000000000000000000000000000000000b0D2";
  const LEGACY_TOPIC = "0xf4c8fe3d081e6833faa5b528b19b14655145aa43759aae5d58a22b9eba726e29";
  const KINDED_TOPIC = "0xeef0325f711a74caa786a3b9c97a9a07cb8a3070605e8a89625fd624d05d500d";

  type House = { factories: { kind: string; address: string; deployBlock: number | null }[]; vaults: { ticker: string | null; kind: string; address: string }[] };
  /** Swap the baked registry's House block (and launch factory) for the next import; the rest stays the real registry. */
  function withRegistry(launch: string | null, house: House) {
    vi.doMock(REGISTRY_MODULE, async (importOriginal) => {
      const real = (await importOriginal()) as { V2_REGISTRY: Record<string, any> };
      return { V2_REGISTRY: { ...real.V2_REGISTRY, contracts: { ...real.V2_REGISTRY.contracts, houseVaultFactory: launch }, house } };
    });
  }
  const dailyOnly: House = {
    factories: [{ kind: "daily", address: DAILY, deployBlock: 70_000_000 }],
    vaults: [{ ticker: "NVDA", kind: "daily", address: NVDA_DAILY }, { ticker: "SPCX", kind: "daily", address: SPCX_DAILY }],
  };

  /** setV2 with the registry's own Clearinghouse, which the kinded source (like the price sources) requires. */
  async function setOwnV2() {
    setV2();
    const { V2_REGISTRY } = await import(REGISTRY_MODULE);
    vi.stubEnv("V2_CLEARINGHOUSE", V2_REGISTRY.contracts.clearinghouse);
  }

  afterEach(() => {
    vi.doUnmock(REGISTRY_MODULE);
    vi.doUnmock("ponder:registry");
  });

  it("daily-only: no V2_HOUSE_VAULT_FACTORY, yet the kinded factory and the registry's daily vaults are sources", async () => {
    withRegistry(null, dailyOnly);
    await setOwnV2();
    const [{ default: config }, { toEventSelector }] = await Promise.all([import("../../ponder.config"), import("viem")]);
    const contracts = config.contracts as unknown as Record<string, { abi: readonly any[]; address: unknown; startBlock: number } | undefined>;
    expect(contracts.HouseVaultFactory, "the launch source is absent: there is no launch factory").toBeUndefined();
    const kinded = contracts.HouseVaultFactoryKinded;
    expect(kinded).toBeDefined();
    expect(kinded!.address).toEqual([DAILY]);
    expect(kinded!.startBlock).toBe(70_000_000);
    const created = kinded!.abi.find((item) => item.type === "event" && item.name === "VaultCreated");
    expect(created.inputs).toHaveLength(5);
    expect(toEventSelector(created)).toBe(KINDED_TOPIC);
    expect(kinded!.abi.filter((item) => item.type === "event").map((item) => item.name).sort()).toEqual(["AuthorityUpdated", "VaultCreated"]);
    // The vaults: the registry list (sorted by lowercase address), from the daily factory's block.
    expect(contracts.HouseVault?.address).toEqual([getAddress(NVDA_DAILY), getAddress(SPCX_DAILY)]);
    expect(contracts.HouseVault?.startBlock).toBe(70_000_000);
  });

  it("daily-only: the handler gates in lib/registry.ts are live for the vaults and the kinded factory, inert for the launch factory", async () => {
    withRegistry(null, dailyOnly);
    const live = { on: () => undefined, live: true };
    vi.doMock("ponder:registry", () => ({ ponder: live }));
    await setOwnV2();
    const gates = await import("../../lib/registry");
    expect(gates.v2HouseVaultEventsPonder).toBe(live);
    expect(gates.v2HouseVaultKindedFactoryPonder).toBe(live);
    // The launch-factory gate must stay inert: a `HouseVaultFactory:*` handler with no such source fails Ponder's build.
    expect(gates.v2HouseVaultPonder).not.toBe(live);
    // Positive control: the same module with the baked registry (no daily factory) and no launch factory is all inert.
    vi.doUnmock(REGISTRY_MODULE);
    vi.resetModules();
    const none = await import("../../lib/registry");
    expect(none.v2HouseVaultEventsPonder).not.toBe(live);
    expect(none.v2HouseVaultKindedFactoryPonder).not.toBe(live);
  });

  it("daily-only with no vault recorded yet: factory() discovery on the KINDED event, and it says so", async () => {
    withRegistry(null, { factories: dailyOnly.factories, vaults: [] });
    await setOwnV2();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const [{ default: config }, { toEventSelector }] = await Promise.all([import("../../ponder.config"), import("viem")]);
      const discovery = config.contracts.HouseVault?.address as unknown as { address: unknown; event: any; parameter: string };
      expect(discovery.address).toEqual([DAILY]);
      expect(discovery.parameter).toBe("vault");
      expect(toEventSelector(discovery.event)).toBe(KINDED_TOPIC);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("HouseVault source: factory() discovery");
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The window before the vault write-back (the registry names the launch factory, no vault yet): the
   * factory() fallback watches the event the launch factory EMITS, read from the registry's kind for it. v8 (weekly,
   * legacy) keeps the legacy topic; v9 (daily) gets the 5-field one, where it used to get the legacy
   * topic and discover zero vaults.
   */
  it.each([
    ["v8: the weekly launch factory keeps the legacy topic", "weekly", LEGACY_TOPIC],
    ["v9: the daily launch factory is discovered on the 5-field topic", "daily", KINDED_TOPIC],
  ] as const)("launch factory with no vault recorded yet, %s", async (_label, kind, topic) => {
    const V9 = "0x000000000000000000000000000000000000F009";
    const launch = kind === "weekly" ? LAUNCH : V9;
    withRegistry(launch, { factories: [{ kind, address: launch, deployBlock: 70_100_000 }], vaults: [] });
    await setOwnV2();
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", launch.toLowerCase()); // lib/env checksums it
    vi.stubEnv("V2_HOUSE_START_BLOCK", "70100000");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const [{ default: config }, { toEventSelector }] = await Promise.all([import("../../ponder.config"), import("viem")]);
      const discovery = config.contracts.HouseVault?.address as unknown as { address: unknown; event: any; parameter: string };
      expect(discovery.address).toBe(getAddress(launch));
      expect(discovery.parameter).toBe("vault");
      expect(toEventSelector(discovery.event)).toBe(topic);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("no House vault yet");
    } finally {
      warn.mockRestore();
    }
  });

  it("launch + daily: the launch source is unchanged (legacy topic, env block) and the kinded source sits beside it", async () => {
    withRegistry(LAUNCH, {
      factories: [{ kind: "weekly", address: LAUNCH, deployBlock: 69_517_900 }, ...dailyOnly.factories],
      vaults: [{ ticker: "NVDA", kind: "weekly", address: "0xfb5CcB9CF9249E46D8Af0C4f8fe7Eaa9bD7BfF51" }, ...dailyOnly.vaults],
    });
    await setOwnV2();
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", LAUNCH);
    vi.stubEnv("V2_HOUSE_START_BLOCK", "69600000");
    const [{ default: config }, { toEventSelector }] = await Promise.all([import("../../ponder.config"), import("viem")]);
    const contracts = config.contracts as unknown as Record<string, { abi: readonly any[]; address: unknown; startBlock: number } | undefined>;
    expect(contracts.HouseVaultFactory?.address).toBe(LAUNCH);
    expect(contracts.HouseVaultFactory?.startBlock).toBe(69_600_000);
    expect(toEventSelector(contracts.HouseVaultFactory!.abi.find((item) => item.name === "VaultCreated"))).toBe(LEGACY_TOPIC);
    // The configured launch factory is on the kinded (5-field) source too, at its own env block.
    expect(contracts.HouseVaultFactoryKinded?.address).toEqual([DAILY, LAUNCH]);
    expect(contracts.HouseVaultFactoryKinded?.startBlock).toBe(69_600_000);
    // One vault list covering both kinds, from the earliest House factory block.
    expect(contracts.HouseVault?.address).toEqual([getAddress(NVDA_DAILY), getAddress(SPCX_DAILY), "0xfb5CcB9CF9249E46D8Af0C4f8fe7Eaa9bD7BfF51"]);
    expect(contracts.HouseVault?.startBlock).toBe(69_517_900);
  });

  it("the daily factory is NOT sourced for another Clearinghouse (dev, rehearsal, a fork)", async () => {
    withRegistry(null, dailyOnly);
    setV2(); // 0x…11 is not the registry's Clearinghouse
    const { default: config } = await import("../../ponder.config");
    const names = Object.keys(config.contracts);
    expect(names, "positive control: the core sources did register").toContain("Clearinghouse");
    expect(names).not.toContain("HouseVaultFactoryKinded");
    expect(names).not.toContain("HouseVault");
  });

  it("the baked registry with its launch factory configured: both factory sources, the launch factory on each topic", async () => {
    await setOwnV2();
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", LAUNCH);
    vi.stubEnv("V2_HOUSE_START_BLOCK", "69600000");
    const [{ default: config }, { V2_REGISTRY }, { toEventSelector }] = await Promise.all([
      import("../../ponder.config"), import(REGISTRY_MODULE), import("viem"),
    ]);
    const contracts = config.contracts as unknown as Record<string, { abi: readonly any[]; address: unknown } | undefined>;
    // A change replaced "exactly the launch pair": the launch factory is ALSO watched for the 5-field topic, because the
    // v9 launch factory emits only that one. Follows a write-back: every recorded daily factory is sourced beside it.
    const daily = (V2_REGISTRY.house.factories as { kind: string; address: string }[])
      .filter((f) => f.kind === "daily" && f.address.toLowerCase() !== LAUNCH.toLowerCase()).map((f) => getAddress(f.address));
    expect(Object.keys(config.contracts)).toEqual(expect.arrayContaining(["HouseVaultFactory", "HouseVaultFactoryKinded", "HouseVault"]));
    expect(contracts.HouseVaultFactory?.address).toBe(LAUNCH);
    expect(toEventSelector(contracts.HouseVaultFactory!.abi.find((item) => item.name === "VaultCreated"))).toBe(LEGACY_TOPIC);
    expect([...(contracts.HouseVaultFactoryKinded!.address as string[])].sort()).toEqual([...daily, LAUNCH].sort());
    expect(toEventSelector(contracts.HouseVaultFactoryKinded!.abi.find((item) => item.name === "VaultCreated"))).toBe(KINDED_TOPIC);
  });

  it("v9: a kinded launch factory is indexed through the 5-field source, and every House gate is live", async () => {
    // The v9 registry shape: the redeploy's factory in v2.contracts.houseVaultFactory, its vaults daily.
    const V9 = "0x000000000000000000000000000000000000F009";
    withRegistry(V9, {
      factories: [{ kind: "daily", address: V9, deployBlock: 70_100_000 }],
      vaults: [{ ticker: "NVDA", kind: "daily", address: NVDA_DAILY }, { ticker: "SPCX", kind: "daily", address: SPCX_DAILY }],
    });
    const live = { on: () => undefined, live: true };
    vi.doMock("ponder:registry", () => ({ ponder: live }));
    await setOwnV2();
    vi.stubEnv("V2_HOUSE_VAULT_FACTORY", V9.toLowerCase());
    vi.stubEnv("V2_HOUSE_START_BLOCK", "70100000");
    const [{ default: config }, gates, { toEventSelector }] = await Promise.all([
      import("../../ponder.config"), import("../../lib/registry"), import("viem"),
    ]);
    const contracts = config.contracts as unknown as Record<string, { abi: readonly any[]; address: unknown; startBlock: number } | undefined>;
    const kinded = contracts.HouseVaultFactoryKinded;
    expect(kinded, "without T-OP-435 the only factory source watched the legacy topic this factory never emits").toBeDefined();
    expect(kinded!.address).toEqual([getAddress(V9)]);
    expect(kinded!.startBlock).toBe(70_100_000);
    expect(toEventSelector(kinded!.abi.find((item) => item.type === "event" && item.name === "VaultCreated"))).toBe(KINDED_TOPIC);
    expect(gates.v2HouseVaultKindedFactoryPonder).toBe(live);
    expect(gates.v2HouseVaultEventsPonder).toBe(live);
    expect(gates.v2HouseVaultPonder).toBe(live);
  });

  describe("the v9 env on an image whose baked registry predates the regen", () => {
    // The measured case (on a v9 fork): V2_HOUSE_VAULT_FACTORY is a factory compiled after kinding, which
    // emits only the 5-field VaultCreated, and the baked registry is v8-era: its launch factory is LAUNCH and its
    // Clearinghouse is not env's (setV2's 0x…11), so KINDED_HOUSE is undefined and the House source falls back.
    const V9 = "0x000000000000000000000000000000000000F009";
    const v8Era = () => withRegistry(LAUNCH, {
      factories: [{ kind: "weekly", address: LAUNCH, deployBlock: 69_517_900 }],
      vaults: [{ ticker: "NVDA", kind: "weekly", address: "0xfb5CcB9CF9249E46D8Af0C4f8fe7Eaa9bD7BfF51" }],
    });
    const v9Env = () => {
      setV2();
      vi.stubEnv("V2_HOUSE_VAULT_FACTORY", V9.toLowerCase()); // V9's mixed case is not a checksum; lib/env checksums it
      vi.stubEnv("V2_HOUSE_START_BLOCK", "70100000");
    };

    it("V2_PRODUCTION=1: boot refuses by name instead of indexing zero House vaults", async () => {
      v8Era();
      v9Env();
      vi.stubEnv("V2_PRODUCTION", "1");
      await expect(import("../../ponder.config")).rejects.toThrow(
        new RegExp(`${HOUSE_FACTORY_NOT_REGISTRY}: V2_HOUSE_VAULT_FACTORY ${getAddress(V9)} is not the baked registry's ` +
          `v2\\.contracts\\.houseVaultFactory \\(${LAUNCH}\\)`));
    });

    // A change changed this case on purpose. It pinned the fallback on LEGACY_TOPIC, the topic its own title said this
    // factory never emits (zero House vaults discovered). The registry does not name V9, and the only legacy
    // factory is the one it records as its weekly launch factory (LAUNCH), so V9 is discovered on the 5-field topic.
    // And V9's OWN 5-field VaultCreated is sourced too (HouseVaultFactoryKinded), on purpose. This case used
    // to expect no kinded source because the registry's Clearinghouse is not env's; a change then sourced an env
    // factory the registry does not name for ANY Clearinghouse, because a dev/rehearsal/fork deployment always has a
    // Clearinghouse of its own, and without the source its vaults were discovered but got no v2HouseVault row, so no
    // queue ever closed (houseVaultKind.ts kindedHouseFactorySourcesFor). Moving that branch behind the Clearinghouse
    // check turns 4 of the tests red, so the expectation here changes, not the code.
    it("without V2_PRODUCTION it boots on the dev footing: factory() on the 5-field topic, and V9's own VaultCreated is sourced", async () => {
      v8Era();
      v9Env();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const [{ default: config }, { toEventSelector }] = await Promise.all([import("../../ponder.config"), import("viem")]);
        const contracts = config.contracts as unknown as Record<string, { address: unknown; startBlock?: unknown; abi?: any } | undefined>;
        // Only V9: the registry's own factories (LAUNCH) stay out, because the registry's Clearinghouse is not env's.
        expect(contracts.HouseVaultFactoryKinded?.address, "the unnamed env factory alone is the kinded source").toEqual([getAddress(V9)]);
        expect(contracts.HouseVaultFactoryKinded?.startBlock).toBe(70_100_000);
        expect(toEventSelector(contracts.HouseVaultFactoryKinded!.abi.find((item: { name?: string }) => item.name === "VaultCreated"))).toBe(KINDED_TOPIC);
        const discovery = contracts.HouseVault?.address as { address: unknown; event: any };
        expect(discovery.address).toBe(getAddress(V9));
        expect(toEventSelector(discovery.event)).toBe(KINDED_TOPIC);
        expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("is not a registry House factory");
      } finally {
        warn.mockRestore();
      }
    });

    it("positive control: V2_PRODUCTION=1 on its own registry boots in registry mode", async () => {
      v8Era();
      await setOwnV2();
      vi.stubEnv("V2_HOUSE_VAULT_FACTORY", LAUNCH);
      vi.stubEnv("V2_HOUSE_START_BLOCK", "69600000");
      vi.stubEnv("V2_PRODUCTION", "1");
      const { default: config } = await import("../../ponder.config");
      expect(config.contracts.HouseVault?.address).toEqual(["0xfb5CcB9CF9249E46D8Af0C4f8fe7Eaa9bD7BfF51"]);
    });

    it.each([["true"], ["yes"], ["2"]])("V2_PRODUCTION=%s is refused at boot, never read as either", async (value) => {
      setV2();
      vi.stubEnv("V2_PRODUCTION", value);
      await expect(import("../../lib/env")).rejects.toThrow(`V2_PRODUCTION="${value}" must be 1`);
    });
  });
});

describe("a production process refuses a V2_CLEARINGHOUSE its baked registry does not name", () => {
  // The measured case (on a v9 fork): env names the v9 Clearinghouse and the image's baked registry is
  // v8-era, so the House factory source and every price source drop themselves (houseVaultKind.ts, priceSourceRegistry
  // .ts) and their events are never fetched. setV2's 0x…11 plays the v9 Clearinghouse against the checked-in registry.
  const REGISTRY_MODULE = "../../lib/v2/marketRegistry.generated";

  async function bakedClearinghouse(): Promise<string> {
    const { V2_REGISTRY } = await import(REGISTRY_MODULE);
    return V2_REGISTRY.contracts.clearinghouse as string;
  }

  it("V2_PRODUCTION=1: boot refuses with one named line naming the House factory source and the price sources", async () => {
    setV2();
    vi.stubEnv("V2_PRODUCTION", "1");
    const [{ REGISTRY_CLEARINGHOUSE_MISMATCH }, own] = await Promise.all([
      import("./registryClearinghouse"), bakedClearinghouse()]);
    const refused = await import("../../ponder.config").then(() => null, (error: Error) => error.message);
    expect(refused, "production booted on another deployment's Clearinghouse").not.toBeNull();
    expect(refused).not.toContain("\n");
    expect(refused).toContain(`${REGISTRY_CLEARINGHOUSE_MISMATCH}: V2_CLEARINGHOUSE ${ADDRESSES.V2_CLEARINGHOUSE} is not the ` +
      `baked registry's v2.contracts.clearinghouse (${own})`);
    expect(refused).toContain("no House factory source (");
    expect(refused).toContain("no price source (ChainlinkFeedSource ");
    expect(refused).toContain("Refusing to start");
  });

  it("without V2_PRODUCTION it boots as before (no House factory source, no price source) and warns by name", async () => {
    setV2();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { default: config } = await import("../../ponder.config");
      const contracts = config.contracts as unknown as Record<string, unknown>;
      for (const name of ["HouseVaultFactoryKinded", "ChainlinkFeedSource", "UniV3TwapSource", "DataStreamsSource"]) {
        expect(contracts[name], name).toBeUndefined();
      }
      const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("REGISTRY_CLEARINGHOUSE_MISMATCH"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("WARNING REGISTRY_CLEARINGHOUSE_MISMATCH");
      expect(lines[0]).toContain("no price source (ChainlinkFeedSource ");
    } finally {
      warn.mockRestore();
    }
  });

  it("positive control: V2_PRODUCTION=1 on its own registry's Clearinghouse boots with the price sources and no warning", async () => {
    setV2();
    vi.stubEnv("V2_CLEARINGHOUSE", await bakedClearinghouse());
    vi.stubEnv("V2_PRODUCTION", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { default: config } = await import("../../ponder.config");
      const contracts = config.contracts as unknown as Record<string, { address: unknown } | undefined>;
      expect(contracts.ChainlinkFeedSource?.address).toBeDefined();
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("REGISTRY_CLEARINGHOUSE_MISMATCH");
    } finally {
      warn.mockRestore();
    }
  });
});
