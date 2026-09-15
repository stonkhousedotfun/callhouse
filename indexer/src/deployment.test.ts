/**
 * lib/deployment.ts: the vault settings the constructor sets without an event, which the
 * `Vault:setup` handler seeds from views at START_BLOCK. Found by the X-11 fork sync: /v1/vault
 * published `protocolFeeBps: 0` and `feeRecipient: null` for a vault charging 500 bps to a real
 * recipient, because `PolicyUpdated` / `FeeRecipientUpdated` / `DepositCapUpdated` never fired.
 *
 * And the wiring check both `Vault:setup` and `Vault:RollOpen` make: the vault's `clear()`,
 * `seaport()`, `usdg()` and `asset()` against the env. Found in review: with the default
 * CLEARINGHOUSE left in place on a vault built over our own Clear, every fill counted 0 contracts
 * and nothing stopped the indexer.
 */
import { describe, expect, it } from "vitest";

import { checkWiring, constructorSettings, wiringError, type PolicyTuple } from "../lib/deployment";

const LAUNCH_POLICY: PolicyTuple = [300, 1200, 40, 9500, 500, 50n];
const FEE_SAFE = "0x506B221371D254C6d7A523E74f61148c4844EE1e";

describe("constructorSettings", () => {
  it("takes protocolFeeBps from policy() (index 4), and the recipient and cap verbatim", () => {
    expect(
      constructorSettings({ policy: LAUNCH_POLICY, feeRecipient: FEE_SAFE, depositCap: 50n * 10n ** 18n }),
    ).toEqual({ protocolFeeBps: 500, feeRecipient: FEE_SAFE, depositCap: 50_000000000000000000n });
  });

  it("seeds nothing it could not read, so the schema default stands rather than a guess", () => {
    expect(constructorSettings({ policy: null, feeRecipient: null, depositCap: null })).toEqual({});
    expect(constructorSettings({ policy: null, feeRecipient: FEE_SAFE, depositCap: null })).toEqual({ feeRecipient: FEE_SAFE });
  });

  it("treats a zero fee recipient as no vault at that block: the constructor reverts on zero", () => {
    expect(
      constructorSettings({ policy: LAUNCH_POLICY, feeRecipient: "0x0000000000000000000000000000000000000000", depositCap: 0n }),
    ).toEqual({ protocolFeeBps: 500, depositCap: 0n });
  });
});

describe("checkWiring (Vault:setup and Vault:RollOpen refuse a vault built over other contracts)", () => {
  // The env defaults in lib/env.ts: the upstream Clear, Seaport 1.6, USDG and the NVDA Stock Token.
  const ENV = {
    CLEARINGHOUSE: "0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0",
    SEAPORT: "0x0000000000000068F116a894984e2DB1123eB395",
    USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    ASSET: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  } as const;
  /** A vault deployed over our own DeployClear.s.sol instance. */
  const OUR_CLEAR = "0x1111111111111111111111111111111111111111";

  it("passes when every view names the env's address, whatever the case", () => {
    const reads = { clear: ENV.CLEARINGHOUSE.toLowerCase() as `0x${string}`, seaport: ENV.SEAPORT, usdg: ENV.USDG, asset: ENV.ASSET };
    expect(checkWiring(reads, ENV)).toEqual({ mismatches: [], unverified: [] });
  });

  it("names the default CLEARINGHOUSE left in place on a DeployClear vault", () => {
    const check = checkWiring({ clear: OUR_CLEAR, seaport: ENV.SEAPORT, usdg: ENV.USDG, asset: ENV.ASSET }, ENV);
    expect(check.mismatches).toEqual([`CLEARINGHOUSE=${ENV.CLEARINGHOUSE} but vault.clear() = ${OUR_CLEAR}`]);
    expect(check.unverified).toEqual([]);
    const err = wiringError("0x000000000000000000000000000000000000c0de", check.mismatches);
    expect(err.message).toContain("vault 0x000000000000000000000000000000000000c0de was not built against");
    expect(err.message).toContain(`vault.clear() = ${OUR_CLEAR}`);
    expect(err.message).toContain("re-sync from START_BLOCK");
  });

  it("reports every wrong address at once, not the first", () => {
    const check = checkWiring({ clear: OUR_CLEAR, seaport: ENV.SEAPORT, usdg: "0x2222222222222222222222222222222222222222", asset: ENV.ASSET }, ENV);
    expect(check.mismatches).toHaveLength(2);
    expect(check.mismatches[1]).toBe(`USDG=${ENV.USDG} but vault.usdg() = 0x2222222222222222222222222222222222222222`);
  });

  it("a view that did not answer (START_BLOCK before the deploy) is unverified, not a mismatch", () => {
    expect(checkWiring({ clear: null, seaport: null, usdg: null, asset: null }, ENV)).toEqual({
      mismatches: [],
      unverified: ["clear", "seaport", "usdg", "asset"],
    });
  });
});
