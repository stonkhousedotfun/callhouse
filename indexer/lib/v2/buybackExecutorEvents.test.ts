import { decodeEventLog, encodeAbiParameters, toEventSelector } from "viem";
import { describe, expect, it } from "vitest";

import { buybackExecutorAbi } from "../../abis/v2/buybackExecutor";
import { buybackExecutorEventsAbi, buybackExecutorIndexingAbi } from "./buybackExecutorEvents";

const events = (abi: readonly { type: string }[]) =>
  abi.filter((item): item is (typeof buybackExecutorEventsAbi)[number] => item.type === "event");

describe("buybackExecutorEvents", () => {
  it("declares Bought and Burned with the V4BuybackExecutor signatures", () => {
    expect(buybackExecutorEventsAbi.map((e) => e.name)).toEqual(["Bought", "Burned"]);
    expect(toEventSelector(buybackExecutorEventsAbi[0]))
      .toBe(toEventSelector("Bought(uint256,uint256,uint256,uint256,uint256,uint256,uint256)"));
    expect(toEventSelector(buybackExecutorEventsAbi[1])).toBe(toEventSelector("Burned(uint256)"));
    for (const event of buybackExecutorEventsAbi) {
      expect(event.anonymous).toBe(false);
      expect(event.inputs.every((input) => !input.indexed && input.type === "uint256")).toBe(true);
    }
  });

  it("agrees with the generated ABI wherever the generated ABI already declares the same event", () => {
    const generated = new Map(events(buybackExecutorAbi).map((e) => [e.name, e]));
    for (const event of buybackExecutorEventsAbi) {
      const twin = generated.get(event.name);
      if (twin !== undefined) expect(toEventSelector(twin)).toBe(toEventSelector(event));
    }
  });

  it("the indexing surface is the generated ABI followed by the fragment, in order", () => {
    expect(buybackExecutorIndexingAbi).toEqual([...buybackExecutorAbi, ...buybackExecutorEventsAbi]);
  });

  it("decodes a Bought log's non-indexed amounts in declaration order", () => {
    const values = [1_000_000n, 990_000n, 3n * 10n ** 14n, 5n * 10n ** 20n, 2n * 10n ** 14n, 30n, 28n] as const;
    const log = decodeEventLog({
      abi: buybackExecutorEventsAbi,
      topics: [toEventSelector(buybackExecutorEventsAbi[0])],
      data: encodeAbiParameters(buybackExecutorEventsAbi[0].inputs, values),
    });
    expect(log.eventName).toBe("Bought");
    expect(log.args).toEqual({
      usdgIn: values[0], usdgSpent: values[1], wethOut: values[2], tokenOut: values[3],
      minWethOut: values[4], declaredFeeBps: values[5], measuredFeeBps: values[6],
    });
  });
});
