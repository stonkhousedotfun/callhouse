import { encodeErrorResult, toFunctionSelector, type Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { usdgErrorsAbi } from "./abi/erc20";
import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";
import { SOLIDITY_ERROR_SELECTOR, SOLIDITY_PANIC_SELECTOR, decodeRevertData, explainRevert } from "./revert";

/**
 * A revert decodes to a name and a sentence, never to a bare selector. The vault ABI is the
 * generated one (lib/abi/vault.ts), so a library-only error the generator merged in
 * (PremiumBelowFloorAtFill lives in ValoremLib, OfferExceedsCapacity in SeaportOrderLib) must
 * decode too: the fill page's pre-flight depends on exactly that.
 *
 * The SOURCE matters as much as the name: lib/fillPreflight.ts blocks the fill button on a
 * `vault` revert and leaves it on for a `solidity` Error(string) or a USDG shortfall. viem folds
 * Error(string) and Panic(uint256) into every ABI it decodes with, so an attribution that went by
 * "which ABI decoded it" called a token's string revert a vault refusal; the selector decides.
 */
const vault = (errorName: string, args: readonly unknown[] = []): Hex =>
  encodeErrorResult({ abi: vaultAbi as unknown as Abi, errorName, args });
const seaport = (errorName: string, args: readonly unknown[] = []): Hex =>
  encodeErrorResult({ abi: seaportAbi as unknown as Abi, errorName, args });
const usdg = (errorName: string): Hex => encodeErrorResult({ abi: usdgErrorsAbi as unknown as Abi, errorName, args: [] });

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
    const band = decodeRevertData(vault("StrikeBelowBand", [190_000_000n, 195_000_000n]));
    expect(band).toMatchObject({ name: "StrikeBelowBand", source: "vault" });
    // The strike is fixed for the week and approveListing re-checks the same floor, so no reprice
    // clears this: the sentence must not tell a buyer to wait for one.
    expect(band!.text).toContain("this week's strike (190.000000 USDG) is below the vault's minimum of 195.000000 USDG");
    expect(band!.text).toContain("only if spot falls back");
    expect(band!.text).not.toMatch(/keeper|reprice/i);
    // The premium floor IS cleared by a relist at a higher price, and says so.
    expect(decodeRevertData(vault("PremiumBelowFloorAtFill", [856_189n, 860_426n]))!.text).toContain("The keeper reprices");
    expect(decodeRevertData(vault("ContractsAboveUtilization", [24n, 23n]))!.text).toContain("24 written against a maximum of 23");
    expect(decodeRevertData(vault("WriteReturnedWrongClaim", [1n, 2n]))).toMatchObject({ name: "WriteReturnedWrongClaim" });
  });

  it("names the one deposit gate and the stranded-claim errors", () => {
    const closed = decodeRevertData(vault("DepositsClosed"))!.text;
    expect(closed).toContain("Deposits are closed right now");
    // Vault._depositRefused reason 6, the share-price floor, is one a depositor can meet.
    expect(closed).toContain("the book is worth too little per share to sell new shares");
    expect(decodeRevertData(vault("StillStranded"))!.text).toContain("still cannot be redeemed");
    expect(decodeRevertData(vault("NotStranded"))!.text).toBe("No claim is stranded, so there is nothing to retry.");
    // 1_789_000_000 is 2026-09-10T00:26:40Z, 20:26 on the 9th in New York (EDT, UTC−4): the
    // sentence carries the close on both clocks, as every other deadline on the site does.
    expect(decodeRevertData(vault("WriteWindowClosed", [1_789_000_000]))!.text).toContain("2026-09-10 00:26 UTC · 2026-09-09 20:26 EDT");
    expect(decodeRevertData(vault("UsdgLegBlocked", [12_000000n]))!.text).toContain("USDG stays owed");
  });

  it("names Seaport's errors", () => {
    expect(decodeRevertData(seaport("InvalidTime", [1n, 2n]))).toMatchObject({ source: "seaport", name: "InvalidTime" });
    expect(decodeRevertData(seaport("BadFraction"))!.text).toContain("Take fewer contracts");
    expect(decodeRevertData(seaport("InvalidRestrictedOrder", [`0x${"ab".repeat(32)}`]))).toMatchObject({ source: "seaport", name: "InvalidRestrictedOrder" });
  });

  it("attributes Solidity's Error(string) and Panic(uint256) to solidity, by selector, never to the vault", () => {
    const reason = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "reason", type: "string" }] }],
      errorName: "Error",
      args: ["ERC20: transfer amount exceeds allowance"],
    });
    expect(reason.slice(0, 10)).toBe(SOLIDITY_ERROR_SELECTOR);
    expect(decodeRevertData(reason)).toMatchObject({ source: "solidity", name: "Error", text: "Reverted: ERC20: transfer amount exceeds allowance" });
    const panic = encodeErrorResult({
      abi: [{ type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] }],
      errorName: "Panic",
      args: [0x11n],
    });
    expect(panic.slice(0, 10)).toBe(SOLIDITY_PANIC_SELECTOR);
    expect(decodeRevertData(panic)).toMatchObject({ source: "solidity", name: "Panic", text: "The contract hit an internal error (panic code 17)." });
  });

  it("names USDG's own four errors as the token's, with the selectors verified on chain 4663", () => {
    // integrations/usdg.md B1 and B4: ContractPaused 0xab35696f, AddressFrozen 0x1fd1cc44; §4
    // InsufficientFunds 0x356680b7. InsufficientAllowance is derived from the same source tree.
    expect(toFunctionSelector("ContractPaused()")).toBe("0xab35696f");
    expect(toFunctionSelector("AddressFrozen()")).toBe("0x1fd1cc44");
    expect(toFunctionSelector("InsufficientFunds()")).toBe("0x356680b7");
    expect(toFunctionSelector("InsufficientAllowance()")).toBe("0x13be252b");
    expect(decodeRevertData(usdg("ContractPaused"))).toMatchObject({ source: "token", name: "ContractPaused", selector: "0xab35696f" });
    expect(decodeRevertData(usdg("AddressFrozen"))).toMatchObject({ source: "token", name: "AddressFrozen", selector: "0x1fd1cc44" });
    expect(decodeRevertData(usdg("InsufficientFunds"))!.text).toBe("Not enough USDG in the wallet for this fill.");
    expect(decodeRevertData(usdg("InsufficientAllowance"))!.text).toContain("approve step");
  });

  it("no vault, Seaport or USDG error shares a selector with another, so the lookup order cannot misattribute", () => {
    const selectors = new Map<string, string>();
    for (const [label, abi] of [
      ["vault", vaultAbi],
      ["seaport", seaportAbi],
      ["usdg", usdgErrorsAbi],
    ] as const) {
      for (const entry of abi as unknown as Abi) {
        if (entry.type !== "error") continue;
        const sel = toFunctionSelector(`${entry.name}(${entry.inputs.map((i) => i.type).join(",")})`);
        const owner = `${label}:${entry.name}`;
        expect(selectors.get(sel) ?? owner, `${sel} claimed by ${selectors.get(sel)} and ${owner}`).toBe(owner);
        selectors.set(sel, owner);
      }
    }
    expect(selectors.has(SOLIDITY_ERROR_SELECTOR)).toBe(false);
    expect(selectors.has(SOLIDITY_PANIC_SELECTOR)).toBe(false);
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
