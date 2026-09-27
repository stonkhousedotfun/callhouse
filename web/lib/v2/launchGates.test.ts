import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

vi.mock("./config", () => ({ requireV2Address: () => "0x0000000000000000000000000000000000000002" }));

import { GENERATED_MARKETS, LAUNCH_SET } from "../markets.generated";
import { houseDepositsOpen, pendingHouseMarkets, readLaunchGates } from "./launchGates";

describe("launch gates (effects only, no schedule, no clock)", () => {
  it("opens House deposits only on a true arming read; unread, failed and false all stay shut", () => {
    // The only opener: `protocolAccountsConfirmed()` read back true.
    expect(houseDepositsOpen(true)).toBe(true);
    expect(houseDepositsOpen(false)).toBe(false);
    // Fail closed: an unread gate (still loading) or a failed read must not open the control.
    expect(houseDepositsOpen(undefined)).toBe(false);
    expect(houseDepositsOpen(null)).toBe(false);
  });

  it("lists the launch markets whose House vault is not armed; null while unread, never an empty 'all armed'", () => {
    expect(pendingHouseMarkets(undefined)).toBeNull();
    expect(pendingHouseMarkets({})).toEqual([]);
    expect(pendingHouseMarkets({ NVDA: true, SPCX: true })).toEqual([]);
    expect(pendingHouseMarkets({ NVDA: true, SPCX: false })).toEqual(["SPCX"]);
    expect(pendingHouseMarkets({ NVDA: false, SPCX: false })).toEqual(["NVDA", "SPCX"]);
  });

  it("reads market(asset).enabled and protocolAccountsConfirmed() per launch market, and nothing from the AccessManager", async () => {
    const readContract = vi.fn(async ({ functionName, address }: { functionName: string; address: string }) => {
      if (functionName === "market") return { enabled: true };
      if (functionName === "protocolAccountsConfirmed") return address.toLowerCase().startsWith("0xfb5c");
      throw new Error(`unexpected read ${functionName}`);
    });
    const gates = await readLaunchGates({ readContract } as unknown as PublicClient);
    const names = readContract.mock.calls.map(([call]) => call.functionName);
    expect(names).not.toContain("getSchedule");
    expect(new Set(names)).toEqual(new Set(["market", "protocolAccountsConfirmed"]));
    for (const ticker of LAUNCH_SET.markets) expect(gates.trading[ticker]).toBe(true);
    const withVault = LAUNCH_SET.markets.filter((t) => GENERATED_MARKETS.find((m) => m.ticker === t)?.v2.houseVault);
    expect(Object.keys(gates.house).sort()).toEqual([...withVault].sort());
    // The vault read is the registry's: the mock arms only the vault whose address starts 0xfb5c.
    for (const ticker of withVault) {
      const vault = GENERATED_MARKETS.find((m) => m.ticker === ticker)!.v2.houseVault!;
      expect(gates.house[ticker]).toBe(vault.toLowerCase().startsWith("0xfb5c"));
    }
  });

  it("a failed read rejects the whole read, which the caller treats as unread (shut), never as open", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "market") return { enabled: true };
      throw new Error("execution reverted");
    });
    await expect(readLaunchGates({ readContract } as unknown as PublicClient)).rejects.toThrow("execution reverted");
  });
});
