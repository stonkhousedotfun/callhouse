import { encodeErrorResult, type Abi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { clearExerciseErrorsAbi, valoremClearAbi } from "./abi/clear";
import { usdgErrorsAbi } from "./abi/erc20";
import {
  MAX_EXERCISE_AMOUNT,
  NVDA_PUSH_FAILED,
  USDG_PULL_FAILED,
  approvalFor,
  classifyExerciseSimulation,
  clearFee,
  decodeExerciseRevert,
  exerciseAllowed,
  exerciseAmounts,
  exerciseAssetsMatch,
  exerciseButton,
  exerciseSendable,
  exerciseWindow,
  fmtNvdaExact,
  fmtUsdgExact,
  parseContracts,
  spotCheck,
  spotNeedsConfirmation,
  type ExerciseVerdict,
} from "./exercise";

/**
 * Exercising from the cycle page, as pure arithmetic and predicates. Every figure is the
 * clearinghouse's own (ValoremOptionsClearinghouse.exercise at valorem-core 6436c823): the window
 * is `exerciseTimestamp <= t < expiryTimestamp` checked expiry first, the pull is
 * `exerciseAmount × amount` plus a floored fee of at least 1 base unit when the fee switch is on,
 * the push is `underlyingAmount × amount`, and solmate turns a token's refusal into
 * Error("TRANSFER_FROM_FAILED") / Error("TRANSFER_FAILED").
 */

const LOT = 10n ** 18n;
/** A strike of 187.25 USDG per contract, in base units. */
const STRIKE = 187_250_000n;
const EXERCISE_TS = 1_789_761_600; // Fri 2026-09-18 20:00 UTC, the live cycle 1
const EXPIRY_TS = 1_789_848_000; // Sat 2026-09-19 20:00 UTC
const OPTION_ID = 0x1234n << 96n;

const solidityError = (reason: string): Hex =>
  encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ name: "reason", type: "string" }] }] as const,
    errorName: "Error",
    args: [reason],
  });
const clear = (errorName: string, args: readonly unknown[]): Hex =>
  encodeErrorResult({ abi: clearExerciseErrorsAbi as unknown as Abi, errorName, args });
const usdg = (errorName: string): Hex => encodeErrorResult({ abi: usdgErrorsAbi as unknown as Abi, errorName, args: [] });

describe("exerciseWindow", () => {
  const option = { exerciseTs: EXERCISE_TS, expiryTs: EXPIRY_TS };

  it("is unknown until the tuple and the chain's clock have both been read", () => {
    expect(exerciseWindow(undefined, EXERCISE_TS)).toBe("unknown");
    expect(exerciseWindow(option, undefined)).toBe("unknown");
    expect(exerciseWindow(option, 0)).toBe("unknown");
    expect(exerciseWindow({ exerciseTs: EXERCISE_TS }, EXERCISE_TS)).toBe("unknown");
    // An uninitialised type reads expiry 0; the page does not pretend to know its window.
    expect(exerciseWindow({ exerciseTs: 0, expiryTs: 0 }, EXERCISE_TS)).toBe("unknown");
  });

  it("opens exactly at exerciseTimestamp and closes exactly at expiryTimestamp, as the clearinghouse checks", () => {
    expect(exerciseWindow(option, EXERCISE_TS - 1)).toBe("before");
    expect(exerciseWindow(option, EXERCISE_TS)).toBe("open");
    expect(exerciseWindow(option, EXPIRY_TS - 1)).toBe("open");
    expect(exerciseWindow(option, EXPIRY_TS)).toBe("expired");
    expect(exerciseWindow(option, EXPIRY_TS + 3_600)).toBe("expired");
  });

  it("checks expiry first, like the clearinghouse: a degenerate window reads expired, never open", () => {
    expect(exerciseWindow({ exerciseTs: EXPIRY_TS + 10, expiryTs: EXPIRY_TS }, EXPIRY_TS)).toBe("expired");
  });
});

describe("parseContracts", () => {
  it("accepts whole contracts from 1 to the uint112 bound", () => {
    expect(parseContracts("2")).toBe(2n);
    expect(parseContracts(" 17 ")).toBe(17n);
    expect(parseContracts(MAX_EXERCISE_AMOUNT.toString())).toBe(MAX_EXERCISE_AMOUNT);
  });

  it("refuses zero, fractions, signs, words and anything past uint112", () => {
    for (const input of ["", "0", "00", "1.5", "-1", "+1", "1e3", "two", (MAX_EXERCISE_AMOUNT + 1n).toString()]) {
      expect(parseContracts(input), input).toBeUndefined();
    }
  });
});

describe("clearFee and exerciseAmounts", () => {
  it("charges nothing while the fee switch is off", () => {
    expect(clearFee(374_500_000n, false, 5)).toBe(0n);
  });

  it("floors feeBps of the strike cost, and charges 1 base unit when that floors to zero", () => {
    expect(clearFee(374_500_000n, true, 5)).toBe(187_250n); // 374.5 USDG × 5 / 10_000
    expect(clearFee(374_500_001n, true, 5)).toBe(187_250n); // floored, as the clearinghouse floors it
    expect(clearFee(1_999n, true, 5)).toBe(1n);
    expect(clearFee(0n, true, 5)).toBe(1n);
  });

  it("computes the pull and the push exactly, and the total the approval is for", () => {
    expect(exerciseAmounts({ amount: 2n, strikeUsdg: STRIKE, underlyingAmount: LOT, feesEnabled: false, feeBps: 5 })).toEqual({
      strikeCost: 374_500_000n,
      fee: 0n,
      total: 374_500_000n,
      nvdaOut: 2n * LOT,
    });
    expect(exerciseAmounts({ amount: 3n, strikeUsdg: STRIKE, underlyingAmount: LOT, feesEnabled: true, feeBps: 5 })).toEqual({
      strikeCost: 561_750_000n,
      fee: 280_875n,
      total: 562_030_875n,
      nvdaOut: 3n * LOT,
    });
  });

  it("gives no total until the fee switch (and, when on, the fee) has been read", () => {
    const base = { amount: 1n, strikeUsdg: STRIKE, underlyingAmount: LOT };
    expect(exerciseAmounts({ ...base, feesEnabled: undefined, feeBps: 5 })).toBeUndefined();
    expect(exerciseAmounts({ ...base, feesEnabled: true, feeBps: undefined })).toBeUndefined();
    expect(exerciseAmounts({ ...base, feesEnabled: false, feeBps: undefined })?.total).toBe(STRIKE);
    expect(exerciseAmounts({ ...base, amount: undefined, feesEnabled: false, feeBps: 5 })).toBeUndefined();
    expect(exerciseAmounts({ ...base, strikeUsdg: undefined, feesEnabled: false, feeBps: 5 })).toBeUndefined();
  });
});

describe("approvalFor", () => {
  it("approves exactly the total when the allowance is short, and nothing when it covers it", () => {
    expect(approvalFor(0n, 374_500_000n)).toBe(374_500_000n);
    expect(approvalFor(374_499_999n, 374_500_000n)).toBe(374_500_000n);
    expect(approvalFor(374_500_000n, 374_500_000n)).toBe(0n);
    expect(approvalFor(10n ** 30n, 374_500_000n)).toBe(0n);
    expect(approvalFor(undefined, 374_500_000n)).toBeUndefined();
  });
});

describe("spotCheck", () => {
  const two = exerciseAmounts({ amount: 2n, strikeUsdg: STRIKE, underlyingAmount: LOT, feesEnabled: false, feeBps: 5 })!;

  it("is worth it only when spot is strictly above the strike", () => {
    expect(spotCheck(STRIKE + 1n, two)).toBe("worth");
    expect(spotCheck(STRIKE, two)).toBe("notWorth");
    expect(spotCheck(STRIKE - 1n, two)).toBe("notWorth");
  });

  it("counts the clearinghouse's fee when it is on", () => {
    const withFee = exerciseAmounts({ amount: 2n, strikeUsdg: STRIKE, underlyingAmount: LOT, feesEnabled: true, feeBps: 5 })!;
    // Spot above the strike by less than the fee per contract (93,625 base units) is still a loss.
    expect(spotCheck(STRIKE + 93_625n, withFee)).toBe("notWorth");
    expect(spotCheck(STRIKE + 93_626n, withFee)).toBe("worth");
  });

  it("compares without rounding: a sub-unit lot is valued exactly", () => {
    const half = { nvdaOut: LOT / 2n, total: 100_000_000n };
    expect(spotCheck(200_000_000n, half)).toBe("notWorth"); // 0.5 × 200 = 100, not above 100
    expect(spotCheck(200_000_001n, half)).toBe("worth");
  });

  it("is unknown when spot is missing or zero, and anything but worth asks for a confirmation", () => {
    expect(spotCheck(undefined, two)).toBe("unknown");
    expect(spotCheck(0n, two)).toBe("unknown");
    expect(spotCheck(STRIKE + 1n, undefined)).toBe("unknown");
    expect(spotNeedsConfirmation("worth")).toBe(false);
    expect(spotNeedsConfirmation("notWorth")).toBe(true);
    expect(spotNeedsConfirmation("unknown")).toBe(true);
  });
});

describe("exerciseAssetsMatch", () => {
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
  const ASSET = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
  it("requires USDG in and NVDA out, case-insensitively, and waits for the tuple", () => {
    expect(exerciseAssetsMatch({ exerciseAsset: USDG.toLowerCase() as Address, underlyingAsset: ASSET }, { usdg: USDG, asset: ASSET })).toBe(true);
    expect(exerciseAssetsMatch({ exerciseAsset: ASSET, underlyingAsset: USDG }, { usdg: USDG, asset: ASSET })).toBe(false);
    expect(exerciseAssetsMatch(undefined, { usdg: USDG, asset: ASSET })).toBeUndefined();
  });
});

describe("formatting", () => {
  it("shows USDG to all 6 decimals", () => {
    expect(fmtUsdgExact(374_500_000n)).toBe("374.500000");
    expect(fmtUsdgExact(562_030_875n)).toBe("562.030875");
    expect(fmtUsdgExact(1_234_567_890_123n)).toBe("1,234,567.890123");
    expect(fmtUsdgExact(undefined)).toBe("—");
  });

  it("shows NVDA to full precision with trailing zeros trimmed", () => {
    expect(fmtNvdaExact(LOT)).toBe("1");
    expect(fmtNvdaExact(2n * LOT)).toBe("2");
    expect(fmtNvdaExact(25n * 10n ** 17n)).toBe("2.5");
    expect(fmtNvdaExact(1n)).toBe("0.000000000000000001");
    expect(fmtNvdaExact(1_234n * LOT + 1n)).toBe("1,234.000000000000000001");
    expect(fmtNvdaExact(undefined)).toBe("—");
  });
});

describe("the Clear ABI", () => {
  it("carries exercise(uint256,uint112) and its four errors for the wallet and the decoder", () => {
    const exercise = valoremClearAbi.find((e) => e.type === "function" && e.name === "exercise");
    expect(exercise).toMatchObject({ inputs: [{ type: "uint256" }, { type: "uint112" }], stateMutability: "nonpayable" });
    for (const name of ["InvalidOption", "ExpiredOption", "ExerciseTooEarly", "CallerHoldsInsufficientOptions"]) {
      expect(valoremClearAbi.some((e) => e.type === "error" && e.name === name), name).toBe(true);
    }
  });
});

describe("decodeExerciseRevert", () => {
  it("names the clearinghouse's errors with their figures", () => {
    const early = decodeExerciseRevert(clear("ExerciseTooEarly", [OPTION_ID, EXERCISE_TS]));
    expect(early).toMatchObject({ source: "clear", name: "ExerciseTooEarly" });
    expect(early!.text).toContain("2026-09-18 20:00 UTC · 2026-09-18 16:00 EDT");
    const expired = decodeExerciseRevert(clear("ExpiredOption", [OPTION_ID, EXPIRY_TS]));
    expect(expired).toMatchObject({ source: "clear", name: "ExpiredOption" });
    expect(expired!.text).toContain("2026-09-19 20:00 UTC");
    expect(decodeExerciseRevert(clear("CallerHoldsInsufficientOptions", [OPTION_ID, 6n]))!.text).toContain("fewer than 6");
    expect(decodeExerciseRevert(clear("InvalidOption", [OPTION_ID]))).toMatchObject({ source: "clear", name: "InvalidOption" });
  });

  it("gives solmate's two strings their meaning, and passes everything else through lib/revert.ts", () => {
    expect(decodeExerciseRevert(solidityError(USDG_PULL_FAILED))!.text).toContain("could not take the USDG");
    expect(decodeExerciseRevert(solidityError(NVDA_PUSH_FAILED))!.text).toContain("could not send the NVDA Stock Token");
    expect(decodeExerciseRevert(solidityError("something else"))).toMatchObject({ source: "solidity", text: "Reverted: something else" });
    expect(decodeExerciseRevert(usdg("ContractPaused"))).toMatchObject({ source: "token", name: "ContractPaused" });
    expect(decodeExerciseRevert("0xdeadbeef")).toMatchObject({ source: "unknown" });
    expect(decodeExerciseRevert(undefined)).toBeUndefined();
    expect(decodeExerciseRevert("0x")).toBeUndefined();
  });
});

describe("classifyExerciseSimulation", () => {
  const total = 374_500_000n;
  const funded = { total, usdgBalance: total, allowance: total };
  const unapproved = { total, usdgBalance: total, allowance: 0n };

  it("a passing simulation is ok, allowed and sendable", () => {
    const v = classifyExerciseSimulation({ ok: true }, funded);
    expect(v).toEqual({ kind: "ok" });
    expect(exerciseAllowed(v)).toBe(true);
    expect(exerciseSendable(v)).toBe(true);
  });

  it("a clearinghouse error blocks, with its reason", () => {
    for (const [name, args] of [
      ["ExerciseTooEarly", [OPTION_ID, EXERCISE_TS]],
      ["ExpiredOption", [OPTION_ID, EXPIRY_TS]],
      ["CallerHoldsInsufficientOptions", [OPTION_ID, 9n]],
      ["InvalidOption", [OPTION_ID]],
    ] as const) {
      const v = classifyExerciseSimulation({ ok: false, revertData: clear(name, args) }, funded);
      expect(v.kind, name).toBe("clearRefused");
      if (v.kind === "clearRefused") expect(v.decoded.name).toBe(name);
      expect(exerciseAllowed(v), name).toBe(false);
    }
  });

  it("a failed USDG pull is read off the figures: short balance blocks, short allowance goes to the approval, neither is the token refusing", () => {
    const data = solidityError(USDG_PULL_FAILED);
    const short = classifyExerciseSimulation({ ok: false, revertData: data }, { total, usdgBalance: total - 1n, allowance: 0n });
    expect(short.kind).toBe("usdgShort");
    expect(exerciseAllowed(short)).toBe(false);

    const approve = classifyExerciseSimulation({ ok: false, revertData: data }, unapproved);
    expect(approve.kind).toBe("needsApproval");
    expect(exerciseAllowed(approve)).toBe(true);
    // Once the approval has been sent, the same result must not send the exercise.
    expect(exerciseSendable(approve)).toBe(false);

    const refused = classifyExerciseSimulation({ ok: false, revertData: data }, funded);
    expect(refused.kind).toBe("tokenRefused");
    expect(exerciseAllowed(refused)).toBe(false);
  });

  it("a failed NVDA push, or USDG paused or frozen, blocks as a token refusal", () => {
    expect(classifyExerciseSimulation({ ok: false, revertData: solidityError(NVDA_PUSH_FAILED) }, funded).kind).toBe("tokenRefused");
    expect(classifyExerciseSimulation({ ok: false, revertData: usdg("ContractPaused") }, funded).kind).toBe("tokenRefused");
    expect(classifyExerciseSimulation({ ok: false, revertData: usdg("AddressFrozen") }, funded).kind).toBe("tokenRefused");
  });

  it("USDG's own shortfall names map like solmate's string", () => {
    expect(classifyExerciseSimulation({ ok: false, revertData: usdg("InsufficientFunds") }, funded).kind).toBe("usdgShort");
    expect(classifyExerciseSimulation({ ok: false, revertData: usdg("InsufficientAllowance") }, unapproved).kind).toBe("needsApproval");
  });

  it("anything else is inconclusive: allowed, and left to the wallet", () => {
    const none = classifyExerciseSimulation({ ok: false, message: "  rate limited  " }, funded);
    expect(none).toEqual({ kind: "inconclusive", text: "rate limited" });
    expect(exerciseAllowed(none)).toBe(true);
    expect(exerciseSendable(none)).toBe(true);
    expect(classifyExerciseSimulation({ ok: false }, funded)).toEqual({ kind: "inconclusive", text: "The simulation failed without a revert reason." });
    expect(classifyExerciseSimulation({ ok: false, revertData: "0xdeadbeef" }, funded).kind).toBe("inconclusive");
    expect(exerciseAllowed(undefined)).toBe(false);
    expect(exerciseSendable(undefined)).toBe(false);
  });
});

describe("exerciseButton", () => {
  const amounts = exerciseAmounts({ amount: 2n, strikeUsdg: STRIKE, underlyingAmount: LOT, feesEnabled: false, feeBps: 5 })!;
  const ok: ExerciseVerdict = { kind: "ok" };
  const live = {
    busy: false,
    connected: true,
    onChain: true,
    window: "open" as const,
    assetsMatch: true,
    optionBalance: 5n,
    amount: 2n,
    amounts,
    usdgBalance: amounts.total,
    allowance: 0n,
    verdict: ok,
    needsConfirmation: false,
    confirmed: false,
  };

  it("is live inside the window on an allowing verdict, and names the amount", () => {
    expect(exerciseButton(live)).toEqual({ enabled: true, label: "Exercise 2 contracts" });
    expect(exerciseButton({ ...live, amount: 1n })).toMatchObject({ enabled: true, label: "Exercise 1 contract" });
    expect(exerciseButton({ ...live, verdict: { kind: "needsApproval" } }).enabled).toBe(true);
  });

  it("is off outside the window, whatever else holds", () => {
    for (const window of ["before", "expired", "unknown"] as const) {
      expect(exerciseButton({ ...live, window }), window).toMatchObject({ enabled: false, blocker: "window" });
    }
  });

  it("waits for every read, a valid amount within the balance, enough USDG and a verdict", () => {
    expect(exerciseButton({ ...live, connected: false })).toMatchObject({ enabled: false, blocker: "notConnected" });
    expect(exerciseButton({ ...live, onChain: false })).toMatchObject({ enabled: false, blocker: "wrongNetwork" });
    expect(exerciseButton({ ...live, assetsMatch: false })).toMatchObject({ enabled: false, blocker: "assets" });
    expect(exerciseButton({ ...live, assetsMatch: undefined })).toMatchObject({ enabled: false, blocker: "reading" });
    expect(exerciseButton({ ...live, optionBalance: undefined })).toMatchObject({ enabled: false, blocker: "reading" });
    expect(exerciseButton({ ...live, amount: undefined })).toMatchObject({ enabled: false, blocker: "noAmount", label: "Exercise" });
    expect(exerciseButton({ ...live, amount: 6n })).toMatchObject({ enabled: false, blocker: "overBalance" });
    expect(exerciseButton({ ...live, amounts: undefined })).toMatchObject({ enabled: false, blocker: "reading" });
    expect(exerciseButton({ ...live, allowance: undefined })).toMatchObject({ enabled: false, blocker: "reading" });
    expect(exerciseButton({ ...live, usdgBalance: amounts.total - 1n })).toMatchObject({ enabled: false, blocker: "usdgShort" });
    expect(exerciseButton({ ...live, verdict: undefined })).toMatchObject({ enabled: false, blocker: "simulating" });
  });

  it("is off on a refusing verdict", () => {
    const refused: ExerciseVerdict = {
      kind: "clearRefused",
      decoded: { source: "clear", name: "ExpiredOption", args: [], selector: "0x00000000", text: "expired" },
    };
    expect(exerciseButton({ ...live, verdict: refused })).toMatchObject({ enabled: false, blocker: "refused" });
    expect(exerciseButton({ ...live, verdict: { kind: "usdgShort" } })).toMatchObject({ enabled: false, blocker: "usdgShort" });
  });

  it("needs the explicit confirmation when spot does not show the exercise is worth it", () => {
    expect(exerciseButton({ ...live, needsConfirmation: true })).toMatchObject({ enabled: false, blocker: "confirm" });
    expect(exerciseButton({ ...live, needsConfirmation: true, confirmed: true })).toMatchObject({ enabled: true });
  });

  it("is off and says so while a transaction is in flight", () => {
    expect(exerciseButton({ ...live, busy: true })).toEqual({ enabled: false, label: "Working…", blocker: "busy" });
  });
});
