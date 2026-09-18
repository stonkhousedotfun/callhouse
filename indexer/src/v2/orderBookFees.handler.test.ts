import { describe, expect, it, vi } from "vitest";

import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";
import type { StoredFeeState } from "../../lib/v2/fees";

type Handler = (input: { event: unknown; context: unknown }) => Promise<void>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock("../../lib/registry", () => ({
  v2Ponder: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
}));
vi.mock("ponder:schema", () => ({ default: { v2OrderBookState: "v2OrderBookState" } }));

const ADDRESS = "0x000000000000000000000000000000000000c012";
const day = 86_400n;
const params = {
  premiumFeeBps: 300, resaleFeeBps: 100, takerFeeFlat: 50_000,
  takerFeeCapBps: 900, makerRebateBps: 200,
};

describe("OrderBook:FeeParamsScheduled handler", () => {
  it("stores the schedule with constructor defaults and retains an existing trading pause", async () => {
    await import("./orderBook");
    const handler = handlers.get("OrderBook:FeeParamsScheduled");
    expect(handler).toBeDefined();

    let row: (StoredFeeState & { id: string; tradingPaused: boolean; updatedAt: bigint }) | null = null;
    const context = { db: {
      find: async () => row,
      insert: () => ({ values: (inserted: typeof row) => ({
        onConflictDoUpdate: async (updated: Partial<NonNullable<typeof row>>) => {
          row = row === null ? inserted : { ...row, ...updated };
        },
      }) }),
    } };
    const schedule = async (at: bigint, effectiveAt: bigint, next: typeof params) => {
      await handler!({ event: {
        args: { params: next, effectiveAt }, log: { address: ADDRESS }, block: { timestamp: at },
      }, context });
    };

    await schedule(100n, 100n + day, params);
    expect(row).toMatchObject({ premiumFeeBps: V2_REGISTRY.fees.premiumFeeBps,
      pendingPremiumFeeBps: 300, pendingEffectiveAt: 100n + day });

    // A pause event updates the same row without changing fees. A later schedule must keep it.
    row = { ...row!, tradingPaused: true };
    await schedule(200n, 200n + day, { ...params, premiumFeeBps: 250 });
    expect(row).toMatchObject({ tradingPaused: true,
      premiumFeeBps: V2_REGISTRY.fees.premiumFeeBps,
      pendingPremiumFeeBps: 250, pendingEffectiveAt: 200n + day });
  });
});
