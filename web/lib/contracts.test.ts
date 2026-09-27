/** lib/contracts.ts: env overrides are validated, never thrown at module scope, and fall back to the registry. */
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GENERATED_MARKETS } from "./markets.generated";

const ENV = [
  "NEXT_PUBLIC_VAULT",
  "NEXT_PUBLIC_FACTORY",
  "NEXT_PUBLIC_ASSET",
  "NEXT_PUBLIC_USDG",
  "NEXT_PUBLIC_CLEARINGHOUSE",
  "NEXT_PUBLIC_SEAPORT",
  "NEXT_PUBLIC_VAULT_FROM_BLOCK",
] as const;

async function load(env: Partial<Record<(typeof ENV)[number], string>>) {
  vi.resetModules();
  for (const name of ENV) vi.stubEnv(name, env[name] ?? "");
  return import("./contracts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const nvda = GENERATED_MARKETS.find((m) => m.ticker === "NVDA")!;

describe("contracts defaults", () => {
  it("uses the registry's NVDA row and the compiled third-party addresses when env is blank", async () => {
    const c = await load({});
    expect(c.VAULT).toBeUndefined();
    expect(c.isVaultConfigured).toBe(false);
    expect(c.FACTORY).toBe(getAddress(nvda.factory!));
    expect(c.ASSET).toBe(getAddress(nvda.asset));
    expect(c.USDG).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(c.CLEARINGHOUSE).toBe("0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6");
    expect(c.SEAPORT).toBe("0x0000000000000068F116a894984e2DB1123eB395");
    expect(c.VAULT_FROM_BLOCK).toBe(0n);
  });

  it("pins the unit constants: USDG 6 dp, asset and shares 18 dp, one lot = 1e18", async () => {
    const c = await load({});
    expect([c.USDG_DECIMALS, c.ASSET_DECIMALS, c.SHARE_DECIMALS]).toEqual([6, 18, 18]);
    expect(c.LOT_SIZE).toBe(10n ** 18n);
    expect(c.ZERO_HASH).toBe(`0x${"0".repeat(64)}`);
    expect(c.ZERO_ADDRESS).toBe(`0x${"0".repeat(40)}`);
  });
});

describe("contracts env overrides", () => {
  it("checksums a valid override (trimmed) and marks the vault configured", async () => {
    const lower = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    const c = await load({ NEXT_PUBLIC_VAULT: `  ${lower}  `, NEXT_PUBLIC_SEAPORT: lower });
    expect(c.VAULT).toBe(getAddress(lower));
    expect(c.isVaultConfigured).toBe(true);
    expect(c.SEAPORT).toBe(getAddress(lower));
  });

  it("logs and falls back to the default for a malformed address instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await load({ NEXT_PUBLIC_USDG: "0x1234", NEXT_PUBLIC_VAULT: "not-an-address" });
    expect(c.USDG).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(c.VAULT).toBeUndefined();
    expect(error).toHaveBeenCalledWith("[contracts] NEXT_PUBLIC_USDG is not an address: 0x1234");
    expect(error).toHaveBeenCalledWith("[contracts] NEXT_PUBLIC_VAULT is not an address: not-an-address");
  });

  it("parses NEXT_PUBLIC_VAULT_FROM_BLOCK and ignores a non-integer", async () => {
    expect((await load({ NEXT_PUBLIC_VAULT_FROM_BLOCK: " 64038234 " })).VAULT_FROM_BLOCK).toBe(64_038_234n);
    expect((await load({ NEXT_PUBLIC_VAULT_FROM_BLOCK: "12abc" })).VAULT_FROM_BLOCK).toBe(0n);
  });
});
