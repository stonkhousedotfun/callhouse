/**
 * The kind comes from the factory. Legacy: weekly, and weekly() is never called. Kinded: weekly() is read.
 * Anything else, or a failed read: unknown.
 * The kinded set is derived from the registry's v2.house.factories, never hand-listed.
 * The same set is a Ponder source of its own, registered only for the registry's own Clearinghouse.
 * A configured launch factory joins that source (v9 emits only the 5-field event); the event's weekly wins.
 * The factory() fallback discovers on the event the anchoring factory emits, read from the registry's kinds.
 * A V2_HOUSE_VAULT_FACTORY the registry does not name joins the 5-field source, for any Clearinghouse.
 */
import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";
import {
  houseDiscoveryEvent,
  houseSourceAnchor,
  houseVaultKind,
  KINDED_HOUSE_FACTORIES,
  kindedHouseFactories,
  kindedHouseFactorySourcesFor,
  launchFactoryKind,
  legacyHouseFactories,
} from "./houseVaultKind";

const LEGACY = V2_REGISTRY.contracts.houseVaultFactory as string;
const KINDED = "0x00000000000000000000000000000000000c0de1";
const OTHER = "0x00000000000000000000000000000000000c0de2";

function reader(answer: boolean | Error) {
  const calls: number[] = [];
  return {
    calls,
    readWeekly: async () => {
      calls.push(1);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe("house vault kind", () => {
  it("the legacy set is the registry's launch factory, read from the generated registry", () => {
    expect(LEGACY).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect([...legacyHouseFactories()]).toEqual([LEGACY.toLowerCase()]);
  });

  it("the production kinded set is the generated registry's daily factories, and never the launch factory", () => {
    // Expected from the registry rows themselves, so the pin follows a write-back instead of freezing today's
    // empty set: the day the daily factory is written back and the registry regenerated, it is in here.
    // Minus the launch factory. On v9 the registry's daily entry IS the launch factory, and the
    // legacy rule keeps it out of the kinded set (kindedHouseFactories); its vaults are kinded by the 5-field event.
    const daily = V2_REGISTRY.house.factories.filter((f) => (f.kind as string) === "daily").map((f) => f.address.toLowerCase());
    expect([...KINDED_HOUSE_FACTORIES].sort()).toEqual(daily.filter((a) => a !== LEGACY.toLowerCase()).sort());
    expect(KINDED_HOUSE_FACTORIES.has(LEGACY.toLowerCase())).toBe(false);
  });

  it("a legacy-factory vault is weekly and weekly() is NEVER called (it reverts on those vaults)", async () => {
    const r = reader(new Error("execution reverted"));
    const kind = await houseVaultKind({ factory: LEGACY.toUpperCase().replace("0X", "0x"), legacy: legacyHouseFactories(), kinded: new Set([KINDED]), readWeekly: r.readWeekly });
    expect(kind).toBe("weekly");
    expect(r.calls).toHaveLength(0);
  });

  it("a kinded-factory vault reads weekly() once: true is weekly, false is daily", async () => {
    for (const [answer, want] of [[true, "weekly"], [false, "daily"]] as const) {
      const r = reader(answer);
      expect(await houseVaultKind({ factory: KINDED, legacy: legacyHouseFactories(), kinded: new Set([KINDED]), readWeekly: r.readWeekly })).toBe(want);
      expect(r.calls).toHaveLength(1);
    }
  });

  it("a failed weekly() read on a kinded vault is unknown, not weekly", async () => {
    const r = reader(new Error("rpc 503"));
    expect(await houseVaultKind({ factory: KINDED, legacy: legacyHouseFactories(), kinded: new Set([KINDED]), readWeekly: r.readWeekly })).toBe("unknown");
    expect(r.calls).toHaveLength(1);
  });

  it("a factory that is neither legacy nor kinded is unknown, and nothing is read", async () => {
    const r = reader(true);
    expect(await houseVaultKind({ factory: OTHER, legacy: legacyHouseFactories(), kinded: new Set([KINDED]), readWeekly: r.readWeekly })).toBe("unknown");
    expect(r.calls).toHaveLength(0);
  });

  /* ------------------------------------------------------------------ the kinded set comes from the registry */

  // A registry after the V8-DAILY-HOUSEVAULT-DEPLOY step-2 write-back: the launch factory is the weekly entry, the
  // kinded factory is the daily entry. Mixed-case addresses, as the registry stores them (checksummed).
  const DAILY_FACTORY = "0x000000000000000000000000000000000000dA11";
  const LAUNCH_ENTRY = { kind: "weekly", address: LEGACY, deployBlock: 69517900 };
  const written = {
    contracts: { houseVaultFactory: LEGACY },
    house: {
      factories: [LAUNCH_ENTRY, { kind: "daily", address: DAILY_FACTORY, deployBlock: 70206525 }],
      vaults: [],
    },
  };

  it("derives the kinded set from v2.house.factories: the daily entry is in, the weekly (launch) entry is not", () => {
    expect([...kindedHouseFactories(written)]).toEqual([DAILY_FACTORY.toLowerCase()]);
    expect([...legacyHouseFactories(written)]).toEqual([LEGACY.toLowerCase()]);
  });

  it("a vault of the registry's daily factory resolves to daily or weekly by its weekly() read", async () => {
    for (const [answer, want] of [[false, "daily"], [true, "weekly"]] as const) {
      const r = reader(answer);
      const kind = await houseVaultKind({
        factory: DAILY_FACTORY.toLowerCase(),
        legacy: legacyHouseFactories(written),
        kinded: kindedHouseFactories(written),
        readWeekly: r.readWeekly,
      });
      expect(kind).toBe(want);
      expect(r.calls).toHaveLength(1);
    }
  });

  it("a vault of the registry's launch factory is weekly and weekly() is never called", async () => {
    const r = reader(new Error("execution reverted"));
    const kind = await houseVaultKind({
      factory: LEGACY,
      legacy: legacyHouseFactories(written),
      kinded: kindedHouseFactories(written),
      readWeekly: r.readWeekly,
    });
    expect(kind).toBe("weekly");
    expect(r.calls).toHaveLength(0);
  });

  it("a registry with no daily entry (or no house block) has no kinded factory, so the daily vault is unknown", async () => {
    const launchOnly = { contracts: { houseVaultFactory: LEGACY }, house: { factories: [LAUNCH_ENTRY], vaults: [] } };
    expect(kindedHouseFactories(launchOnly).size).toBe(0);
    expect(kindedHouseFactories({ contracts: { houseVaultFactory: LEGACY } }).size).toBe(0);
    const r = reader(false);
    expect(await houseVaultKind({ factory: DAILY_FACTORY, legacy: legacyHouseFactories(launchOnly), kinded: kindedHouseFactories(launchOnly), readWeekly: r.readWeekly })).toBe("unknown");
    expect(r.calls).toHaveLength(0);
  });

  it("a daily entry that names the launch factory is NOT kinded: the legacy rule wins and weekly() is never called", async () => {
    const confused = { contracts: { houseVaultFactory: LEGACY }, house: { factories: [{ kind: "daily", address: LEGACY.toLowerCase(), deployBlock: 1 }], vaults: [] } };
    expect(kindedHouseFactories(confused).size).toBe(0);
    const r = reader(new Error("execution reverted"));
    expect(await houseVaultKind({ factory: LEGACY, legacy: legacyHouseFactories(confused), kinded: kindedHouseFactories(confused), readWeekly: r.readWeekly })).toBe("weekly");
    expect(r.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ the kinded factories as a source */

describe("kinded House factory sources", () => {
  const CH = "0x1A67948175DFf13426F0d61bfB483579D2ff2EeE";
  const DAILY = "0x000000000000000000000000000000000000dA11";
  const DAILY_2 = "0x000000000000000000000000000000000000da12";
  // The daily-only redeploy shape: no launch factory at all, one kinded factory.
  const dailyOnly = {
    contracts: { clearinghouse: CH, houseVaultFactory: null },
    house: { factories: [{ kind: "daily", address: DAILY, deployBlock: 70_000_000 }], vaults: [] },
  };

  it("a daily-only registry sources its daily factory at the registry deploy block, for the registry's own Clearinghouse", () => {
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH.toLowerCase(), envStartBlock: undefined, registry: dailyOnly }))
      .toEqual({ addresses: [DAILY], startBlock: 70_000_000 });
  });

  it("registers nothing for another Clearinghouse (dev, rehearsal, a fork) or with no Clearinghouse at all", () => {
    const other = "0x000000000000000000000000000000000000c011";
    expect(kindedHouseFactorySourcesFor({ clearinghouse: other, envStartBlock: 1, registry: dailyOnly })).toBeUndefined();
    expect(kindedHouseFactorySourcesFor({ clearinghouse: undefined, envStartBlock: 1, registry: dailyOnly })).toBeUndefined();
    // Positive control: the same call with the registry's own Clearinghouse does register.
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 1, registry: dailyOnly })).toBeDefined();
  });

  it("registers nothing when the registry has no daily factory and no configured launch factory", () => {
    // A later change narrowed this case's first half (see the v9 describe below): a CONFIGURED launch factory (envStartBlock set)
    // is now sourced on the 5-field topic too. With the launch source off, a launch-only or confused registry is inert.
    const launchOnly = { contracts: { clearinghouse: CH, houseVaultFactory: LEGACY }, house: { factories: [{ kind: "weekly", address: LEGACY, deployBlock: 1 }], vaults: [] } };
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: undefined, registry: launchOnly })).toBeUndefined();
    const confused = { contracts: { clearinghouse: CH, houseVaultFactory: LEGACY }, house: { factories: [{ kind: "daily", address: LEGACY, deployBlock: 1 }], vaults: [] } };
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: undefined, registry: confused })).toBeUndefined();
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 1, registry: { contracts: { clearinghouse: CH } } })).toBeUndefined();
  });

  it("several daily factories: checksummed, deduplicated, sorted, starting at the lowest deploy block", () => {
    const two = {
      contracts: { clearinghouse: CH, houseVaultFactory: null },
      house: {
        factories: [
          { kind: "daily", address: DAILY_2, deployBlock: 70_000_500 },
          { kind: "daily", address: DAILY.toLowerCase(), deployBlock: 70_000_100 },
          { kind: "daily", address: DAILY, deployBlock: 70_000_100 },
        ],
        vaults: [],
      },
    };
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: undefined, registry: two }))
      .toEqual({ addresses: [DAILY, "0x000000000000000000000000000000000000dA12"], startBlock: 70_000_100 });
  });

  it("a daily factory with no deploy block falls back to V2_HOUSE_START_BLOCK, and refuses when that is unset too", () => {
    const noBlock = { ...dailyOnly, house: { factories: [{ kind: "daily", address: DAILY, deployBlock: null }], vaults: [] } };
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 69_517_900, registry: noBlock }))
      .toEqual({ addresses: [DAILY], startBlock: 69_517_900 });
    expect(() => kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: undefined, registry: noBlock }))
      .toThrow(/has no deployBlock and V2_HOUSE_START_BLOCK is unset/);
  });

  it("fails closed on a malformed or zero factory address", () => {
    const bad = (address: string) => ({ ...dailyOnly, house: { factories: [{ kind: "daily", address, deployBlock: 1 }], vaults: [] } });
    expect(() => kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 1, registry: bad("0xnot-an-address") })).toThrow(/is not an address/);
    expect(() => kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 1, registry: bad("0x0000000000000000000000000000000000000000") })).toThrow(/zero address/);
  });

  it("anchors the HouseVault source on the launch factory when it is configured, else on the kinded factory", () => {
    const kinded = { addresses: [DAILY] as const, startBlock: 70_000_000 };
    expect(houseSourceAnchor(LEGACY as `0x${string}`, 69_517_900, kinded)).toEqual({ factory: LEGACY, startBlock: 69_517_900, kind: "launch" });
    expect(houseSourceAnchor(undefined, undefined, kinded)).toEqual({ factory: DAILY, startBlock: 70_000_000, kind: "kinded" });
    expect(houseSourceAnchor(undefined, undefined, undefined)).toBeUndefined();
    expect(houseSourceAnchor(LEGACY as `0x${string}`, 69_517_900, undefined)?.kind).toBe("launch");
  });
});

/* ------------------------------------------ the v9 launch factory emits only the 5-field VaultCreated */

describe("v9: the launch factory emits only the 5-field VaultCreated", () => {
  const CH = "0x1A67948175DFf13426F0d61bfB483579D2ff2EeE";
  // The v9 redeploy's factory, recorded where the launch tooling records every launch factory: v2.contracts.houseVaultFactory.
  const V9 = "0x000000000000000000000000000000000000F009";
  const DAILY = "0x000000000000000000000000000000000000dA11";
  const v9 = (kind: "weekly" | "daily") => ({
    contracts: { clearinghouse: CH, houseVaultFactory: V9 },
    house: { factories: [{ kind, address: V9, deployBlock: 70_100_000 }], vaults: [] },
  });

  it("a configured launch factory is sourced on the 5-field topic at V2_HOUSE_START_BLOCK, whatever kind the registry gives it", () => {
    for (const kind of ["weekly", "daily"] as const) {
      expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 70_100_005, registry: v9(kind) }), kind)
        .toEqual({ addresses: [getAddress(V9)], startBlock: 70_100_005 });
    }
    // It is still NOT a kinded factory for the kind rule: that set is unchanged (the legacy rule still wins there).
    expect(kindedHouseFactories(v9("daily")).size).toBe(0);
  });

  it("sits beside a registry daily factory: both addresses, lowest block", () => {
    const both = { ...v9("weekly"), house: { factories: [...v9("weekly").house.factories, { kind: "daily", address: DAILY, deployBlock: 70_200_000 }], vaults: [] } };
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 70_100_005, registry: both }))
      .toEqual({ addresses: [DAILY, getAddress(V9)], startBlock: 70_100_005 });
  });

  it("is not added for another Clearinghouse, and fails closed on a malformed launch address", () => {
    expect(kindedHouseFactorySourcesFor({ clearinghouse: "0x000000000000000000000000000000000000c011", envStartBlock: 1, registry: v9("daily") })).toBeUndefined();
    const bad = (houseVaultFactory: string) => ({ ...v9("daily"), contracts: { clearinghouse: CH, houseVaultFactory } });
    expect(() => kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 1, registry: bad("0xnope") })).toThrow(/is not an address/);
    expect(() => kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 1, registry: bad(zeroAddress) })).toThrow(/zero address/);
  });

  it("the 5-field event's weekly is the kind, even from a factory in the legacy set, and weekly() is never read", async () => {
    for (const [stated, want] of [[false, "daily"], [true, "weekly"]] as const) {
      const r = reader(new Error("must not be called"));
      expect(await houseVaultKind({ factory: V9, legacy: new Set([V9.toLowerCase()]), kinded: new Set(), readWeekly: r.readWeekly, stated }))
        .toBe(want);
      expect(r.calls).toHaveLength(0);
    }
    // Positive control: with no stated kind the same factory still resolves by the legacy rule.
    expect(await houseVaultKind({ factory: V9, legacy: new Set([V9.toLowerCase()]), kinded: new Set(), readWeekly: reader(false).readWeekly }))
      .toBe("weekly");
  });
});

/* ------------------- the factory() fallback watches the VaultCreated the anchoring factory actually emits */

describe("houseDiscoveryEvent reads the event form from the registry (launchFactoryKind), never assumes legacy", () => {
  const V8 = "0x5BEa4c9887C322d5Ec8C7ae547c25091599774d2";
  const V9 = "0x000000000000000000000000000000000000F009";
  const DAILY = "0x000000000000000000000000000000000000dA11";
  const DEV = "0x000000000000000000000000000000000000D0e5";
  const reg = (launch: string | null, factories: { kind: string; address: string }[]) => ({
    contracts: { houseVaultFactory: launch },
    house: { factories: factories.map((f) => ({ ...f, deployBlock: 1 })), vaults: [] },
  });
  const v8 = reg(V8, [{ kind: "weekly", address: V8 }]);
  const v9 = reg(V9, [{ kind: "daily", address: V9 }]);
  const launch = (factory: string) => ({ factory, kind: "launch" as const });

  it("launchFactoryKind is build-markets launchFactoryKind rule for rule", () => {
    expect(launchFactoryKind(v8)).toBe("weekly");
    expect(launchFactoryKind(v9)).toBe("daily");
    expect(launchFactoryKind(reg(V9.toLowerCase(), [{ kind: "daily", address: V9 }])), "compared ignoring case").toBe("daily");
    expect(launchFactoryKind(reg(V8, [])), "no entry names it: the implied pre-T-OP-101 launch").toBe("weekly");
    expect(launchFactoryKind({ contracts: { houseVaultFactory: V8 } }), "no house block").toBe("weekly");
    expect(launchFactoryKind(reg(null, [{ kind: "daily", address: DAILY }])), "no launch factory").toBe("weekly");
    expect(launchFactoryKind(reg(V8, [{ kind: "weekly", address: V8 }, { kind: "daily", address: DAILY }])), "v8 + a daily factory").toBe("weekly");
    expect(launchFactoryKind(reg(V9, [{ kind: "weekly", address: V9 }, { kind: "daily", address: V9 }])), "both kinds").toBeNull();
    // The shipped registry: v9 mainnet launch (12:02 PM PT 2026-09-25, deployBlock 72462898), its launch factory is
    // the daily entry (on v8 it was the weekly entry).
    expect(launchFactoryKind()).toBe("daily");
  });

  it("v8: the registry's weekly launch factory is discovered on the legacy 4-field topic (unchanged)", () => {
    expect(houseDiscoveryEvent(launch(V8), v8)).toBe("legacy");
    expect(houseDiscoveryEvent(launch(V8.toLowerCase()), v8)).toBe("legacy");
    expect(houseDiscoveryEvent(launch(V8), reg(V8, [])), "no entry yet: still the pre-T-OP-101 launch").toBe("legacy");
  });

  it("v9: the registry's daily launch factory is discovered on the 5-field topic", () => {
    expect(houseDiscoveryEvent(launch(V9), v9)).toBe("kinded");
    expect(houseDiscoveryEvent(launch(V9.toLowerCase()), v9)).toBe("kinded");
    // The baked registry is v9's (mainnet launch 12:02 PM PT 2026-09-25, deployBlock 72462898), so its
    // launch factory is discovered on the 5-field topic (on v8 this line said "legacy", in the v8 case above).
    expect(houseDiscoveryEvent(launch(LEGACY)), "the baked registry's launch factory").toBe("kinded");
  });

  it("a factory the registry does not name (dev, rehearsal, fork) is discovered on the 5-field topic, on either registry", () => {
    expect(houseDiscoveryEvent(launch(DEV), v8)).toBe("kinded");
    expect(houseDiscoveryEvent(launch(DEV), v9)).toBe("kinded");
    expect(houseDiscoveryEvent(launch(DEV), reg(null, []))).toBe("kinded");
    // The case: the v9 factory on an image whose registry is v8-era.
    expect(houseDiscoveryEvent(launch(V9), v8)).toBe("kinded");
  });

  it("another registry entry: its recorded kind decides; a kinded anchor is unchanged", () => {
    expect(houseDiscoveryEvent(launch(DAILY), reg(V8, [{ kind: "weekly", address: V8 }, { kind: "daily", address: DAILY }]))).toBe("kinded");
    expect(houseDiscoveryEvent(launch(DAILY), reg(null, [{ kind: "weekly", address: DAILY }]))).toBe("legacy");
    expect(houseDiscoveryEvent({ factory: V8, kind: "kinded" }, v8)).toBe("kinded");
  });

  it("refuses by name to guess when the launch factory is recorded under both kinds", () => {
    const both = reg(V9, [{ kind: "weekly", address: V9 }, { kind: "daily", address: V9 }]);
    expect(() => houseDiscoveryEvent(launch(V9), both)).toThrow(/is recorded as BOTH the weekly and the daily House factory/);
  });
});

/* ------------- a factory the registry does not name gets its 5-field VaultCreated handled, not only discovered */

describe("V2_HOUSE_VAULT_FACTORY the registry does not name is sourced on the 5-field topic", () => {
  const CH = "0x1A67948175DFf13426F0d61bfB483579D2ff2EeE";
  const FOREIGN_CH = "0x000000000000000000000000000000000000c011";
  const LAUNCH = "0x000000000000000000000000000000000000F009";
  const DAILY = "0x000000000000000000000000000000000000dA11";
  const UNNAMED = "0x000000000000000000000000000000000000f001";
  const registry = {
    contracts: { clearinghouse: CH, houseVaultFactory: LAUNCH },
    house: { factories: [{ kind: "daily", address: LAUNCH, deployBlock: 70_100_000 }, { kind: "daily", address: DAILY, deployBlock: 70_200_000 }], vaults: [] },
  };

  it("another Clearinghouse (dev, rehearsal, fork): the unnamed factory alone, at V2_HOUSE_START_BLOCK", () => {
    // Earlier this was undefined: the HouseVault fallback discovered the vaults, but their VaultCreated had no source.
    expect(kindedHouseFactorySourcesFor({ clearinghouse: FOREIGN_CH, envStartBlock: 100, envFactory: UNNAMED, registry }))
      .toEqual({ addresses: [getAddress(UNNAMED)], startBlock: 100 });
    expect(kindedHouseFactorySourcesFor({ clearinghouse: undefined, envStartBlock: 100, envFactory: UNNAMED.toUpperCase().replace("0X", "0x"), registry }))
      .toEqual({ addresses: [getAddress(UNNAMED)], startBlock: 100 });
  });

  it("the registry's own Clearinghouse: beside the registry's factories, lowest block", () => {
    expect(kindedHouseFactorySourcesFor({ clearinghouse: CH, envStartBlock: 100, envFactory: UNNAMED, registry }))
      .toEqual({ addresses: [getAddress(DAILY), getAddress(UNNAMED), getAddress(LAUNCH)].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)), startBlock: 100 });
  });

  it("a factory the registry names keeps the registry-Clearinghouse rule: nothing for another Clearinghouse (positive controls)", () => {
    for (const named of [LAUNCH, LAUNCH.toLowerCase(), DAILY]) {
      expect(kindedHouseFactorySourcesFor({ clearinghouse: FOREIGN_CH, envStartBlock: 100, envFactory: named, registry }), named).toBeUndefined();
    }
    // And no V2_HOUSE_START_BLOCK means no launch source at all (lib/env.ts sets the two together): nothing is added.
    expect(kindedHouseFactorySourcesFor({ clearinghouse: FOREIGN_CH, envStartBlock: undefined, envFactory: UNNAMED, registry })).toBeUndefined();
  });

  it("fails closed on a malformed or zero V2_HOUSE_VAULT_FACTORY", () => {
    expect(() => kindedHouseFactorySourcesFor({ clearinghouse: FOREIGN_CH, envStartBlock: 1, envFactory: "0xnope", registry })).toThrow(/V2_HOUSE_VAULT_FACTORY="0xnope" is not an address/);
    expect(() => kindedHouseFactorySourcesFor({ clearinghouse: FOREIGN_CH, envStartBlock: 1, envFactory: zeroAddress, registry })).toThrow(/V2_HOUSE_VAULT_FACTORY is the zero address/);
  });

  it("the three House decisions agree: the anchor is the unnamed factory, discovery is 5-field, and its event states the kind", async () => {
    const kinded = kindedHouseFactorySourcesFor({ clearinghouse: FOREIGN_CH, envStartBlock: 100, envFactory: UNNAMED, registry });
    const anchor = houseSourceAnchor(getAddress(UNNAMED), 100, kinded);
    expect(anchor).toEqual({ factory: getAddress(UNNAMED), startBlock: 100, kind: "launch" });
    expect(houseDiscoveryEvent(anchor!, registry)).toBe("kinded");
    expect(kinded!.addresses).toContain(anchor!.factory);
    // The handler's kind for such a vault comes from the event: daily, not "unknown", and weekly() is never read.
    const r = reader(new Error("must not be called"));
    expect(await houseVaultKind({ factory: UNNAMED, legacy: legacyHouseFactories(registry), kinded: kindedHouseFactories(registry), readWeekly: r.readWeekly, stated: false }))
      .toBe("daily");
    expect(r.calls).toHaveLength(0);
  });
});
