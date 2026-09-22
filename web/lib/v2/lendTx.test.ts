/**
 * The Earn vault's address resolution.
 *
 * WHAT CHANGED: `earnVaultAddress()` used to `return null` unconditionally. It now resolves through
 * `config.ts` — registry first, then a validated `NEXT_PUBLIC_V2_EARN_VAULT` override, and nothing
 * else. Under design B there is no registry key for it, so in this environment the override is the
 * only path and "no override set" is the unconfigured case production starts from.
 *
 * THE OVERRIDE TESTS RE-IMPORT THE MODULE. `next build` inlines `process.env.NEXT_PUBLIC_*` at
 * build time and `config.ts` reads them once at module scope, so a variable set after import is
 * never seen. `vi.resetModules()` plus a dynamic import is what makes the set value reach the code
 * under test — and if that ever stops being true, these tests fail rather than passing vacuously.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OVERRIDE_ADDRESS_KEYS, V2_ADDRESS_KEYS } from "./config";
import { depositToVault, earnVaultAddress, processVaultQueue, redeemFromVault, requireEarnVaultAddress } from "./lendTx";

const account = "0x0000000000000000000000000000000000000044";
const context = { account, wallet: { getChainId: async () => 4663 } } as never;

/** Lowercase on purpose: a resolver that returns its input unchanged must fail the checksum test. */
const OVERRIDE_LOWER = "0x70556baa315dd8d467ea452abcd7deebea073ff9";
const OVERRIDE_CHECKSUMMED = "0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9";

async function lendTxWithEnv(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", "");
  else vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", value);
  return import("./lendTx");
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("lend vault configuration", () => {
  it("is unconfigured when no override is set, and says which variable would set it", () => {
    expect(earnVaultAddress()).toBeNull();
    expect(() => requireEarnVaultAddress()).toThrow(/earnVault is not deployed/);
    expect(() => requireEarnVaultAddress()).toThrow(/NEXT_PUBLIC_V2_EARN_VAULT/);
  });

  it("refuses writes when the vault address is unconfigured", async () => {
    await expect(depositToVault(context, 1n)).rejects.toThrow(/earnVault is not deployed/);
    await expect(redeemFromVault(context, 1n)).rejects.toThrow(/earnVault is not deployed/);
    await expect(processVaultQueue(context, 1n)).rejects.toThrow(/earnVault is not deployed/);
  });

  it("refuses a zero deposit or redeem before touching the wallet", async () => {
    await expect(depositToVault(context, 0n)).rejects.toThrow(/positive deposit/);
    await expect(redeemFromVault(context, 0n)).rejects.toThrow(/positive share/);
  });
});

describe("the NEXT_PUBLIC_V2_EARN_VAULT override", () => {
  it("makes the vault configured, and checksums the value rather than passing it through", async () => {
    const lendTx = await lendTxWithEnv(OVERRIDE_LOWER);
    expect(lendTx.earnVaultAddress()).toBe(OVERRIDE_CHECKSUMMED);
    expect(lendTx.requireEarnVaultAddress()).toBe(OVERRIDE_CHECKSUMMED);
    // The 2026-09-19 stubbed-viem incident: an identity `checksumAddress` made every assertion
    // written against already-checksummed fixtures pass. This one cannot, because the input is
    // lowercase and the expected value is mixed case.
    expect(OVERRIDE_CHECKSUMMED).not.toBe(OVERRIDE_LOWER);
  });

  it("is REPORTED, not silent — the key is named as override-served", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", OVERRIDE_LOWER);
    const config = await import("./config");
    expect(config.v2AddressOverrides()).toContain("earnVault");
    expect(config.v2AddressProvenanceNotices().join(" ")).toContain("NEXT_PUBLIC_V2_EARN_VAULT");
  });

  it("does NOT pause deposits by announcing itself", async () => {
    // The provenance notice is a separate channel from `v2ConfigWarnings`, which LendVault and
    // TradeTicket use to block. An override that disabled the action it enables would be useless.
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", OVERRIDE_LOWER);
    const config = await import("./config");
    const { configResponseSchema } = await import("./api-schema");
    const fixture = configResponseSchema.parse((await import("../../../ops/fixtures/api/v2/config.json")).default);
    expect(config.v2AddressProvenanceNotices().length).toBeGreaterThan(0);
    expect(config.v2ConfigWarnings(fixture).join(" ")).not.toContain("NEXT_PUBLIC_V2_EARN_VAULT");
    expect(config.v2ConfigWarnings(fixture).join(" ")).not.toContain("earnVault");
  });

  it("a malformed override resolves to null rather than being cast to an address", async () => {
    for (const bad of ["not-an-address", "0x1234", "", "   "]) {
      const lendTx = await lendTxWithEnv(bad);
      expect(lendTx.earnVaultAddress(), bad).toBeNull();
      expect(() => lendTx.requireEarnVaultAddress()).toThrow(/not deployed/);
    }
  });
});

/**
 * THE KEY-SET INVARIANT — spec test 8, restated for design B.
 *
 * It used to read "V2_CONTRACT_NAMES and config.ts addressKeys name the same set". Under design B
 * they MUST differ, by exactly the override-only keys, so the assertion that carries the same
 * weight is: every address key is either registry-backed (in the generator's closed list) or
 * declared override-only. A key in neither is F3 again — present, unfillable, and silently false.
 *
 * It lives in this file rather than in `config.test.ts` only because `config.test.ts` is outside
 * this task's fence; it belongs there and should move when that boundary is granted.
 *
 * IT READS THE GENERATOR AS TEXT ON PURPOSE. `gen-markets.mjs` WRITES FILES at module scope, so
 * importing it from a test would regenerate `lib/markets.generated.ts` as a side effect of running
 * the suite. The regex is given a positive control below so a parse that silently matches nothing
 * fails instead of passing.
 */
describe("the address key set is closed, and every key has a source", () => {
  const source = readFileSync(fileURLToPath(new URL("../../scripts/gen-markets.mjs", import.meta.url)), "utf8");
  const block = source.match(/const V2_CONTRACT_NAMES = \[([\s\S]*?)\];/);
  const generatorNames = (block?.[1]?.match(/"([A-Za-z0-9_]+)"/g) ?? []).map((name) => name.slice(1, -1));

  it("the generator's list was actually parsed — the control for every assertion below", () => {
    // Without this, a renamed const or a reformatted array would make `generatorNames` empty and
    // every "is not in the generator list" assertion below would pass for the wrong reason.
    expect(block, "V2_CONTRACT_NAMES not found in gen-markets.mjs").not.toBeNull();
    expect(generatorNames.length).toBeGreaterThan(5);
    expect(generatorNames).toContain("clearinghouse");
    expect(generatorNames).toContain("rewardsDistributor");
  });

  it("every address key is either registry-backed or declared override-only", () => {
    for (const key of V2_ADDRESS_KEYS) {
      const backed = generatorNames.includes(key) || (OVERRIDE_ADDRESS_KEYS as readonly string[]).includes(key);
      expect(backed, `${key} is in neither the generator list nor the override-only list`).toBe(true);
    }
  });

  it("AC4: the three override-only keys are NOT in the generator's registry list", () => {
    for (const key of OVERRIDE_ADDRESS_KEYS) expect(generatorNames, key).not.toContain(key);
  });

  it("stockZap is still an address key — removing it is the wrong fix (trap T2)", () => {
    expect(V2_ADDRESS_KEYS as readonly string[]).toContain("stockZap");
  });
});

/**
 * REGISTRY FIRST — spec tests 1, 2 and 5. Also placed here only because `config.test.ts` is
 * outside this fence.
 *
 * `stockZap` is the one key that can exercise "registry wins", because it is the only override-only
 * key that also exists in `addressKeys`; the other two have no registry slot at all under design B.
 * The registry value is injected by mocking the GENERATED module, which is the same thing a
 * deployment would change.
 */
describe("a deployed registry value is never shadowed by a stale override", () => {
  const REGISTRY_LOWER = "0x1111111111111111111111111111111111111111";

  afterEach(() => { vi.doUnmock("../markets.generated"); });

  it("prefers the registry, and does not report the key as override-served", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_STOCK_ZAP", OVERRIDE_LOWER);
    vi.doMock("../markets.generated", async (importOriginal) => {
      const original = await importOriginal<typeof import("../markets.generated")>();
      return { ...original, V2_CONTRACTS: { ...original.V2_CONTRACTS, stockZap: REGISTRY_LOWER } };
    });
    const config = await import("./config");
    const resolved = config.resolveV2Address("stockZap");
    expect(resolved.source).toBe("registry");
    expect(resolved.address?.toLowerCase()).toBe(REGISTRY_LOWER);
    expect(resolved.address?.toLowerCase()).not.toBe(OVERRIDE_LOWER);
    expect(config.v2AddressOverrides()).not.toContain("stockZap");
    expect(config.v2AddressProvenanceNotices().join(" ")).not.toContain("NEXT_PUBLIC_V2_STOCK_ZAP");
  });

  it("falls back to the override only where the registry is silent — the control for the test above", async () => {
    // Same setup minus the registry value. If this did not switch to the override, the assertion
    // above would be proving nothing more than "stockZap resolves to something".
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_STOCK_ZAP", OVERRIDE_LOWER);
    const config = await import("./config");
    const resolved = config.resolveV2Address("stockZap");
    expect(resolved.source).toBe("override");
    expect(resolved.address).toBe(OVERRIDE_CHECKSUMMED);
    expect(config.v2AddressOverrides()).toContain("stockZap");
  });

  it("an override that DISAGREES with a published indexer address still blocks", async () => {
    // The one case where an override belongs in the blocking array: the indexer publishes this key
    // and names a different contract. Silence from the indexer is not disagreement and must not
    // block — that is asserted in the deposits test above.
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_STOCK_ZAP", OVERRIDE_LOWER);
    const config = await import("./config");
    const { configResponseSchema } = await import("./api-schema");
    const fixture = configResponseSchema.parse((await import("../../../ops/fixtures/api/v2/config.json")).default);
    const disagrees = { ...fixture, contracts: { ...fixture.contracts, stockZap: REGISTRY_LOWER } };
    expect(config.v2ConfigWarnings(disagrees).join(" ")).toContain("stockZap override does not match");
    const agrees = { ...fixture, contracts: { ...fixture.contracts, stockZap: OVERRIDE_CHECKSUMMED } };
    expect(config.v2ConfigWarnings(agrees).join(" ")).not.toContain("stockZap override does not match");
  });
});
