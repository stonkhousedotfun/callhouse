import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";

import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";
import { kindedHouseFactorySourcesFor } from "./houseVaultKind";
import { priceSourcesFor } from "./priceSourceRegistry";
import {
  REGISTRY_CLEARINGHOUSE_MISMATCH,
  assertRegistryClearinghouse,
  registryClearinghouseCheck,
  registryHealth,
  v2RegistryClearinghouseCheck,
} from "./registryClearinghouse";

/**
 * The two source groups that drop themselves for another Clearinghouse (the House factory source and the
 * price sources) are each checked on their own: a registry that names only that group, production refuses naming it,
 * dev warns naming it. Each case also runs the group's own decision function on the same registry, so the test pins
 * that the group really is absent for this Clearinghouse and present for the registry's (the refusal would be moot if
 * the group registered anyway, and a false alarm if it never registered at all).
 */
const OWN = "0x1A67948175DFf13426F0d61bfB483579D2ff2EeE";
const V9 = "0x000000000000000000000000000000000000c011";
const LAUNCH = "0x5BEa4c9887C322d5Ec8C7ae547c25091599774d2";
const DAILY = "0x000000000000000000000000000000000000dA11";
const CHAINLINK = "0x00000000000000000000000000000000000000a1";
const UNIV3 = "0x00000000000000000000000000000000000000b2";

const houseOnly = {
  deployBlock: 1000,
  contracts: { clearinghouse: OWN, houseVaultFactory: LAUNCH, sources: { chainlink: null, univ3: null, dataStreams: null } },
  house: {
    factories: [
      { kind: "weekly", address: LAUNCH, deployBlock: 900 },
      { kind: "daily", address: DAILY, deployBlock: 950 },
    ],
    vaults: [],
  },
};
const pricesOnly = {
  deployBlock: 1000,
  contracts: { clearinghouse: OWN, houseVaultFactory: null, sources: { chainlink: CHAINLINK, univ3: UNIV3, dataStreams: null } },
  house: { factories: [], vaults: [] },
};

function refusal(registry: typeof houseOnly | typeof pricesOnly): string {
  try {
    assertRegistryClearinghouse({ production: true, clearinghouse: V9, registry, warn: () => {} });
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error("expected a production refusal");
}

function warning(registry: typeof houseOnly | typeof pricesOnly): string {
  const warn = vi.fn();
  assertRegistryClearinghouse({ production: false, clearinghouse: V9, registry, warn });
  expect(warn).toHaveBeenCalledTimes(1);
  return String(warn.mock.calls[0]![0]);
}

describe("House sources for another Clearinghouse", () => {
  it("the House factory source drops itself for another Clearinghouse and registers for the registry's", () => {
    expect(kindedHouseFactorySourcesFor({ clearinghouse: V9, envStartBlock: 900, registry: houseOnly })).toBeUndefined();
    expect(kindedHouseFactorySourcesFor({ clearinghouse: OWN, envStartBlock: 900, registry: houseOnly })?.addresses)
      .toEqual([getAddress(DAILY), getAddress(LAUNCH)].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });

  it("production refuses boot with one named line that names the House factories and the fix", () => {
    const message = refusal(houseOnly);
    expect(message).not.toContain("\n");
    expect(message).toContain(
      `${REGISTRY_CLEARINGHOUSE_MISMATCH}: V2_CLEARINGHOUSE ${V9} is not the baked registry's v2.contracts.clearinghouse (${OWN})`);
    expect(message).toContain(`no House factory source (launch factory ${LAUNCH}, daily factory ${DAILY})`);
    expect(message).toContain("no price source (the registry names none)");
    expect(message).toContain("Refusing to start");
    expect(message).toContain("ops/v2/post-broadcast-regen.mjs");
  });

  it("dev warns once, loudly, naming the same House factories, and does not throw", () => {
    const line = warning(houseOnly);
    expect(line).toContain(`[callhouse/indexer] WARNING ${REGISTRY_CLEARINGHOUSE_MISMATCH}`);
    expect(line).toContain(`no House factory source (launch factory ${LAUNCH}, daily factory ${DAILY})`);
    expect(line).toContain("/v2/health/registry");
  });
});

describe("price sources for another Clearinghouse", () => {
  it("the price sources drop themselves for another Clearinghouse and register for the registry's", () => {
    expect(priceSourcesFor(V9, pricesOnly)).toBeUndefined();
    expect(Object.keys(priceSourcesFor(OWN, pricesOnly)?.addresses ?? {})).toEqual(["ChainlinkFeedSource", "UniV3TwapSource"]);
  });

  it("production refuses boot with one named line that names the price sources", () => {
    const message = refusal(pricesOnly);
    expect(message).not.toContain("\n");
    expect(message).toContain(`${REGISTRY_CLEARINGHOUSE_MISMATCH}: V2_CLEARINGHOUSE ${V9}`);
    expect(message).toContain(`no price source (ChainlinkFeedSource ${CHAINLINK}, UniV3TwapSource ${UNIV3})`);
    expect(message).toContain("no House factory (the registry names none)");
  });

  it("dev warns naming the same price sources, and does not throw", () => {
    const line = warning(pricesOnly);
    expect(line).toContain(`WARNING ${REGISTRY_CLEARINGHOUSE_MISMATCH}`);
    expect(line).toContain(`no price source (ChainlinkFeedSource ${CHAINLINK}, UniV3TwapSource ${UNIV3})`);
  });
});

describe("the registry's own Clearinghouse, and v2 off", () => {
  it("the registry's Clearinghouse, in any case, is no mismatch: production boots and dev does not warn", () => {
    const warn = vi.fn();
    for (const clearinghouse of [OWN, OWN.toLowerCase()]) {
      assertRegistryClearinghouse({ production: true, clearinghouse, registry: houseOnly, warn });
      assertRegistryClearinghouse({ production: false, clearinghouse, registry: pricesOnly, warn });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("no V2_CLEARINGHOUSE (v1 only) is no mismatch", () => {
    const warn = vi.fn();
    assertRegistryClearinghouse({ production: true, clearinghouse: undefined, registry: houseOnly, warn });
    expect(warn).not.toHaveBeenCalled();
    expect(registryClearinghouseCheck(undefined, houseOnly).mismatch).toBeNull();
  });

  it("a registry with no Clearinghouse (a pre-deploy registry) is a mismatch for any configured one", () => {
    const nulled = { ...pricesOnly, contracts: { ...pricesOnly.contracts, clearinghouse: null } };
    expect(registryClearinghouseCheck(V9, nulled).mismatch)
      .toBe(`V2_CLEARINGHOUSE ${V9} is not the baked registry's v2.contracts.clearinghouse (null)`);
    expect(() => assertRegistryClearinghouse({ production: true, clearinghouse: V9, registry: nulled })).toThrow(
      REGISTRY_CLEARINGHOUSE_MISMATCH);
  });

  it("the generated registry: its own Clearinghouse is no mismatch, another one is", () => {
    const own = V2_REGISTRY.contracts.clearinghouse as string;
    expect(v2RegistryClearinghouseCheck(own).mismatch).toBeNull();
    expect(v2RegistryClearinghouseCheck(V9).mismatch).toContain(`(${own})`);
  });
});

describe("/v2/health/registry's body", () => {
  it("dev: a mismatch is reported with what it silences, and stays ok (200)", () => {
    const body = registryHealth(registryClearinghouseCheck(V9, houseOnly), false);
    expect(body).toEqual({
      ok: true, alert: null, production: false,
      mismatch: `V2_CLEARINGHOUSE ${V9} is not the baked registry's v2.contracts.clearinghouse (${OWN})`,
      clearinghouse: V9, registryClearinghouse: OWN,
      silenced: { house: [`launch factory ${LAUNCH}`, `daily factory ${DAILY}`], priceSources: [] },
    });
  });

  it("production: the same mismatch is the alert (503)", () => {
    const body = registryHealth(registryClearinghouseCheck(V9, pricesOnly), true);
    expect(body).toMatchObject({ ok: false, alert: REGISTRY_CLEARINGHOUSE_MISMATCH, production: true });
    expect(body.silenced.priceSources).toEqual([`ChainlinkFeedSource ${CHAINLINK}`, `UniV3TwapSource ${UNIV3}`]);
  });

  it("no mismatch is ok in either mode, with nothing silenced", () => {
    for (const production of [true, false]) {
      expect(registryHealth(registryClearinghouseCheck(OWN, houseOnly), production)).toMatchObject({
        ok: true, alert: null, mismatch: null, silenced: { house: [], priceSources: [] } });
    }
  });
});
