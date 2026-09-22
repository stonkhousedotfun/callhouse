import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { V7_DEPLOYMENT, normaliseV7ApiUrl } from "./config";

const REGISTRY_PATH = new URL("../../../ops/markets/v7-legacy.json", import.meta.url);

function loadFrozenRegistry(): {
  v2: { interfaceVersion: number; deployBlock: number; contracts: Record<string, unknown> };
} {
  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(
      `[v7/config.test] the frozen registry is missing at ${REGISTRY_PATH.pathname}; ` +
      "the compiled v7 address pin must be checked against ops/markets/v7-legacy.json",
    );
  }
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

describe("frozen v7 deployment", () => {
  it("matches every compiled value to ops/markets/v7-legacy.json", () => {
    const registry = loadFrozenRegistry();
    expect(V7_DEPLOYMENT).toEqual({
      interfaceVersion: registry.v2.interfaceVersion,
      deployBlock: registry.v2.deployBlock,
      contracts: {
        clearinghouse: registry.v2.contracts.clearinghouse,
        orderBook: registry.v2.contracts.orderBook,
      },
    });
  });

  it("fails closed when the dedicated v7 indexer URL is blank", () => {
    expect(normaliseV7ApiUrl(undefined)).toBeNull();
    expect(normaliseV7ApiUrl("")).toBeNull();
    expect(normaliseV7ApiUrl("   ")).toBeNull();
    expect(normaliseV7ApiUrl(" https://v7.example.test/// ")).toBe("https://v7.example.test");
  });
});
