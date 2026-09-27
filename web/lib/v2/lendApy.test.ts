import { describe, expect, it } from "vitest";

import type { EarnApy, EarnVault } from "@/lib/v2/api-types";
import { apyFigure, lendApyView, morphoVaultUrl } from "./lendApy";

const VAULT = "0xf7d21652473014d1Ca0e22FF75420494cdd09164";
const VENUE = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const measured = (bps: number): EarnApy => ({ bps, reason: null, from: 1_789_581_600, to: 1_790_186_400 });
const short: EarnApy = { bps: null, reason: "short-history", from: null, to: 1_790_186_400 };

const row = (over: Partial<EarnVault> = {}): EarnVault => ({
  vault: VAULT, asset: null, adapter: "0x0000000000000000000000000000000000000077", fundingEnabled: true, sharesSupply: "1",
  deposited: "1", skimmed: null, indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: false,
  apy7d: measured(412), apy30d: short, totalAssets: "7000000",
  venue: { address: VENUE, name: "Steakhouse USDG", apy24h: measured(520), apy7d: measured(500),
    withdrawable: "5000000", withdrawableSource: "position", position: "5000000" },
  earliestWithdrawal: { kind: "now", at: 1_790_186_400, reason: "liquid", liquidityCap: "6000000" },
  ...over,
});

describe("lendApyView: realised, venue, and the net estimate", () => {
  it("shows realised share-price yield and the venue's own rates with their windows", () => {
    const view = lendApyView({ vault: VAULT, row: row(), skimBps: 1_000, ceilBps: 1_000 });
    if (view.kind !== "figures") throw new Error(view.kind);
    expect(view.realised7d.text).toBe("4.12%");
    expect(view.realised7d.note).toMatch(/^annualised from the last 7 days, measured /);
    // The realised figure is the share-price window. The mark lives only on the net estimate.
    expect(view.realised7d.note).not.toMatch(/high-water|mark/);
    expect(view.venue?.net.note).toMatch(/high-water mark/);
    expect(view.realised30d).toEqual({ text: null, note: "less than 30 days of history so far; no figure until there is" });
    expect(view.venue?.name).toBe("Steakhouse USDG");
    expect(view.venue?.href).toBe(`https://app.morpho.org/robinhood-chain/vault/${VENUE}`);
    expect(view.venue?.apy24h.text).toBe("5.20%");
    expect(view.venue?.apy7d.text).toBe("5.00%");
    expect(view.skimPercent).toBe("10.00%");
  });

  it("computes the net estimate from skimBps AS READ -- a different cut gives a different figure", () => {
    const at10 = lendApyView({ vault: VAULT, row: row(), skimBps: 1_000, ceilBps: 1_000 });
    const at5 = lendApyView({ vault: VAULT, row: row(), skimBps: 500, ceilBps: 1_000 });
    if (at10.kind !== "figures" || at5.kind !== "figures") throw new Error("figures");
    expect(at10.venue?.net.text).toBe("4.50%"); // 5.00% x 0.90
    expect(at5.venue?.net.text).toBe("4.75%"); // 5.00% x 0.95
    expect(at10.venue?.net.note).toMatch(/^estimate: .*10\.00% protocol cut.*high-water mark/);
  });

  it("refuses the estimate when the cut is unread, above its ceiling, or the venue rate is missing", () => {
    const unread = lendApyView({ vault: VAULT, row: row(), skimBps: null, ceilBps: 1_000 });
    const above = lendApyView({ vault: VAULT, row: row(), skimBps: 1_500, ceilBps: 1_000 });
    const noVenueRate = lendApyView({ vault: VAULT, skimBps: 1_000, ceilBps: 1_000,
      row: row({ venue: { ...row().venue!, apy7d: short } }) });
    for (const view of [unread, above, noVenueRate]) {
      if (view.kind !== "figures") throw new Error(view.kind);
      expect(view.venue?.net.text).toBeNull();
    }
    if (unread.kind === "figures") expect(unread.venue?.net.note).toMatch(/could not be read/);
    if (above.kind === "figures") expect(above.venue?.net.note).toMatch(/above its own ceiling/);
    if (noVenueRate.kind === "figures") expect(noVenueRate.venue?.net.note).toMatch(/less than 7 days of history/);
  });

  it("with no venue attached there is no venue rate and no estimate", () => {
    const view = lendApyView({ vault: VAULT, row: row({ venue: null }), skimBps: 1_000, ceilBps: 1_000 });
    if (view.kind !== "figures") throw new Error(view.kind);
    expect(view.venue).toBeNull();
    expect(view.realised7d.text).toBe("4.12%");
  });

  it("refusal states: no vault, and an indexer that does not send the rate yet", () => {
    expect(lendApyView({ vault: null, row: row(), skimBps: 1_000, ceilBps: 1_000 })).toEqual({ kind: "unconfigured" });
    expect(lendApyView({ vault: VAULT, row: null, skimBps: 1_000, ceilBps: 1_000 })).toEqual({ kind: "not-sent" });
    const old = row();
    delete old.apy7d; delete old.apy30d; delete old.venue;
    expect(lendApyView({ vault: VAULT, row: old, skimBps: 1_000, ceilBps: 1_000 })).toEqual({ kind: "not-sent" });
  });

  it("keeps a loss negative and names every null reason", () => {
    expect(apyFigure(measured(-125), "7 days").text).toBe("-1.25%");
    expect(apyFigure({ bps: null, reason: "no-samples", from: null, to: null }, "7 days").note).toBe("no history recorded yet");
    expect(apyFigure({ bps: null, reason: "no-price", from: null, to: null }, "7 days").note).toBe("no share price in that window");
    expect(apyFigure({ bps: null, reason: "out-of-range", from: null, to: null }, "7 days").text).toBeNull();
    expect(apyFigure(undefined, "7 days")).toEqual({ text: null, note: "not reported by this indexer yet" });
    expect(morphoVaultUrl(VENUE)).toBe(`https://app.morpho.org/robinhood-chain/vault/${VENUE}`);
  });
});
