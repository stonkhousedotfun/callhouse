import { encodeErrorResult, type Abi } from "viem";
import { describe, expect, it } from "vitest";

import { usdgErrorsAbi } from "./abi/erc20";
import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";
import { FILL_GAS, SIMULATION_GAS, classifyFillSimulation, fillGasSentence, preflightAllowsFill } from "./fillPreflight";

/**
 * What a simulated fill means. Seaport 1.6 validates the order, calls the vault's authorizeOrder,
 * moves the tokens, then calls validateOrder: a vault error blocks, a Seaport pre-hook error
 * blocks, a transfer error means the hook passed and the buyer's USDG approval is what is
 * missing, USDG paused or frozen blocks without blaming the vault, and anything undecodable is
 * inconclusive and left to the wallet.
 */
const vault = (errorName: string, args: readonly unknown[] = []) =>
  encodeErrorResult({ abi: vaultAbi as unknown as Abi, errorName, args });
const seaport = (errorName: string, args: readonly unknown[] = []) =>
  encodeErrorResult({ abi: seaportAbi as unknown as Abi, errorName, args });
const usdg = (errorName: string) => encodeErrorResult({ abi: usdgErrorsAbi as unknown as Abi, errorName, args: [] });
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
      ["OraclePaused", []],
      ["InventoryLeftBehind", [1n, 0n]],
      ["ContractsAboveUtilization", [24n, 23n]],
      ["ContractsAboveCap", [51n, 50n]],
      ["ValoremFeeNotAccepted", [15]],
      // The vault's own SafeERC20 wrapper failing on the Stock Token approve inside the hook.
      ["SafeERC20FailedOperation", [ADDR]],
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

  it("USDG's own shortfalls are buyer-side; a USDG pause or freeze is a token refusal that blocks", () => {
    // The placeholder-fulfiller simulation ends here on the real token: 0xdead holds no USDG and
    // has approved nothing, so USDG reverts at Seaport's transfer step, AFTER the hook passed.
    for (const name of ["InsufficientAllowance", "InsufficientFunds"]) {
      const v = classifyFillSimulation({ ok: false, revertData: usdg(name) });
      expect(v.kind, name).toBe("buyerSide");
      expect(preflightAllowsFill(v), name).toBe(true);
    }
    for (const name of ["ContractPaused", "AddressFrozen"]) {
      const v = classifyFillSimulation({ ok: false, revertData: usdg(name) });
      expect(v.kind, name).toBe("tokenRefused");
      if (v.kind === "tokenRefused") expect(v.decoded.name).toBe(name);
      expect(preflightAllowsFill(v), name).toBe(false);
    }
  });

  it("OpenZeppelin's ERC-20 shortfalls decode from the vault ABI but are a token's through a fill: buyer-side", () => {
    // The vault is an ERC-20 (its shares), so Vault.json carries these names; no share moves in a
    // fill and the hook never calls the vault's own transfer path, so through a fill they can
    // only come from a token at the transfer step.
    const allowance = classifyFillSimulation({ ok: false, revertData: vault("ERC20InsufficientAllowance", [ADDR, 0n, 8_000_000n]) });
    expect(allowance.kind).toBe("buyerSide");
    expect(preflightAllowsFill(allowance)).toBe(true);
    const balance = classifyFillSimulation({ ok: false, revertData: vault("ERC20InsufficientBalance", [ADDR, 0n, 8_000_000n]) });
    expect(balance.kind).toBe("buyerSide");
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
  });

  it("no verdict yet is not a pass: the button waits for the simulation of the exact fill", () => {
    // A new quantity or a wallet connecting keys a fresh query whose data is undefined until the
    // eth_call returns. Allowing that let a buyer send approve(SEAPORT, cost) after a rally for a
    // fill the vault was about to refuse with PremiumBelowFloorAtFill.
    expect(preflightAllowsFill(undefined)).toBe(false);
    // The same size, once simulated, decides on its verdict alone.
    const refused = classifyFillSimulation({ ok: false, revertData: vault("PremiumBelowFloorAtFill", [856_189n, 860_426n]) });
    expect(preflightAllowsFill(refused)).toBe(false);
    expect(preflightAllowsFill(classifyFillSimulation({ ok: true }))).toBe(true);
  });
});

describe("fill gas", () => {
  // Whole-transaction receipts from the keeper's fork dry run (keeper/DRYRUN.md): real Seaport 1.6
  // fills of the vault's order through the real Clear on a 4663 fork. The last first fill ran with
  // Valorem's engine fee on.
  const FIRST_FILL_RECEIPTS = [445_577, 450_181, 462_677, 462_701, 476_071];
  const TOP_UP_RECEIPTS = [276_627, 288_951, 289_157];

  it("every measured receipt sits inside its range, and the simulation gas covers the highest", () => {
    for (const g of FIRST_FILL_RECEIPTS) {
      expect(g, `first fill ${g}`).toBeGreaterThanOrEqual(FILL_GAS.firstFill.low);
      expect(g, `first fill ${g}`).toBeLessThanOrEqual(FILL_GAS.firstFill.high);
    }
    for (const g of TOP_UP_RECEIPTS) {
      expect(g, `top-up ${g}`).toBeGreaterThanOrEqual(FILL_GAS.topUp.low);
      expect(g, `top-up ${g}`).toBeLessThanOrEqual(FILL_GAS.topUp.high);
    }
    expect(SIMULATION_GAS).toBeGreaterThan(BigInt(FILL_GAS.firstFill.high));
  });

  it("the sentences name both ranges: 440k–500k for a first fill, 270k–320k for a top-up", () => {
    expect(fillGasSentence(true)).toContain("440k–500k");
    expect(fillGasSentence(true)).toContain("first fill of the cycle");
    expect(fillGasSentence(true)).toContain("Later fills cost about 270k–320k.");
    expect(fillGasSentence(false)).toContain("270k–320k");
    expect(fillGasSentence(false)).toContain("tops up");
    // The contracts suite's in-test figure is not a receipt and must not be what a buyer reads.
    expect(fillGasSentence(false)).not.toContain("150k");
  });
});
