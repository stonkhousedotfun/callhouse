import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PnlResponse } from "@/lib/v2/api-types";
import { imageMoney, pnlShareText, receiptImageCopy, seriesTitle, sharesFromUnits, tokenMetadataText } from "./PnlText";

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
