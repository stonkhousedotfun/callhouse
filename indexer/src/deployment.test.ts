/**
 * lib/deployment.ts: the vault settings the constructor sets without an event, which the
 * `Vault:setup` handler seeds from views at START_BLOCK. Found by the X-11 fork sync: /v1/vault
 * published `protocolFeeBps: 0` and `feeRecipient: null` for a vault charging 500 bps to a real
 * recipient, because `PolicyUpdated` / `FeeRecipientUpdated` / `DepositCapUpdated` never fired.
 */
import { describe, expect, it } from "vitest";

import { constructorSettings, type PolicyTuple } from "../lib/deployment";

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
