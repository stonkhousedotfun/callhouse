import { describe, expect, it, vi } from "vitest";

import { USDG_DECIMALS } from "../contracts";
import { selectTradeSpot } from "./marketSpot";
import { quoteExitZap, quoteWriteZap, writeZap, ZAP_SLIPPAGE_BPS_DEFAULT } from "./zapTx";

const account = "0x0000000000000000000000000000000000000044";
const asset = "0x0000000000000000000000000000000000000055";
const zap = "0x0000000000000000000000000000000000000066";

vi.mock("./config", () => ({
  requireV2Address: (key: string) => {
    if (key !== "stockZap") throw new Error(`unexpected ${key}`);
    throw new Error("V2 stockZap is not deployed in the generated registry");
  },
  V2_DEPLOYMENT: { contracts: { stockZap: null } },
}));

describe("zap minOut", () => {
  const spot = 215_500_000n;
  const spotDecimals = 6;
  const assetDecimals = 18;
  const usdgIn = 215_500_000n;

  it("derives writeZap minOut from the trade-gate spot with the ticket slippage bound", () => {
    const quote = quoteWriteZap(usdgIn, spot, spotDecimals, assetDecimals, ZAP_SLIPPAGE_BPS_DEFAULT, USDG_DECIMALS);
    expect(quote).toEqual({ minOut: 10n ** 18n * 9_800n / 10_000n, slippageBps: 200 });
  });

  it("derives exitZap minOut from the same spot", () => {
    const quote = quoteExitZap(10n ** 18n, spot, spotDecimals, assetDecimals, ZAP_SLIPPAGE_BPS_DEFAULT, USDG_DECIMALS);
    expect(quote).toEqual({ minOut: 211_190_000n, slippageBps: 200 });
  });

  it("refuses a null or zero spot rather than emitting a zero or unbounded minOut", () => {
    expect(quoteWriteZap(usdgIn, null, spotDecimals, assetDecimals)).toBeNull();
    expect(quoteWriteZap(usdgIn, 0n, spotDecimals, assetDecimals)).toBeNull();
    expect(quoteExitZap(10n ** 18n, null, spotDecimals, assetDecimals)).toBeNull();
  });

  it("refuses when selectTradeSpot reports a stale chain fallback", () => {
    const now = 100_000;
    const stale = selectTradeSpot("215500000", true, now - 10_000, 215_500_000n, now - 16_000, false, now);
    expect(stale).toBeNull();
    expect(quoteWriteZap(usdgIn, stale, spotDecimals, assetDecimals)).toBeNull();
    expect(quoteExitZap(10n ** 18n, stale, spotDecimals, assetDecimals)).toBeNull();
  });
});

describe("zap configuration", () => {
  it("refuses a write when the zap address is unconfigured", async () => {
    const context = {
      account,
      wallet: { getChainId: async () => 4663 },
    } as never;
    await expect(writeZap(context, asset, 215_500_000n, 215_500_000n, 6, 18))
      .rejects.toThrow(/stockZap is not deployed/);
  });
});
