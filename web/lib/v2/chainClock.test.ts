/** The pages' deadline pre-checks run on the chain's clock (lib/v2/chainClock.ts). */
import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import { chainClockOffset, onChainClock, readChainClockOffset } from "./chainClock";

describe("chain clock offset", () => {
  it("is the block timestamp minus the wall clock when the block arrived, in whole seconds", () => {
    expect(chainClockOffset(1_000_090, 1_000_000_999)).toBe(90); // chain 90 s ahead of the browser
    expect(chainClockOffset(999_880, 1_000_000_000)).toBe(-120); // chain 120 s behind
  });

  it("moves a page tick onto the chain's clock, and is null while either is unknown", () => {
    expect(onChainClock(1_000_000, 90)).toBe(1_000_090);
    expect(onChainClock(1_000_000, -120)).toBe(999_880);
    expect(onChainClock(1_000_000, 0)).toBe(1_000_000); // a measured zero is a clock, not "unknown"
    expect(onChainClock(null, 90)).toBeNull();
    expect(onChainClock(1_000_000, null)).toBeNull();
    expect(onChainClock(1_000_000, undefined)).toBeNull();
  });

  it("reads the latest block for the measurement", async () => {
    const getBlock = vi.fn(async () => ({ number: 5n, timestamp: 2_000_060n }));
    expect(await readChainClockOffset({ getBlock } as unknown as PublicClient, () => 2_000_000_000)).toBe(60);
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
  });
});
