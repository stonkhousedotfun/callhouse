/** lib/format.ts: the display wrappers, the countdown and progress rail, depositState and redeemQueueView. */
import { describe, expect, it } from "vitest";

import {
  WAD, canSettleQueue, formatAmount, windowProgress, depositState, fmtAsset, fmtCountdown, fmtMultiplier, fmtShares, fmtUsd, fmtUsdPrice, fmtUsdg, fmtUsdgPrice,
  fmtUtcDate, fmtWadPercent, multiplierIsActive, parseAmount, redeemQueueView, scaleToContracts, shortAddress, shortHash, toStockEq,
  tvlUsdg,
} from "./format";

describe("display wrappers keep the units apart", () => {
  it("renders an em dash for a missing value, never a zero", () => {
    for (const fmt of [fmtUsdg, fmtUsdgPrice, fmtAsset, fmtShares, fmtWadPercent]) {
      expect(fmt(undefined)).toBe("—");
      expect(fmt(null)).toBe("—");
    }
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsdPrice(null)).toBe("—");
  });

  it("reads USDG at 6 decimals and the asset and shares at 18", () => {
    expect(fmtUsdg(12_300_000n)).toBe("12.30");
    expect(fmtUsd(12_000_000n)).toBe("$12");
    expect(fmtUsdgPrice(12_000_000n)).toBe("12.00");
    expect(fmtUsdPrice(12_000_000n)).toBe("$12.00");
    expect(fmtAsset(25n * WAD / 10n)).toBe("2.5");
    expect(fmtShares(WAD)).toBe("1");
    // The same raw integer is a million times larger as USDG than as shares.
    expect(fmtShares(12_300_000n)).not.toBe(fmtUsdg(12_300_000n));
  });

  it("formats a WAD share as a percent", () => {
    expect(fmtWadPercent(WAD / 4n)).toBe("25%");
    expect(fmtWadPercent(WAD / 8n)).toBe("12.5%");
  });
});

describe("parseAmount", () => {
  it("rejects a bare dot, signs, exponents and too many decimals", () => {
    for (const bad of [".", "", "  ", "-1", "1e6", "1.2.3", "abc", "1.1234567"]) expect(parseAmount(bad, 6)).toBeNull();
    expect(parseAmount(" 1.5 ", 6)).toBe(1_500_000n);
    expect(parseAmount(".5", 18)).toBe(WAD / 2n);
  });
});

describe("short ids", () => {
  it("abbreviates addresses and hashes, dash for missing", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortHash(`0x${"a".repeat(56)}12345678`)).toBe(`0x${"a".repeat(8)}…12345678`);
    expect(shortAddress(undefined)).toBe("—");
    expect(shortHash("")).toBe("—");
  });
});

describe("uiMultiplier display", () => {
  it("applies the multiplier to the raw balance for display, defaulting to 1.0", () => {
    expect(toStockEq(2n * WAD, WAD * 105n / 100n)).toBe(21n * WAD / 10n);
    expect(toStockEq(2n * WAD, undefined)).toBe(2n * WAD);
    expect(toStockEq(2n * WAD, 0n)).toBeUndefined();
    expect(toStockEq(null, WAD)).toBeUndefined();
  });

  it("is active only for a known multiplier other than 1.0", () => {
    expect(multiplierIsActive(WAD)).toBe(false);
    expect(multiplierIsActive(undefined)).toBe(false);
    expect(multiplierIsActive(WAD + 1n)).toBe(true);
    expect(fmtMultiplier(undefined)).toBe("1");
    expect(fmtMultiplier(WAD * 105n / 100n)).toBe("1.05");
  });
});

describe("scalars", () => {
  it("tvlUsdg multiplies 18-dp assets by a 6-dp spot, and needs both", () => {
    expect(tvlUsdg(10n * WAD, 200_000_000n)).toBe(2_000_000_000n);
    expect(tvlUsdg(undefined, 1n)).toBeUndefined();
    expect(tvlUsdg(1n, undefined)).toBeUndefined();
  });

  it("scaleToContracts divides Valorem's 1e18-scaled counts", () => {
    expect(scaleToContracts(3n * WAD)).toBe(3n);
    expect(scaleToContracts(undefined)).toBeUndefined();
  });
});

describe("fmtUtcDate", () => {
  it("is the UTC calendar day", () => {
    expect(fmtUtcDate(Date.UTC(2026, 8, 18, 23, 59) / 1000)).toBe("18 Sep 2026");
    expect(fmtUtcDate(BigInt(Date.UTC(2026, 0, 1) / 1000))).toBe("1 Jan 2026");
    expect(fmtUtcDate(undefined)).toBe("—");
  });
});

describe("fmtCountdown", () => {
  it("pads hours, minutes and seconds and shows days when there are any", () => {
    expect(fmtCountdown(1_000 + 2 * 86_400 + 4 * 3_600 + 11 * 60 + 7, 1_000)).toBe("2d 04h 11m 07s");
    expect(fmtCountdown(1_065, 1_000)).toBe("00h 01m 05s");
  });

  it("is 'elapsed' once the deadline passes and a dash without one", () => {
    expect(fmtCountdown(1_000, 1_000)).toBe("elapsed");
    expect(fmtCountdown(undefined, 1_000)).toBe("—");
    expect(fmtCountdown(0, 1_000)).toBe("—");
  });
});

describe("depositState", () => {
  const healthy = { phase: 0, totalAssets: 50n * WAD, depositCap: 100n * WAD, depositsOpen: true, totalSupply: 50n * WAD };

  it("is unknown until the phase is read", () => {
    expect(depositState({ depositsOpen: true }, 1_000)).toEqual({ kind: "unknown" });
  });

  it("is open for a healthy idle vault under its cap", () => {
    expect(depositState(healthy, 1_000)).toEqual({ kind: "open" });
    expect(depositState(healthy, 1_000, 5n)).toEqual({ kind: "open" });
  });

  it("names a full cap as capFull, not as a closure", () => {
    expect(depositState({ ...healthy, totalAssets: 100n * WAD, depositsOpen: false }, 1_000))
      .toEqual({ kind: "capFull", cap: 100n * WAD, held: 100n * WAD });
  });

  it("a refusal wins over a full cap", () => {
    expect(depositState({ ...healthy, phase: 3, totalAssets: 100n * WAD }, 1_000)).toEqual({ kind: "closed", reason: "phase" });
  });

  it("is closed without a reason when only the chain's zero (or the account's zero headroom) says so", () => {
    expect(depositState({ ...healthy, depositsOpen: false }, 1_000)).toEqual({ kind: "closed" });
    expect(depositState(healthy, 1_000, 0n)).toEqual({ kind: "closed" });
  });
});

describe("canSettleQueue", () => {
  it("only while Idle, with shares queued in the current epoch", () => {
    const base = { phase: 0, epochId: 4n, queuedShares: 1n, queuedEpoch: 4n };
    expect(canSettleQueue(base)).toBe(true);
    expect(canSettleQueue({ ...base, phase: 1 })).toBe(false);
    expect(canSettleQueue({ ...base, queuedEpoch: 3n })).toBe(false);
    expect(canSettleQueue({ ...base, queuedShares: 0n })).toBe(false);
    expect(canSettleQueue({ ...base, epochId: undefined })).toBe(false);
  });
});

describe("redeemQueueView", () => {
  it("shows nothing for an account with nothing queued, owed or staged", () => {
    expect(redeemQueueView({})).toEqual({ show: false, collectable: false, strandShareWaiting: false, strandShareRecovered: false, usdgLegDeferred: false });
  });

  it("a queued entry shows; a quote makes it collectable", () => {
    expect(redeemQueueView({ queuedShares: 1n })).toMatchObject({ show: true, collectable: false });
    expect(redeemQueueView({ queuedShares: 1n, pendingAssets: 5n })).toMatchObject({ show: true, collectable: true, usdgLegDeferred: false });
  });

  it("a staged strand share waits while its generation is unresolved, and is recovered after (not by isStranded)", () => {
    const staged = { owedStrandWad: 10n, owedStrandGen: 2n };
    expect(redeemQueueView({ ...staged, lastResolvedGen: 1n, isStranded: false })).toMatchObject({ show: true, strandShareWaiting: true, strandShareRecovered: false });
    expect(redeemQueueView({ ...staged, lastResolvedGen: 2n, isStranded: true })).toMatchObject({ show: true, strandShareWaiting: false, strandShareRecovered: true });
    // Generations unread: fall back to isStranded.
    expect(redeemQueueView({ owedStrandWad: 10n, isStranded: true })).toMatchObject({ strandShareWaiting: true });
  });

  it("a settled epoch's strand share waits while that epoch's generation is unresolved", () => {
    const v = { queuedShares: 3n, queuedEpoch: 1n, epochId: 2n, epochStrandWad: 5n, epochStrandGen: 4n, lastResolvedGen: 3n };
    expect(redeemQueueView(v).strandShareWaiting).toBe(true);
    expect(redeemQueueView({ ...v, lastResolvedGen: 4n }).strandShareWaiting).toBe(false);
    // The current epoch has not settled, so there is no epoch share to wait on yet.
    expect(redeemQueueView({ ...v, queuedEpoch: 2n }).strandShareWaiting).toBe(false);
  });

  it("USDG owed with nothing queued and nothing staged is a deferred USDG leg", () => {
    expect(redeemQueueView({ pendingUsdg: 7n })).toMatchObject({ show: true, collectable: true, usdgLegDeferred: true });
    expect(redeemQueueView({ pendingUsdg: 7n, pendingAssets: 1n }).usdgLegDeferred).toBe(false);
    expect(redeemQueueView({ pendingUsdg: 7n, queuedShares: 1n }).usdgLegDeferred).toBe(false);
  });
});

describe("windowProgress", () => {
  it("is the elapsed fraction, clamped to 0..1, and 0 for an empty or broken window", () => {
    expect(windowProgress(100, 200, 150)).toBe(0.5);
    expect(windowProgress(100, 200, 50)).toBe(0);
    expect(windowProgress(100, 200, 500)).toBe(1);
    expect(windowProgress(200, 200, 200)).toBe(0);
    expect(windowProgress(Number.NaN, 200, 150)).toBe(0);
  });
});

describe("formatAmount", () => {
  it("is exact fixed-decimal with thousands separators, truncating (not rounding) the display decimals", () => {
    expect(formatAmount(1_234_567_899_999n, 6, 2)).toBe("1,234,567.89");
    expect(formatAmount(-1_500_000n, 6, 3)).toBe("-1.500");
    expect(formatAmount(12n * WAD, 18, 0)).toBe("12");
    expect(formatAmount(undefined, 6, 2)).toBe("—");
  });
});
