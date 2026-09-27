/** lib/exercise.ts: reading a failed exercise out of viem's error chain, in the words the card shows. */
import {
  BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, RawContractError, encodeErrorResult, type Abi, type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { clearExerciseErrorsAbi } from "./abi/clear";
import { UNDERLYING_PUSH_FAILED, USDG_PULL_FAILED, decodeExerciseRevert, describeExerciseError, explainExerciseRevert, revertDataOf } from "./exercise";

const abi = clearExerciseErrorsAbi as unknown as Abi;
const ERROR_ABI = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as const;

const clearData = (errorName: string, args: readonly unknown[]): Hex => encodeErrorResult({ abi, errorName, args });
const stringData = (reason: string): Hex => encodeErrorResult({ abi: ERROR_ABI, errorName: "Error", args: [reason] });

/** The chain viem builds for a failed simulateContract: execution error wrapping the decoded revert. */
function reverted(data: Hex, errorAbi: Abi = abi): ContractFunctionExecutionError {
  return new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: errorAbi, data, functionName: "exercise" }),
    { abi: errorAbi, functionName: "exercise", args: [] });
}

describe("explainExerciseRevert", () => {
  it("explains an id that is not an option", () => {
    expect(explainExerciseRevert("InvalidOption", [5n])).toBe("That id is not an option on the clearinghouse, so it cannot be exercised.");
  });

  it("names the amount a wallet is short of, and a placeholder when it is missing", () => {
    expect(explainExerciseRevert("CallerHoldsInsufficientOptions", [1n, 3n])).toContain("fewer than 3 of this option");
    expect(explainExerciseRevert("CallerHoldsInsufficientOptions", [1n, 3])).toContain("fewer than 3 of this option");
    expect(explainExerciseRevert("CallerHoldsInsufficientOptions", [1n])).toContain("fewer than ? of this option");
  });

  it("leaves unknown errors to the caller", () => {
    expect(explainExerciseRevert("Unknown", [])).toBeUndefined();
  });
});

describe("revertDataOf", () => {
  it("reads the raw bytes of a decoded revert", () => {
    const data = clearData("InvalidOption", [5n]);
    expect(revertDataOf(reverted(data))).toBe(data);
  });

  it("reads RawContractError data as a string or as a nested { data }", () => {
    const data = clearData("InvalidOption", [5n]);
    expect(revertDataOf(new BaseError("wrap", { cause: new RawContractError({ data }) }))).toBe(data);
    expect(revertDataOf(new BaseError("wrap", { cause: new RawContractError({ data: { data } as never }) }))).toBe(data);
  });

  it("is undefined for a non-viem error or a viem error with no revert bytes", () => {
    expect(revertDataOf(new Error("plain"))).toBeUndefined();
    expect(revertDataOf("oops")).toBeUndefined();
    expect(revertDataOf(new BaseError("network"))).toBeUndefined();
    expect(revertDataOf(new BaseError("wrap", { cause: new RawContractError({}) }))).toBeUndefined();
  });
});

describe("describeExerciseError", () => {
  it("explains a decoded clearinghouse error", () => {
    expect(describeExerciseError(reverted(clearData("InvalidOption", [5n]))))
      .toBe("That id is not an option on the clearinghouse, so it cannot be exercised.");
  });

  it("gives solmate's two strings their meaning", () => {
    expect(describeExerciseError(reverted(stringData(USDG_PULL_FAILED), ERROR_ABI as unknown as Abi)))
      .toContain("could not take the USDG for the strike");
    expect(describeExerciseError(reverted(stringData(UNDERLYING_PUSH_FAILED), ERROR_ABI as unknown as Abi)))
      .toContain("could not send the Stock Token");
  });

  it("decodes raw bytes when viem could not name the error (the ABI it had did not list it)", () => {
    const data = clearData("CallerHoldsInsufficientOptions", [1n, 4n]);
    expect(describeExerciseError(new BaseError("wrap", { cause: new RawContractError({ data }) }))).toContain("fewer than 4");
    expect(describeExerciseError(new BaseError("wrap", { cause: new RawContractError({ data: stringData(USDG_PULL_FAILED) }) })))
      .toContain("could not take the USDG");
  });

  it("stays silent for an unrelated string, a non-viem error or a network failure, so the toast's own text stands", () => {
    expect(describeExerciseError(reverted(stringData("something else"), ERROR_ABI as unknown as Abi))).toBeUndefined();
    expect(describeExerciseError(new Error("User rejected"))).toBeUndefined();
    expect(describeExerciseError(new BaseError("HTTP request failed"))).toBeUndefined();
  });
});

describe("decodeExerciseRevert edge input", () => {
  it("refuses malformed or too-short data", () => {
    expect(decodeExerciseRevert("0x1234" as Hex)).toBeUndefined();
    expect(decodeExerciseRevert("0xzzzzzzzzzz" as Hex)).toBeUndefined();
    expect(decodeExerciseRevert(undefined)).toBeUndefined();
  });
});
