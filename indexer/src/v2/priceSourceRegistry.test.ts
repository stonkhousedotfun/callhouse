import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";
import { PRICE_SOURCE_NAMES, PRICE_SOURCE_REGISTRY_KEY, priceSourcesFor } from "./priceSourceRegistry";

const house = "0x1A67948175DFf13426F0d61bfB483579D2ff2EeE";
const other = "0x000000000000000000000000000000000000c011";
const a = "0x00000000000000000000000000000000000000a1";
const b = "0x00000000000000000000000000000000000000b2";

function registry(sources: Record<string, string | null>, deployBlock: number | null = 1000) {
  return { deployBlock, contracts: { clearinghouse: house, sources } };
}

describe("price sources come from the registry and only for the registry's deployment", () => {
  it("registers every non-null source at the registry deploy block", () => {
    const got = priceSourcesFor(house, registry({ chainlink: a, univ3: b, dataStreams: null }));
    expect(got).toEqual({
      startBlock: 1000,
      addresses: { ChainlinkFeedSource: getAddress(a), UniV3TwapSource: getAddress(b) },
    });
  });

  it("matches the clearinghouse case-insensitively", () => {
    expect(priceSourcesFor(house.toLowerCase() as `0x${string}`, registry({ chainlink: a }))?.addresses)
      .toEqual({ ChainlinkFeedSource: getAddress(a) });
  });

  it("registers nothing for another deployment, v1-only mode, or a registry with no sources", () => {
    expect(priceSourcesFor(other, registry({ chainlink: a }))).toBeUndefined();
    expect(priceSourcesFor(undefined, registry({ chainlink: a }))).toBeUndefined();
    expect(priceSourcesFor(house, registry({ chainlink: null, univ3: null, dataStreams: null }))).toBeUndefined();
    expect(priceSourcesFor(house, { deployBlock: 1000, contracts: { clearinghouse: null, sources: { chainlink: a } } }))
      .toBeUndefined();
  });

  it("refuses a zero or malformed address rather than registering a source that indexes nothing", () => {
    expect(() => priceSourcesFor(house, registry({ chainlink: "0x0000000000000000000000000000000000000000" })))
      .toThrow(/sources\.chainlink is the zero address/);
    expect(() => priceSourcesFor(house, registry({ univ3: "0x1234" }))).toThrow(/sources\.univ3="0x1234" is not an address/);
  });

  it("refuses a source with no deploy block rather than scanning from genesis", () => {
    expect(() => priceSourcesFor(house, registry({ chainlink: a }, null))).toThrow(/deployBlock is not a block above zero/);
    expect(() => priceSourcesFor(house, registry({ chainlink: a }, 0))).toThrow(/deployBlock is not a block above zero/);
  });

  it("the compiled registry yields exactly the three addresses ops/markets/tier1.json carries", () => {
    // Mirror, do not re-type: the expected values are read from the source registry file, so this
    // pins the generated module to tier1.json rather than to a number copied into a test.
    const tier1 = JSON.parse(readFileSync(fileURLToPath(new URL("../../../ops/markets/tier1.json", import.meta.url)), "utf8"));
    const got = priceSourcesFor(V2_REGISTRY.contracts.clearinghouse as `0x${string}`, V2_REGISTRY);
    expect(got).toBeDefined();
    expect(got!.startBlock).toBe(tier1.v2.deployBlock);
    for (const name of PRICE_SOURCE_NAMES) {
      const want = tier1.v2.contracts.sources[PRICE_SOURCE_REGISTRY_KEY[name]];
      expect(want, `tier1.json v2.contracts.sources.${PRICE_SOURCE_REGISTRY_KEY[name]}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(got!.addresses[name]).toBe(want);
    }
  });
});
