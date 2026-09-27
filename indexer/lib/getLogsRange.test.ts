import { toEventSelector } from "viem";
import { describe, expect, it } from "vitest";

import { ethGetLogsBlockRange, maxAddressesPerGetLogs, RPC_MAX_GET_LOGS_ADDRESS_BLOCKS } from "./getLogsRange";

/** Size eth_getLogs so addresses x blocks stays inside the dRPC backup's measured 200,000. */

/** lib/env.ts ETH_GET_LOGS_BLOCK_RANGE. env.ts throws on import without a deployment env, and env.test.ts pins that
 * ponder.config.ts passes that constant as the cap. */
const CAP = 50_000;

const event = (name: string, input = "address") =>
  ({ type: "event", name, inputs: [{ type: input, name: "x", indexed: true }] }) as const;
const authority = event("AuthorityUpdated");
const transfer = { type: "event", name: "Transfer", inputs: [
  { type: "address", name: "from", indexed: true }, { type: "address", name: "to", indexed: true },
  { type: "uint256", name: "value", indexed: false }] } as const;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const list = (n: number, from = 1) => Array.from({ length: n }, (_, i) => address(from + i));

describe("ethGetLogsBlockRange", () => {
  it("keeps the 50,000 cap for up to four addresses, the product the backup RPC was measured answering", () => {
    for (const n of [0, 1, 2, 3, 4]) expect(ethGetLogsBlockRange(n, CAP)).toBe(50_000);
  });

  it("gives a 5-address source at most 40,000 blocks, and every count stays within the limit", () => {
    expect(ethGetLogsBlockRange(5, CAP)).toBe(40_000);
    for (let n = 1; n <= 400; n++) {
      expect(n * ethGetLogsBlockRange(n, CAP)).toBeLessThanOrEqual(RPC_MAX_GET_LOGS_ADDRESS_BLOCKS);
    }
  });

  it("refuses by count when no range fits", () => {
    expect(ethGetLogsBlockRange(RPC_MAX_GET_LOGS_ADDRESS_BLOCKS, 50_000)).toBe(1);
    expect(() => ethGetLogsBlockRange(RPC_MAX_GET_LOGS_ADDRESS_BLOCKS + 1, 50_000))
      .toThrow(`${RPC_MAX_GET_LOGS_ADDRESS_BLOCKS + 1} addresses in one eth_getLogs request`);
  });
});

describe("maxAddressesPerGetLogs", () => {
  it("counts a single source's address list", () => {
    expect(maxAddressesPerGetLogs({ HouseVault: { abi: [transfer], address: list(5) } }))
      .toEqual({ max: 5, unbounded: [] });
  });

  it("sums sources that share an event selector: Ponder merges their filters into one request", () => {
    const sources = {
      A: { abi: [authority, event("A")], address: address(1) },
      B: { abi: [authority, event("B")], address: address(2) },
      C: { abi: [authority], address: list(3, 10) },
      D: { abi: [event("D")], address: address(20) },
    };
    expect(maxAddressesPerGetLogs(sources)).toEqual({ max: 5, unbounded: [] });
    expect(toEventSelector(authority)).not.toBe(toEventSelector(event("A")));
  });

  it("does not sum sources whose events differ", () => {
    expect(maxAddressesPerGetLogs({
      A: { abi: [event("A")], address: list(3) },
      B: { abi: [event("B")], address: list(4, 10) },
    })).toEqual({ max: 4, unbounded: [] });
  });

  it("names a factory() source whose children it cannot count, and counts the factory addresses", () => {
    const factory = { address: [address(1), address(2)], event: authority, parameter: "x" };
    expect(maxAddressesPerGetLogs({ HouseVault: { abi: [transfer], address: factory } }))
      .toEqual({ max: 2, unbounded: ["HouseVault"] });
  });
});
