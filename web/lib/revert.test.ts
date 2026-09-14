import { encodeErrorResult, type Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";
import { decodeRevertData, explainRevert } from "./revert";

/**
 * A revert decodes to a name and a sentence, never to a bare selector. The vault ABI is the
 * generated one (lib/abi/vault.ts), so a library-only error the generator merged in
 * (PremiumBelowFloorAtFill lives in ValoremLib, OfferExceedsCapacity in SeaportOrderLib) must
 * decode too: the fill page's pre-flight depends on exactly that.
 */
const vault = (errorName: string, args: readonly unknown[] = []): Hex =>
  encodeErrorResult({ abi: vaultAbi as unknown as Abi, errorName, args });
const seaport = (errorName: string, args: readonly unknown[] = []): Hex =>
  encodeErrorResult({ abi: seaportAbi as unknown as Abi, errorName, args });

describe("decodeRevertData", () => {
  it("names a vault error and formats its figures in USDG", () => {
    const d = decodeRevertData(vault("PremiumBelowFloorAtFill", [3_000_000n, 4_500_000n]));
    expect(d).toMatchObject({ source: "vault", name: "PremiumBelowFloorAtFill" });
    expect(d!.text).toContain("3.000000 USDG");
    expect(d!.text).toContain("4.500000 USDG");
    expect(d!.text).toContain("re-priced");
  });

  it("names the library-only errors the generator merged into the vault ABI", () => {
    expect(decodeRevertData(vault("OfferExceedsCapacity", [30n, 23n]))!.text).toBe(
      "The listing offers 30 contracts but the vault can only write 23 more this cycle.",
    );
    expect(decodeRevertData(vault("StrikeBelowBand", [190_000_000n, 195_000_000n]))).toMatchObject({ name: "StrikeBelowBand", source: "vault" });
    expect(decodeRevertData(vault("ContractsAboveUtilization", [24n, 23n]))!.text).toContain("24 written against a maximum of 23");
    expect(decodeRevertData(vault("WriteReturnedWrongClaim", [1n, 2n]))).toMatchObject({ name: "WriteReturnedWrongClaim" });
  });

  it("names the one deposit gate and the stranded-claim errors", () => {
    expect(decodeRevertData(vault("DepositsClosed"))!.text).toContain("Deposits are closed right now");
    expect(decodeRevertData(vault("StillStranded"))!.text).toContain("still cannot be redeemed");
    expect(decodeRevertData(vault("NotStranded"))!.text).toBe("No claim is stranded, so there is nothing to retry.");
    expect(decodeRevertData(vault("WriteWindowClosed", [1_789_000_000]))!.text).toContain("2026-09-09");
  });

  it("names Seaport's errors and Solidity's Error(string)", () => {
    expect(decodeRevertData(seaport("InvalidTime", [1n, 2n]))).toMatchObject({ source: "seaport", name: "InvalidTime" });
    expect(decodeRevertData(seaport("BadFraction"))!.text).toContain("Take fewer contracts");
    const reason = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "reason", type: "string" }] }],
      errorName: "Error",
      args: ["ERC20: transfer amount exceeds allowance"],
    });
    expect(decodeRevertData(reason)).toMatchObject({ source: "solidity", name: "Error", text: "Reverted: ERC20: transfer amount exceeds allowance" });
  });

  it("reports an unknown selector as unknown, with the selector, and nothing for no data", () => {
    const d = decodeRevertData("0xdeadbeef00000000000000000000000000000000000000000000000000000000");
    expect(d).toMatchObject({ source: "unknown", selector: "0xdeadbeef" });
    expect(d!.name).toBeUndefined();
    expect(d!.text).toContain("0xdeadbeef");
    expect(decodeRevertData(undefined)).toBeUndefined();
    expect(decodeRevertData("0x")).toBeUndefined();
    expect(decodeRevertData("0x1234")).toBeUndefined();
  });
});

describe("explainRevert", () => {
  it("keeps the name and its figures for an error with no translation", () => {
    expect(explainRevert("SomethingNew", [1n, "x"])).toBe("Reverted: SomethingNew (1, x)");
    expect(explainRevert("SomethingNew")).toBe("Reverted: SomethingNew");
  });

  it("translates the ones a depositor hits", () => {
    expect(explainRevert("UseQueue")).toBe("A call is open, so this redemption has to go through the queue.");
    expect(explainRevert("ERC20InsufficientAllowance", [1n, 2n, 3n])).toBe("Approve the vault to move your tokens first.");
  });
});
