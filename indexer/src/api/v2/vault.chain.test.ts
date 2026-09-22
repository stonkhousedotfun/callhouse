import { beforeEach, describe, expect, it, vi } from "vitest";

const USDG = "0x0000000000000000000000000000000000000001";
const CLEARINGHOUSE = "0x000000000000000000000000000000000000c011";
const VAULT = "0x0000000000000000000000000000000000005016";
const STOCK = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

const state = vi.hoisted(() => ({ calls: [] as any[], step: 0, failStep: null as number | null }));

vi.mock("../../../lib/env", () => ({
  CHAIN_NAME: "robinhood",
  LIVE_READ_TIMEOUT_MS: 1_000,
  USDG: "0x0000000000000000000000000000000000000001",
  V2_CLEARINGHOUSE: "0x000000000000000000000000000000000000c011",
  V2_SETTLEMENT_ORACLE: undefined,
}));
vi.mock("ponder:api", () => ({
  publicClients: {
    robinhood: {
      getBlockNumber: async () => 123n,
      getBlock: async () => ({ timestamp: 100n }),
      multicall: async (options: any) => {
        state.calls.push(options);
        state.step += 1;
        if (state.step === state.failStep) return [{ status: "failure", error: new Error("rpc failed") }];
        if (state.step === 1) return [
          { status: "success", result: {
            maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n,
            askToleranceBps: 100, maxBidBpsOfSpot: 1_000, maxOrderLifetime: 3_600,
            maxDailyOutflow: 2_500_000_000n,
          } },
          { status: "success", result: [500_000_000n, 2_000_000_000n] },
          { status: "success", result: [2n, 4n] },
          { status: "success", result: "0x0000000000000000000000000000000000000001" },
          { status: "success", result: "0x000000000000000000000000000000000000c011" },
          { status: "success", result: "0x000000000000000000000000000000000000b00c" },
        ];
        if (state.step === 2) return [
          { status: "success", result: { underlying: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" } },
          { status: "success", result: { underlying: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" } },
        ];
        if (state.step === 3) return [
          { status: "success", result: 12_000_000n },
          { status: "success", result: 2n * 10n ** 18n },
          { status: "success", result: 3_000_000n },
          { status: "success", result: 10n ** 18n },
          { status: "success", result: [11n, 14n] },
          { status: "success", result: [12n, 13n] },
        ];
        return [{ status: "success", result: [
          { maker: "0x0000000000000000000000000000000000005016", units: 5n, filled: 0n, validUntil: 200, cancelled: false },
          { maker: "0x0000000000000000000000000000000000005016", units: 5n, filled: 1n, validUntil: 200, cancelled: false },
          { maker: "0x0000000000000000000000000000000000005016", units: 5n, filled: 2n, validUntil: 200, cancelled: false },
          { maker: "0x0000000000000000000000000000000000005016", units: 5n, filled: 0n, validUntil: 100, cancelled: false },
        ] }];
      },
    },
  },
}));

import { readMakerVaultState } from "./chain";

beforeEach(() => {
  state.calls.length = 0;
  state.step = 0;
  state.failStep = null;
});

describe("MakerVault live snapshot", () => {
  it("reads balances, all limits, outflow, orders, and series at one block", async () => {
    const live = await readMakerVaultState(VAULT);
    expect(live).toEqual({
      assets: [
        { asset: USDG, wallet: 12_000_000n, ledger: 3_000_000n },
        { asset: STOCK, wallet: 2n * 10n ** 18n, ledger: 10n ** 18n },
      ],
      limits: {
        maxSeriesUnits: 10_000n,
        maxTotalNotional: 250_000_000_000n,
        askToleranceBps: 100,
        maxBidBpsOfSpot: 1_000,
        maxOrderLifetime: 3_600,
        maxDailyOutflow: 2_500_000_000n,
      },
      outflowUsed: 500_000_000n,
      liveOrderCount: 3,
      trackedSeries: [2n, 4n],
    });
    expect(state.calls).toHaveLength(4);
    expect(state.calls.every((call) => call.blockNumber === 123n && call.allowFailure === true)).toBe(true);
  });

  it("fails the whole snapshot when any required multicall fails", async () => {
    state.failStep = 2;
    expect(await readMakerVaultState(VAULT)).toBeNull();
  });
});
