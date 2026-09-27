import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import configFixture from "../../../ops/fixtures/api/v2/config.json";

import { USDG } from "../contracts";
import { configResponseSchema } from "./api-schema";
import type { ConfigResponse } from "./api-types";
import { V2_DEPLOYMENT, requireV2Address, v2ConfigWarnings } from "./config";
import { earnActionAvailability } from "./earnAccess";

describe("v2 deployment guard", () => {
  it("uses only compiled registry addresses for writes", () => {
    if (V2_DEPLOYMENT.contracts.orderBook) {
      expect(requireV2Address("orderBook")).toBe(V2_DEPLOYMENT.contracts.orderBook);
    } else {
      expect(() => requireV2Address("orderBook")).toThrow(/not deployed/);
    }
  });

  it("includes the access manager in the compiled deployment guard", () => {
    const config = configResponseSchema.parse(configFixture);
    const aligned = {
      ...config,
      contracts: { ...config.contracts, accessManager: V2_DEPLOYMENT.contracts.accessManager },
    };
    expect(v2ConfigWarnings(aligned)).not.toContain("accessManager address differs from the generated registry.");

    const mismatched = V2_DEPLOYMENT.contracts.accessManager === null
      ? config.contracts.clearinghouse
      : null;
    expect(v2ConfigWarnings({
      ...aligned,
      contracts: { ...aligned.contracts, accessManager: mismatched },
    })).toContain("accessManager address differs from the generated registry.");
  });

  it("flags fixture addresses that disagree with the compiled registry", () => {
    const config = configResponseSchema.parse(configFixture);
    expect(v2ConfigWarnings({ ...config, chainId: config.chainId + 1 })).toContain("Indexer chain differs from this app.");
    expect(v2ConfigWarnings({ ...config, constants: { ...config.constants, priceTick: 999 } }))
      .toContain("priceTick constant differs from the app's option maths.");
  });

  it("requires the v8 interface on both the indexer and compiled registry", () => {
    const config = configResponseSchema.parse(configFixture);
    expect(v2ConfigWarnings({ ...config, interfaceVersion: 8 }))
      .not.toContain("This build requires interface version 8.");
    expect(v2ConfigWarnings({ ...config, interfaceVersion: 7 }))
      .toContain("This build requires interface version 8.");
  });

  it("allows live fees to change without disabling writes", () => {
    const config = configResponseSchema.parse(configFixture);
    const changed = { ...config, fees: {
      ...config.fees,
      premiumFeeBps: config.fees.premiumFeeBps + 1,
      takerFeeFlat: { ...config.fees.takerFeeFlat, raw: String(BigInt(config.fees.takerFeeFlat.raw) + 1n) },
    } };
    expect(v2ConfigWarnings(changed)).toEqual(v2ConfigWarnings(config));
  });

  it("requires the explicit pending fee field and rejects unknown schedule fields", () => {
    const config = configResponseSchema.parse(configFixture);
    expect(config.pendingFees).toBeNull();
    const { pendingFees: _pending, ...missing } = config;
    expect(configResponseSchema.safeParse(missing).success).toBe(false);
    expect(configResponseSchema.safeParse({ ...config, pendingFees: { ...config.fees,
      effectiveAt: 1_800_000_000, unknown: true } }).success).toBe(false);
  });

  it("rejects a config that points wallet approval at a different USDG token", () => {
    const config = configResponseSchema.parse(configFixture);
    const wrong = { ...config, usdg: { ...config.usdg, address: config.contracts.clearinghouse! } };
    expect(v2ConfigWarnings(wrong)).toContain("USDG address differs from this app.");
  });
});

/**
 * EVERY overridable key is registry-first. `earnVault` and the lender
 * distributor are EXTERNAL `v2.contracts` keys the generated `V2_CONTRACTS` copies through; before this they
 * were read from the `NEXT_PUBLIC_*` override only, so the deployed EarnVault read as "not deployed" on /lend.
 * Registry values are injected by mocking the GENERATED module, the thing a write-back changes.
 */
describe("overridable keys resolve registry-first, override only where the registry is silent", () => {
  const REGISTRY_LOWER = "0x2222222222222222222222222222222222222222";
  const OVERRIDE_LOWER = "0x70556baa315dd8d467ea452abcd7deebea073ff9";
  const OVERRIDE_CHECKSUMMED = "0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9";

  afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock("../markets.generated"); vi.resetModules(); });

  async function configWith(registry: Record<string, string | null>, env: Record<string, string>) {
    vi.resetModules();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.doMock("../markets.generated", async (importOriginal) => {
      const original = await importOriginal<typeof import("../markets.generated")>();
      return { ...original, V2_CONTRACTS: { ...original.V2_CONTRACTS, ...registry } };
    });
    return import("./config");
  }

  const CASES = [
    { key: "earnVault", registryName: "earnVault", env: "NEXT_PUBLIC_V2_EARN_VAULT" },
    { key: "lenderRewardsDistributor", registryName: "rewardsDistributorLender", env: "NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR" },
    { key: "stockZap", registryName: "stockZap", env: "NEXT_PUBLIC_V2_STOCK_ZAP" },
  ] as const;

  for (const { key, registryName, env } of CASES) {
    it(`${key}: a registry value (v2.contracts.${registryName}) wins over a set override and is not reported as one`, async () => {
      const config = await configWith({ [registryName]: REGISTRY_LOWER }, { [env]: OVERRIDE_LOWER });
      const resolved = config.resolveV2Address(key);
      expect(resolved.source).toBe("registry");
      expect(resolved.address?.toLowerCase()).toBe(REGISTRY_LOWER);
      expect(config.v2AddressOverrides()).not.toContain(key);
      expect(config.v2AddressProvenanceNotices().join(" ")).not.toContain(env);
    });

    it(`${key}: a silent registry falls back to the override (the control for the case above)`, async () => {
      const config = await configWith({ [registryName]: null }, { [env]: OVERRIDE_LOWER });
      const resolved = config.resolveV2Address(key);
      expect(resolved.source).toBe("override");
      expect(resolved.address).toBe(OVERRIDE_CHECKSUMMED);
      expect(config.v2AddressOverrides()).toContain(key);
    });

    it(`${key}: silent registry and no override is unconfigured`, async () => {
      const config = await configWith({ [registryName]: null }, { [env]: "" });
      expect(config.resolveV2Address(key)).toEqual({ address: null, source: null });
      expect(() => config.requireV2Address(key)).toThrow(/not deployed/);
    });

    it(`${key}: a malformed registry value is not an address, and the override still applies`, async () => {
      const config = await configWith({ [registryName]: "0x1234" }, { [env]: OVERRIDE_LOWER });
      expect(config.resolveV2Address(key)).toEqual({ address: OVERRIDE_CHECKSUMMED, source: "override" });
    });
  }

  /**
   * The registry still wins (the cases above), but an override that names something else is no
   * longer dropped silently. It is reported with both values, and it is NOT a config warning, because
   * {v2ConfigWarnings} pauses deposits and trading and the registry address in use is already cross-checked.
   */
  for (const { key, registryName, env } of CASES) {
    it(`${key}: an override that disagrees with a filled registry is reported, and the registry value is kept`, async () => {
      const config = await configWith({ [registryName]: REGISTRY_LOWER }, { [env]: OVERRIDE_LOWER });
      expect(config.resolveV2Address(key)).toEqual({ address: REGISTRY_LOWER, source: "registry" });
      expect(config.v2AddressOverrideConflicts()).toEqual([{ key, env, registry: REGISTRY_LOWER, override: OVERRIDE_LOWER }]);
      const notice = config.v2AddressOverrideConflictNotices().join(" ");
      expect(notice).toContain(env);
      expect(notice).toContain(OVERRIDE_CHECKSUMMED);
      expect(notice).toContain(REGISTRY_LOWER);
      expect(notice).toContain("uses the registry address");
    });

    it(`${key}: an override equal to the registry value, in any case, is not a conflict`, async () => {
      const config = await configWith({ [registryName]: OVERRIDE_LOWER }, { [env]: OVERRIDE_CHECKSUMMED });
      expect(config.resolveV2Address(key).source).toBe("registry");
      expect(config.v2AddressOverrideConflicts()).toEqual([]);
    });

    it(`${key}: a malformed override beside a filled registry is reported as not an address`, async () => {
      const config = await configWith({ [registryName]: REGISTRY_LOWER }, { [env]: "0x1234" });
      expect(config.v2AddressOverrideConflicts()).toEqual([{ key, env, registry: REGISTRY_LOWER, override: "0x1234" }]);
      expect(config.v2AddressOverrideConflictNotices().join(" ")).toContain("not an address");
    });

    it(`${key}: no conflict when the override is unset or the registry is silent (that is provenance)`, async () => {
      expect((await configWith({ [registryName]: REGISTRY_LOWER }, { [env]: "" })).v2AddressOverrideConflicts()).toEqual([]);
      const silent = await configWith({ [registryName]: null }, { [env]: OVERRIDE_LOWER });
      expect(silent.v2AddressOverrideConflicts()).toEqual([]);
      expect(silent.v2AddressOverrides()).toContain(key);
    });
  }

  it("a reported conflict never becomes a config warning, so it cannot pause writes", async () => {
    const fixture = configResponseSchema.parse(configFixture);
    const clean = await configWith({ earnVault: REGISTRY_LOWER }, { NEXT_PUBLIC_V2_EARN_VAULT: "" });
    const baseline = clean.v2ConfigWarnings(fixture);
    const conflicted = await configWith({ earnVault: REGISTRY_LOWER }, { NEXT_PUBLIC_V2_EARN_VAULT: OVERRIDE_LOWER });
    expect(conflicted.v2AddressOverrideConflicts()).toHaveLength(1);
    expect(conflicted.v2ConfigWarnings(fixture)).toEqual(baseline);
  });

  it("the lender distributor is read from v2.contracts.rewardsDistributorLender, never a same-named key", async () => {
    // A mapping that read `lenderRewardsDistributor` from the registry would find nothing and fall through.
    const config = await configWith({ lenderRewardsDistributor: REGISTRY_LOWER, rewardsDistributorLender: null }, { NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR: "" });
    expect(config.resolveV2Address("lenderRewardsDistributor").address).toBeNull();
  });

  it("the real generated registry's deployed earnVault is what /lend resolves", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", "");
    const { V2_CONTRACTS } = await import("../markets.generated");
    const config = await import("./config");
    const registry = (V2_CONTRACTS as Record<string, unknown>).earnVault;
    expect(typeof registry, "control: the generated registry carries earnVault").toBe("string");
    expect(config.resolveV2Address("earnVault")).toEqual({ address: registry, source: "registry" });
  });
});

/**
 * THE WEB IS SAFE IN EVERY DEPLOY ORDER. tier1.json now carries `v2.contracts.stockZap`, and the indexer's
 * /v2/config does not send it (indexer/src/api/v2/markets.ts). The web and the indexer deploy separately, so each of
 * the four combinations below is a state production can be in. {v2ConfigWarnings} is the channel that pauses Buy,
 * Bid, Earn asks, Lend deposits and Portfolio writes (TradeTicket, EarnMarket via earnActionAvailability, LendVault,
 * Portfolio), so it must stay EMPTY in all four; a StockZap disagreement may disable only the Zap buttons
 * ({v2StockZapMismatch}). The remote is built to agree with the (mocked) registry on every other field, so an empty
 * array is a real assertion, not a baseline comparison.
 */
describe("stockZap in the registry never pauses trading, in any deploy order", () => {
  // Read from ops/markets/tier1.json (what the generated registry is built from), not typed: the v8 copy
  // went stale at the v9 mainnet regen.
  const ZAP_REGISTRY = (JSON.parse(readFileSync(new URL("../../../ops/markets/tier1.json", import.meta.url), "utf8")) as {
    v2: { contracts: { stockZap: string } };
  }).v2.contracts.stockZap;
  const ZAP_OTHER = "0x3333333333333333333333333333333333333333";

  afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock("../markets.generated"); vi.resetModules(); });

  async function configWithZap(stockZap: string | null) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_STOCK_ZAP", "");
    vi.doMock("../markets.generated", async (importOriginal) => {
      const original = await importOriginal<typeof import("../markets.generated")>();
      return { ...original, V2_CONTRACTS: { ...original.V2_CONTRACTS, stockZap } };
    });
    return import("./config");
  }

  /** What today's indexer sends, agreeing with `config`'s registry on everything it checks; no stockZap key. */
  function remoteAgreeingWith(config: typeof import("./config"), stockZap?: string | null): ConfigResponse {
    const fixture = configResponseSchema.parse(configFixture);
    const d = config.V2_DEPLOYMENT;
    const { stockZap: _local, ...core } = d.contracts;
    const ladder = (d.defaults?.ladder ?? {}) as Partial<Record<"daily" | "weekly", Record<string, unknown>>>;
    return {
      ...fixture,
      chainId: d.chainId,
      interfaceVersion: 8,
      usdg: { ...fixture.usdg, address: USDG },
      constants: { ...fixture.constants, unit: d.constants.unit, unitsPerShare: d.constants.unitsPerShare, priceTick: d.constants.priceTick },
      contracts: { ...core, sources: { ...d.sources }, ...(stockZap === undefined ? {} : { stockZap }) },
      ladder: {
        weekly: { ...fixture.ladder.weekly, ...ladder.weekly } as ConfigResponse["ladder"]["weekly"],
        daily: { ...fixture.ladder.daily, ...ladder.daily } as ConfigResponse["ladder"]["daily"],
      },
    } as ConfigResponse;
  }

  /** The Earn page's own gate, fed exactly as EarnMarket.tsx feeds it: indexer health = no config warnings. */
  function earnWritesReady(warnings: string[]): boolean {
    return earnActionAvailability({
      walletConnected: true, assetConfigured: true, clearinghouseConfigured: true, orderBookConfigured: true,
      calendarConfigured: true, autoRollerConfigured: true, marketLive: true, marketMatchesRegistry: true,
      indexerConfigHealthy: warnings.length === 0,
    }).newWritesReady;
  }

  it("(a) registry has stockZap, the indexer omits it: no warning, trading stays ready, Zap is enabled", async () => {
    const config = await configWithZap(ZAP_REGISTRY);
    expect(config.resolveV2Address("stockZap"), "control: the registry value is the one Zap uses").toEqual({ address: ZAP_REGISTRY, source: "registry" });
    const remote = remoteAgreeingWith(config);
    expect("stockZap" in remote.contracts, "control: this is today's indexer, which does not send the key").toBe(false);
    expect(config.v2ConfigWarnings(remote)).toEqual([]);
    expect(earnWritesReady(config.v2ConfigWarnings(remote))).toBe(true);
    expect(config.v2StockZapMismatch(remote)).toBeNull();
  });

  it("(b) the indexer sends the same address (any case): no warning and Zap stays enabled", async () => {
    const config = await configWithZap(ZAP_REGISTRY);
    for (const sent of [ZAP_REGISTRY, ZAP_REGISTRY.toLowerCase()]) {
      const remote = remoteAgreeingWith(config, sent);
      expect(config.v2ConfigWarnings(remote), sent).toEqual([]);
      expect(config.v2StockZapMismatch(remote), sent).toBeNull();
    }
  });

  it("(c) the indexer sends a different address: only Zap is disabled, with a reason; trading warnings unchanged", async () => {
    const config = await configWithZap(ZAP_REGISTRY);
    const remote = remoteAgreeingWith(config, ZAP_OTHER);
    expect(config.v2ConfigWarnings(remote)).toEqual([]);
    expect(earnWritesReady(config.v2ConfigWarnings(remote))).toBe(true);
    const reason = config.v2StockZapMismatch(remote);
    expect(reason).toMatch(/^Zap is paused/);
    expect(reason).toContain(ZAP_OTHER);
    expect(reason).toContain(ZAP_REGISTRY);
  });

  it("(d) the registry is null and the indexer sends one: trading is unaffected, Zap stays off with a reason", async () => {
    const config = await configWithZap(null);
    expect(config.resolveV2Address("stockZap")).toEqual({ address: null, source: null });
    const remote = remoteAgreeingWith(config, ZAP_OTHER);
    expect(config.v2ConfigWarnings(remote)).toEqual([]);
    expect(earnWritesReady(config.v2ConfigWarnings(remote))).toBe(true);
    expect(config.v2StockZapMismatch(remote)).toMatch(/no StockZap address/);
  });

  it("stockZap stays an address key, and the other overridable keys keep their BLOCKING indexer cross-check", async () => {
    const config = await configWithZap(ZAP_REGISTRY);
    expect(config.V2_ADDRESS_KEYS as readonly string[]).toContain("stockZap");
    // A core key that disagrees still pauses: the loop skipped one key, not the comparison.
    const remote = remoteAgreeingWith(config);
    expect(config.v2ConfigWarnings({ ...remote, contracts: { ...remote.contracts, orderBook: ZAP_OTHER } }))
      .toContain("orderBook address differs from the generated registry.");
    // earnVault and the lender distributor, served from an override the indexer contradicts, still block.
    for (const [key, env] of [["earnVault", "NEXT_PUBLIC_V2_EARN_VAULT"], ["lenderRewardsDistributor", "NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR"]] as const) {
      vi.resetModules();
      vi.stubEnv(env, "0x70556baa315dd8d467ea452abcd7deebea073ff9");
      vi.doMock("../markets.generated", async (importOriginal) => {
        const original = await importOriginal<typeof import("../markets.generated")>();
        return { ...original, V2_CONTRACTS: { ...original.V2_CONTRACTS, earnVault: null, rewardsDistributorLender: null } };
      });
      const overridden = await import("./config");
      expect(overridden.resolveV2Address(key).source, key).toBe("override");
      const r = remoteAgreeingWith(overridden);
      expect(overridden.v2ConfigWarnings({ ...r, contracts: { ...r.contracts, [key]: ZAP_OTHER } } as ConfigResponse), key)
        .toContain(`${key} override does not match the address the indexer publishes.`);
      vi.unstubAllEnvs();
    }
  });

  it("the real generated registry's StockZap is what the Earn page resolves (the registry, not an override)", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_STOCK_ZAP", "");
    const { V2_CONTRACTS } = await import("../markets.generated");
    const config = await import("./config");
    const registry = (V2_CONTRACTS as Record<string, unknown>).stockZap;
    expect(registry, "control: tier1.json records StockZap (T-OP-332)").toBe(ZAP_REGISTRY);
    expect(config.resolveV2Address("stockZap")).toEqual({ address: ZAP_REGISTRY, source: "registry" });
  });
});
