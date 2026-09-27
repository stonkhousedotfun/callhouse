import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type PayoutRoute = null
  | { venue: "v3"; fee: number }
  | { venue: "v4"; fee: number; tickSpacing: number; poolId: string };

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const base = () => ({ shared: { chainId: 4663, safes: {
  admin: "0x6666666666666666666666666666666666666666" as string | null,
  treasury: "0x7777777777777777777777777777777777777777" as string | null,
} }, v2: {
  interfaceVersion: 8, deployBlock: 123,
  contracts: { accessManager: "0x3333333333333333333333333333333333333333" },
  flywheel: {
    feeSplitter: "0x4444444444444444444444444444444444444444",
    buybackExecutor: "0x5555555555555555555555555555555555555555",
    deployBlock: 120,
  },
  fees: { premiumFeeBps: 500, mintFeePpm: 0, allowRent: false },
  defaults: {
    ladder: {}, expiriesAhead: { daily: 3, weekly: 2 }, uncorroboratedDelayS: 21_600,
  },
},
// The launch set; required, validated against markets[].
launchSet: { note: "test launch set" as string | null | undefined, markets: ["NVDA"] as unknown[] } as
  { note: string | null | undefined; markets: unknown[] } | null | undefined,
markets: [{ ticker: "NVDA", name: "NVIDIA", asset: "0x1111111111111111111111111111111111111111",
  verification: { uiMultiplier: "1000775159164630595" as string | null | undefined },
  v2: { status: "live", strikeTick: 1_000_000, puts: true,
    univ3Pool: "0x2222222222222222222222222222222222222222" as string | null,
    payoutRoute: null as PayoutRoute,
    mintFeePpm: undefined as number | undefined,
    overrides: undefined as { mintFeePpm?: number; uncorroboratedDelayS?: number; ladder?: object;
      expiriesAhead?: Partial<Record<"daily" | "weekly", number>> } | undefined } }] });
function run(registry: ReturnType<typeof base>) {
  const dir = mkdtempSync(join(tmpdir(), "stonkhouse-v8-registry-test-")); paths.push(dir);
  const source = join(dir, "registry.json"), output = join(dir, "output.ts");
  writeFileSync(source, JSON.stringify(registry));
  const result = spawnSync(process.execPath, [new URL("./gen-v2-registry.mjs", import.meta.url).pathname,
    "--registry", source, "--output", output], { encoding: "utf8" });
  const data = result.status === 0 ? JSON.parse(readFileSync(output, "utf8").split("export const V2_REGISTRY = ")[1]!.split(" as const;")[0]!) : null;
  return { ...result, data };
}

describe("v8 consumer registry projection", () => {
  it("projects canonical pricing identity without numeric coercion", () => {
    const registry = base();
    expect(run(registry).data).toMatchObject({ chainId: 4663,
      markets: [{ uiMultiplier: "1000775159164630595" }] });
    registry.markets[0]!.verification.uiMultiplier = undefined;
    expect(run(registry).data.markets[0].uiMultiplier).toBeNull();
  });

  it.each([undefined, 0, -1, 1.5])("rejects an invalid chain id %s", (value) => {
    const registry = base(); registry.shared.chainId = value as unknown as number;
    expect(run(registry)).toMatchObject({ status: 1,
      stderr: expect.stringContaining("shared.chainId must be a positive safe integer") });
  });

  it.each(["", "0", "01", "1.5", "1e18"])("rejects an invalid UI multiplier %s", (value) => {
    const registry = base(); registry.markets[0]!.verification.uiMultiplier = value;
    expect(run(registry)).toMatchObject({ status: 1,
      stderr: expect.stringContaining("NVDA.verification.uiMultiplier must be a canonical positive decimal string") });
  });

  it("projects the launch set verbatim and refuses a missing, empty, duplicate or unknown one", () => {
    expect(run(base()).data.launchSet).toEqual({ note: "test launch set", markets: ["NVDA"] });
    const missing = base(); missing.launchSet = undefined;
    expect(run(missing)).toMatchObject({ status: 1, stderr: expect.stringContaining("launchSet must be an object of { note, markets }") });
    const nulled = base(); nulled.launchSet = null;
    expect(run(nulled)).toMatchObject({ status: 1, stderr: expect.stringContaining("launchSet must be an object") });
    const noNote = base(); noNote.launchSet!.note = "";
    expect(run(noNote)).toMatchObject({ status: 1, stderr: expect.stringContaining("launchSet.note must be a non-empty string") });
    const empty = base(); empty.launchSet!.markets = [];
    expect(run(empty)).toMatchObject({ status: 1, stderr: expect.stringContaining("launchSet.markets must be a non-empty array") });
    const dupe = base(); dupe.launchSet!.markets = ["NVDA", "NVDA"];
    expect(run(dupe)).toMatchObject({ status: 1, stderr: expect.stringContaining("names NVDA twice") });
    const unknown = base(); unknown.launchSet!.markets = ["NVDA", "SPXC"];
    expect(run(unknown)).toMatchObject({ status: 1, stderr: expect.stringContaining("names SPXC, which is not a market in this registry") });
    const notTicker = base(); notTicker.launchSet!.markets = [42];
    expect(run(notTicker)).toMatchObject({ status: 1, stderr: expect.stringContaining("contains 42, which is not a ticker") });
  });

  it("projects the v8 authority, flywheel and zero-rent configuration", () => {
    expect(run(base()).data).toMatchObject({
      interfaceVersion: 8,
      deployBlock: 123,
      contracts: { accessManager: "0x3333333333333333333333333333333333333333" },
      safes: {
        admin: "0x6666666666666666666666666666666666666666",
        treasury: "0x7777777777777777777777777777777777777777",
      },
      flywheel: {
        feeSplitter: "0x4444444444444444444444444444444444444444",
        buybackExecutor: "0x5555555555555555555555555555555555555555",
        deployBlock: 120,
      },
      fees: { premiumFeeBps: 500, mintFeePpm: 0, allowRent: false },
      markets: [{ mintFeePpm: 0 }],
    });
  });

  it("accepts null deployment blocks before broadcast and rejects invalid populated blocks", () => {
    const registry = base();
    registry.v2.deployBlock = null as unknown as number;
    registry.v2.flywheel.deployBlock = null as unknown as number;
    expect(run(registry).data).toMatchObject({ deployBlock: null, flywheel: { deployBlock: null } });
    for (const value of [undefined, 0, -1, 1.5]) {
      const invalid = base(); invalid.v2.deployBlock = value as unknown as number;
      expect(run(invalid)).toMatchObject({ status: 1,
        stderr: expect.stringContaining("v2.deployBlock must be null or a positive safe integer") });
    }
  });

  it("retains shared rent defaults and explicit market overrides, including zero", () => {
    const registry = base();
    expect(run(registry).data.markets[0].mintFeePpm).toBe(0);
    registry.v2.fees.mintFeePpm = 80;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(80);
    registry.markets[0]!.v2.mintFeePpm = 300;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(300);
    registry.markets[0]!.v2.mintFeePpm = 0;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(0);
  });

  it("retains default and per-market expiry counts for scale consumers", () => {
    const registry = base();
    registry.markets[0]!.v2.overrides = { expiriesAhead: { daily: 1 } };
    expect(run(registry).data).toMatchObject({
      defaults: { expiriesAhead: { daily: 3, weekly: 2 } },
      markets: [{ overrides: { expiriesAhead: { daily: 1 } } }],
    });
  });

  it("keeps settlement source cardinality independent while projecting the payout route", () => {
    const registry = base();
    registry.markets[0]!.v2.payoutRoute = null;
    expect(run(registry).data.markets[0]).toMatchObject({
      payoutRoute: null,
      settlement: { sourceCount: 2, route: null },
    });
    registry.markets[0]!.v2.univ3Pool = null;
    registry.markets[0]!.v2.payoutRoute = {
      venue: "v4", fee: 3_000, tickSpacing: 60, poolId: `0x${"ab".repeat(32)}`,
    };
    expect(run(registry).data.markets[0]).toMatchObject({
      payoutRoute: { venue: "v4", fee: 3_000, tickSpacing: 60, poolId: `0x${"ab".repeat(32)}` },
      settlement: { sourceCount: 1,
        route: { venue: "v4", fee: 3_000, tickSpacing: 60, poolId: `0x${"ab".repeat(32)}` } },
    });
  });

  it("projects null, v3 and v4 payout route shapes exactly", () => {
    const registry = base();
    expect(run(registry).data.markets[0]).toMatchObject({ payoutRoute: null, settlement: { route: null } });
    registry.markets[0]!.v2.payoutRoute = { venue: "v3", fee: 500 };
    expect(run(registry).data.markets[0]).toMatchObject({
      payoutRoute: { venue: "v3", fee: 500 },
      settlement: { route: { venue: "v3", fee: 500 } },
    });
    registry.markets[0]!.v2.payoutRoute = {
      venue: "v4", fee: 10_000, tickSpacing: 32_767, poolId: `0x${"AB".repeat(32)}`,
    };
    expect(run(registry).data.markets[0]).toMatchObject({
      payoutRoute: { venue: "v4", fee: 10_000, tickSpacing: 32_767, poolId: `0x${"ab".repeat(32)}` },
      settlement: {
        route: { venue: "v4", fee: 10_000, tickSpacing: 32_767, poolId: `0x${"ab".repeat(32)}` },
      },
    });
  });

  it.each([
    [{ venue: "v2", fee: 500 }, ".venue must be v3 or v4"],
    [{ venue: "v3", fee: 0 }, ".fee must be an integer in 1..10000"],
    [{ venue: "v3", fee: 500, poolId: `0x${"ab".repeat(32)}` }, "must have exactly venue, fee"],
    [{ venue: "v4", fee: 500, tickSpacing: 0, poolId: `0x${"ab".repeat(32)}` }, ".tickSpacing must be an integer"],
    [{ venue: "v4", fee: 500, tickSpacing: 60, poolId: "0x12" }, ".poolId must be a 32-byte hex value"],
  ])("rejects invalid payout route %#", (value, message) => {
    const registry = base(); registry.markets[0]!.v2.payoutRoute = value as PayoutRoute;
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining(message) });
  });

  it("rejects an older interface before rendering v8-only code", () => {
    const registry = base(); registry.v2.interfaceVersion = 7;
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining("requires interfaceVersion 8") });
  });

  it("matches deploy precedence: direct market rate, legacy override, shared default", () => {
    const registry = base();
    registry.v2.fees.mintFeePpm = 80;
    registry.markets[0]!.v2.overrides = { mintFeePpm: 150 };
    expect(run(registry).data.markets[0].mintFeePpm).toBe(150);
    registry.markets[0]!.v2.mintFeePpm = 300;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(300);
    registry.markets[0]!.v2.mintFeePpm = undefined;
    registry.markets[0]!.v2.overrides.mintFeePpm = 0;
    expect(run(registry).data.markets[0].mintFeePpm).toBe(0);
  });

  it.each([undefined, -1, 5_001, 0.5])("rejects missing or invalid shared rent %s", (ppm) => {
    const registry = base(); registry.v2.fees.mintFeePpm = ppm as number;
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining("v2.fees.mintFeePpm must be ppm") });
  });

  it.each([-1, 5_001, 0.5])("rejects an invalid override %s", (ppm) => {
    const registry = base(); registry.markets[0]!.v2.mintFeePpm = ppm;
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining("NVDA.v2.mintFeePpm must be ppm") });
  });

  it.each([-1, 5_001, 0.5])("rejects an invalid legacy override %s", (ppm) => {
    const registry = base(); registry.markets[0]!.v2.overrides = { mintFeePpm: ppm };
    expect(run(registry)).toMatchObject({ status: 1, stderr: expect.stringContaining("NVDA.v2.mintFeePpm must be ppm") });
  });

  it.each([1_800, 86_400])("accepts the contract settlement-delay boundary %s", (delay) => {
    const registry = base(); registry.markets[0]!.v2.overrides = { uncorroboratedDelayS: delay };
    expect(run(registry).data.markets[0].settlement.uncorroboratedDelayS).toBe(delay);
  });

  it.each([undefined, 0, 1_799, 86_401, 0.5])("rejects a missing or invalid default settlement delay %s", (delay) => {
    const registry = base(); registry.v2.defaults.uncorroboratedDelayS = delay as number;
    expect(run(registry)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("NVDA.v2.uncorroboratedDelayS must be an integer in 1800..86400"),
    });
  });

  it.each([null, 0, 86_401])("rejects an explicit invalid settlement-delay override %s", (delay) => {
    const registry = base();
    registry.markets[0]!.v2.overrides = { uncorroboratedDelayS: delay as unknown as number };
    expect(run(registry)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("NVDA.v2.uncorroboratedDelayS must be an integer in 1800..86400"),
    });
  });

  it.each([undefined, "not-an-address"])("rejects an invalid settlement TWAP source %s", (pool) => {
    const registry = base(); registry.markets[0]!.v2.univ3Pool = pool as string;
    expect(run(registry)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("NVDA.v2.univ3Pool must be null or an address"),
    });
  });

  it("does not expose the settlement TWAP source as the payout route", () => {
    const registry = base();
    registry.markets[0]!.v2.univ3Pool = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3";
    expect(run(registry).data.markets[0].settlement).toMatchObject({ sourceCount: 2, route: null });
  });
});

describe("the House factories and vaults the indexer's HouseVault source filters on", () => {
  const FACTORY = "0x5bea4c9887c322d5ec8c7ae547c25091599774d2";
  const WEEKLY = "0xfb5ccb9cf9249e46d8af0c4f8fe7eaa9bd7bff51";
  const DAILY = "0x53ef3ff548fe3eaa1a1c0a0e010ed0abb5365201";
  type House = { factories?: unknown; };
  const withHouse = (house: House | undefined, v2: { houseVault?: unknown; house?: unknown } = {},
    contracts: Record<string, unknown> = {}) => {
    const registry = base();
    const v2Block = registry.v2 as Record<string, unknown>;
    if (house !== undefined) v2Block.house = house;
    Object.assign(registry.v2.contracts, contracts);
    Object.assign(registry.markets[0]!.v2, v2);
    return registry;
  };

  it("projects empty lists for a registry with no house block", () => {
    expect(run(base()).data.house).toEqual({ factories: [], vaults: [] });
  });

  it("projects every recorded vault once, checksummed, with the factories and their deploy blocks", () => {
    const registry = withHouse(
      { factories: [{ kind: "weekly", address: FACTORY, deployBlock: 69_517_900 }] },
      { houseVault: WEEKLY, house: { weekly: WEEKLY, daily: DAILY } },
      { houseVault: WEEKLY, houseVaultFactory: FACTORY },
    );
    const result = run(registry);
    expect(result.status, result.stderr).toBe(0);
    expect(result.data.house).toEqual({
      factories: [{ kind: "weekly", address: "0x5BEa4c9887C322d5Ec8C7ae547c25091599774d2", deployBlock: 69_517_900 }],
      vaults: [
        { ticker: "NVDA", kind: "weekly", address: "0xfb5CcB9CF9249E46D8Af0C4f8fe7Eaa9bD7BfF51" },
        { ticker: "NVDA", kind: "daily", address: "0x53eF3ff548Fe3EaA1A1c0a0E010ED0aBB5365201" },
      ],
    });
  });

  // The launch vault carries the launch factory's kind. On v9 the launch factory is the DAILY entry and
  // build-markets requires houseVault == house.daily; projecting houseVault as weekly first made the dedupe drop the
  // correct daily entry. The case above is the v8 control (weekly launch factory: weekly, once).
  it("v9: a daily launch factory's vault is projected once, as daily", () => {
    const V9_FACTORY = "0x000000000000000000000000000000000000f009";
    const registry = withHouse(
      { factories: [{ kind: "daily", address: V9_FACTORY, deployBlock: 70_100_000 }] },
      { houseVault: DAILY, house: { weekly: null, daily: DAILY } },
      { houseVault: DAILY, houseVaultFactory: V9_FACTORY },
    );
    const result = run(registry);
    expect(result.status, result.stderr).toBe(0);
    expect(result.data.house.vaults).toEqual([
      { ticker: "NVDA", kind: "daily", address: "0x53eF3ff548Fe3EaA1A1c0a0E010ED0aBB5365201" },
    ]);
  });

  it("refuses a launch factory recorded under both kinds, which build-markets refuses too", () => {
    const registry = withHouse(
      { factories: [{ kind: "weekly", address: FACTORY, deployBlock: 1 }, { kind: "daily", address: FACTORY, deployBlock: 1 }] },
      { houseVault: WEEKLY },
      { houseVaultFactory: FACTORY },
    );
    const result = run(registry);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("as BOTH weekly and daily");
  });

  it("keeps v2.contracts.houseVault when no market names it, with a null ticker", () => {
    const registry = withHouse({ factories: [] }, {}, { houseVault: WEEKLY });
    expect(run(registry).data.house.vaults).toEqual([
      { ticker: null, kind: "weekly", address: "0xfb5CcB9CF9249E46D8Af0C4f8fe7Eaa9bD7BfF51" },
    ]);
  });

  it.each([
    ["a zero vault", {}, { houseVault: "0x0000000000000000000000000000000000000000" }, "NVDA.v2.houseVault is the zero address"],
    ["a malformed daily vault", {}, { house: { weekly: null, daily: "0x1234" } }, "NVDA.v2.house.daily must be an address"],
    ["a malformed factory", { factories: [{ kind: "weekly", address: "nope", deployBlock: 1 }] }, {},
      "v2.house.factories[0].address must be an address"],
    ["a factory of unknown kind", { factories: [{ kind: "hourly", address: FACTORY, deployBlock: 1 }] }, {},
      "v2.house.factories[0].kind must be weekly or daily"],
    ["a factory with a bad deploy block", { factories: [{ kind: "weekly", address: FACTORY, deployBlock: 0 }] }, {},
      "v2.house.factories[0].deployBlock must be null or a positive safe integer"],
  ])("refuses %s", (_label, house, v2, message) => {
    const result = run(withHouse(house, v2));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});
