import { describe, expect, it } from "vitest";
import { encodeErrorResult } from "viem";

import { v2ErrorsAbi } from "../abi/v2/v2Errors";
import { explainV2Error, V2_ERROR_TEXT } from "./errors";

describe("v2 revert copy", () => {
  it("covers every custom ABI error with actionable text", () => {
    expect(Object.keys(V2_ERROR_TEXT).sort()).toEqual(v2ErrorsAbi.map((error) => error.name).sort());
    for (const message of Object.values(V2_ERROR_TEXT)) expect(message.length).toBeGreaterThan(20);
  });

  it("decodes v7 stale ask and vault spending reverts", () => {
    expect(explainV2Error({ data: encodeErrorResult({ abi: v2ErrorsAbi, errorName: "InTheMoney" }) })).toMatch(/at or in the money/);
    expect(explainV2Error({ data: encodeErrorResult({ abi: v2ErrorsAbi, errorName: "OutflowCapExceeded", args: [10n, 11n] }) })).toMatch(/spending limit/);
    expect(explainV2Error({ data: encodeErrorResult({ abi: v2ErrorsAbi, errorName: "FeeAboveMax", args: [2n, 1n] }) }))
      .toMatch(/above the maximum you approved/);
  });

  it("decodes a nested on-chain revert and keeps unknown failures generic", () => {
    const data = encodeErrorResult({ abi: v2ErrorsAbi, errorName: "TradingPaused" });
    expect(explainV2Error({ cause: { data } })).toBe(V2_ERROR_TEXT.TradingPaused);
    expect(explainV2Error({ cause: { data: { errorName: "TradingPaused" } } })).toBe(V2_ERROR_TEXT.TradingPaused);
    expect(explainV2Error(new Error("secret RPC internals"))).not.toContain("secret");
  });
});
