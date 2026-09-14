import { encodeErrorResult, type Abi } from "viem";
import { describe, expect, it } from "vitest";

import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";
import { FILL_GAS, SIMULATION_GAS, classifyFillSimulation, fillGasSentence, preflightAllowsFill } from "./fillPreflight";

/**
 * What a simulated fill means. Seaport 1.6 validates the order, calls the vault's authorizeOrder,
 * moves the tokens, then calls validateOrder: a vault error blocks, a Seaport pre-hook error
 * blocks, a transfer error means the hook passed and the buyer's USDG approval is what is
 * missing, and anything undecodable is inconclusive and left to the wallet.
 */
const vault = (errorName: string, args: readonly unknown[] = []) =>
  encodeErrorResult({ abi: vaultAbi as unknown as Abi, errorName, args });
const seaport = (errorName: string, args: readonly unknown[] = []) =>
  encodeErrorResult({ abi: seaportAbi as unknown as Abi, errorName, args });
const HASH = `0x${"ab".repeat(32)}` as const;
const ADDR = "0x2222222222222222222222222222222222222222" as const;

describe("classifyFillSimulation", () => {
  it("a passing simulation is ok and allows the fill", () => {
    const v = classifyFillSimulation({ ok: true });
    expect(v).toEqual({ kind: "ok" });
    expect(preflightAllowsFill(v)).toBe(true);
  });

  it("a vault error is a refusal that blocks, with the vault's reason", () => {
    for (const [name, args] of [
      ["PremiumBelowFloorAtFill", [3_000_000n, 4_000_000n]],
      ["StrikeBelowBand", [190_000_000n, 195_000_000n]],
      ["ReserveBreached", [1n, 2n]],
      ["NotLiveListing", [HASH]],
      ["WriteWindowClosed", [1_789_000_000]],
      ["WritesAreHalted", []],
      ["StalePrice", [1n, 2n]],
      ["InventoryLeftBehind", [1n, 0n]],
      ["ContractsAboveUtilization", [24n, 23n]],
    ] as const) {
      const v = classifyFillSimulation({ ok: false, revertData: vault(name, args) });
      expect(v.kind, name).toBe("vaultRefused");
      if (v.kind === "vaultRefused") expect(v.decoded.name).toBe(name);
      expect(preflightAllowsFill(v), name).toBe(false);
    }
  });

  it("a Seaport error from before the hook blocks, with Seaport's reason", () => {
    for (const [name, args] of [
      ["InvalidTime", [1n, 2n]],
      ["OrderIsCancelled", [HASH]],
      ["OrderAlreadyFilled", [HASH]],
      ["BadFraction", []],
      ["InvalidSigner", []],
    ] as const) {
      const v = classifyFillSimulation({ ok: false, revertData: seaport(name, args) });
      expect(v.kind, name).toBe("seaportRefused");
      expect(preflightAllowsFill(v), name).toBe(false);
    }
  });

  it("a zone revert without data (InvalidRestrictedOrder) is a vault refusal whose reason was lost", () => {
    const v = classifyFillSimulation({ ok: false, revertData: seaport("InvalidRestrictedOrder", [HASH]) });
    expect(v.kind).toBe("vaultRefused");
    expect(preflightAllowsFill(v)).toBe(false);
  });

  it("a transfer failure or a token's Error(string) means the hook passed: buyer-side, allowed", () => {
    const transfer = classifyFillSimulation({
      ok: false,
      revertData: seaport("TokenTransferGenericFailure", [ADDR, ADDR, ADDR, 0n, 8_000_000n]),
    });
    expect(transfer.kind).toBe("buyerSide");
    expect(preflightAllowsFill(transfer)).toBe(true);
    const reason = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "reason", type: "string" }] }],
      errorName: "Error",
      args: ["ERC20: insufficient allowance"],
    });
    const str = classifyFillSimulation({ ok: false, revertData: reason });
    expect(str.kind).toBe("buyerSide");
    if (str.kind === "buyerSide") expect(str.decoded.text).toContain("insufficient allowance");
  });

  it("no data, an unknown selector or a panic is inconclusive and allowed, in the message's words", () => {
    const none = classifyFillSimulation({ ok: false, message: "execution reverted" });
    expect(none).toEqual({ kind: "inconclusive", text: "execution reverted" });
    expect(preflightAllowsFill(none)).toBe(true);
    const unknown = classifyFillSimulation({ ok: false, revertData: `0xdeadbeef${"00".repeat(32)}` });
    expect(unknown.kind).toBe("inconclusive");
    if (unknown.kind === "inconclusive") expect(unknown.text).toContain("0xdeadbeef");
    const panic = encodeErrorResult({
      abi: [{ type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] }],
      errorName: "Panic",
      args: [0x11n],
    });
    expect(classifyFillSimulation({ ok: false, revertData: panic }).kind).toBe("inconclusive");
    expect(classifyFillSimulation({ ok: false }).kind).toBe("inconclusive");
    expect(preflightAllowsFill(undefined)).toBe(true);
  });
});

describe("fill gas", () => {
  it("the simulation gas covers a first fill with room, and the sentences name both figures", () => {
    expect(SIMULATION_GAS).toBeGreaterThan(BigInt(FILL_GAS.firstFill.high));
    expect(fillGasSentence(true)).toContain("400k–500k");
    expect(fillGasSentence(true)).toContain("first fill of the cycle");
    expect(fillGasSentence(false)).toContain("160k–250k");
    expect(fillGasSentence(false)).toContain("tops up");
  });
});
