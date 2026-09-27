import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Card, PnlResponse } from "@/lib/v2/api-types";
import { imageMoney, liveOptionImageLines, multipleText, pnlShareText, receiptImageCopy, seriesTitle, sharesFromUnits, tokenMetadataText } from "./PnlText";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/pnl/87928758254318692721909164101369622513960639781458875980445111726519827316414-0x4088c59Eb3fB713B124f182E7083AEb3358A030B.json"), "utf8")) as PnlResponse;

describe("PNL copy", () => {
  it("rounds paid cost up and payout down on images", () => {
    expect(imageMoney(fixture.cost, "up")).toBe("1.03");
    expect(imageMoney(fixture.payout, "down")).toBe("4.42");
    expect(receiptImageCopy(fixture)).toMatchObject({
      headline: "1.03 → 4.42 USDG value", multiple: "4.29×", series: "NVDA $210 call", maxLoss: "Max loss was 1.03 USDG",
    });
  });

  it("drops a.00 tail and groups thousands, keeping the rounding direction", () => {
    const usdg6 = (raw: string) => ({ raw, decimals: 6, formatted: "" });
    expect(imageMoney(usdg6("5000000"), "up")).toBe("5");
    expect(imageMoney(usdg6("5000001"), "up")).toBe("5.01");
    expect(imageMoney(usdg6("5009999"), "down")).toBe("5");
    expect(imageMoney(usdg6("1234500000"), "down")).toBe("1,234.50");
    expect(imageMoney(usdg6("0"), "down")).toBe("0");
  });

  it("prints a multiple to at most two decimals with no zero tail", () => {
    expect(multipleText(8)).toBe("8×");
    expect(multipleText(1.1)).toBe("1.1×");
    expect(multipleText(1.04)).toBe("1.04×");
    expect(multipleText(4.545454)).toBe("4.55×");
    expect(multipleText(Number.NaN)).toBe("—");
  });

  it("keeps risk and series identity in sharing and ERC-1155 metadata", () => {
    expect(pnlShareText(fixture)).toContain("Max loss was 1.03 USDG");
    expect(pnlShareText(fixture)).toContain("In-kind Stock Tokens are valued at settlement price");
    expect(seriesTitle(fixture.series)).toBe("NVDA $210 call");
    expect(tokenMetadataText(fixture.series, false)).toMatchObject({ title: expect.stringContaining("· long"),
      description: expect.stringContaining("Maximum loss") });
    expect(tokenMetadataText(fixture.series, true).title).toContain("· short");
    expect(sharesFromUnits("50")).toBe("0.5");
    expect(sharesFromUnits("1000000000000000001")).toBe("10000000000000000.01");
  });

  it("describes a pre-settlement resale without claiming an in-kind payout", () => {
    const resale = { ...fixture, settlementPrice: null,
      series: { ...fixture.series, status: "open" as const } };
    expect(pnlShareText(resale)).toContain("Closed by resale before settlement.");
    expect(pnlShareText(resale)).not.toContain("In-kind Stock Tokens");
  });
});

describe("liveOptionImageLines", () => {
  const usdg = (formatted: string) => ({ raw: String(Math.round(Number(formatted) * 1e6)), decimals: 6, formatted });
  const card = (isPut: boolean, multiple: number): Card => ({
    series: { ...fixture.series, isPut }, spot: null, ask: usdg("1.00"), target: usdg("241.00"),
    perUnit: { cost: usdg("0.011"), payoutAtTarget: usdg("0.05"), multiple: 4.545454 },
    perShare: { cost: usdg("1.10"), payoutAtTarget: usdg("5.00"), multiple }, maxLoss: "cost", unitsAvailable: "100", orderIds: [],
  });

  it("puts the scenario directly under the multiple and the max loss beside it", () => {
    const lines = liveOptionImageLines(card(false, 4.545454));
    expect(lines.metric).toBe("4.55×");
    expect(lines.headline).toBe(`If ${fixture.series.ticker} reaches $241 by expiry`);
    expect(lines.risk).toBe("Max loss is 1.10 USDG for this ticket");
    expect(Object.values(lines).join(" ").toLowerCase()).not.toContain("pays up to");
  });

  it("a put falls to its target; the one-unit ticket is used when there is no full share", () => {
    const lines = liveOptionImageLines({ ...card(true, 3), perShare: null });
    expect(lines.headline).toBe(`If ${fixture.series.ticker} falls to $241 by expiry`);
    expect(lines.metric).toBe("4.55×");
    expect(lines.risk).toBe("Max loss is 0.02 USDG for this ticket");
  });
});
