import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cardsResponseSchema, marketsResponseSchema } from "./api-schema";
import { marketQuoteAsOf, selectTradeSpot } from "./marketSpot";
import { resetDisplayCache, resolveDisplaySpot } from "./displaySpot";
import { payoffCardView } from "./payoffCard";

const fixture = fileURLToPath(new URL("../../../ops/fixtures/api/v2/markets.json", import.meta.url));
const markets = marketsResponseSchema.parse(JSON.parse(readFileSync(fixture, "utf8")));
const cardsFixture = fileURLToPath(new URL("../../../ops/fixtures/api/v2/cards.json", import.meta.url));
const cards = cardsResponseSchema.parse(JSON.parse(readFileSync(cardsFixture, "utf8")));

describe("partial market spot availability", () => {
  it("uses a fresh direct oracle read only after an indexer failure and pauses on stale or failed reads", () => {
    const now = 100_000;
    expect(selectTradeSpot("120000000", false, 0, undefined, 0, true, now)).toBe(120_000_000n);
    expect(selectTradeSpot("120000000", true, now - 10_000, 121_000_000n, now - 1_000, false, now)).toBe(121_000_000n);
    expect(selectTradeSpot("120000000", true, now - 1_000, 121_000_000n, now - 10_000, false, now)).toBeNull();
    expect(selectTradeSpot("120000000", true, now - 20_000, 121_000_000n, now - 16_000, false, now)).toBeNull();
    expect(selectTradeSpot("120000000", true, now - 10_000, 121_000_000n, now - 1_000, true, now)).toBeNull();
    expect(selectTradeSpot("120000000", true, now - 10_000, undefined, 0, false, now)).toBeNull();
  });

  it("dates a valid order quote by its API response, not the older oracle feed round", () => {
    const generatedAt = markets[0]!.spotUpdatedAt! + 5;
    const degraded = markets.map((market) => market.ticker === markets[1]!.ticker
      ? { ...market, spot: null, spotUpdatedAt: null } : market);
    expect(marketQuoteAsOf(markets[0]!.ticker, generatedAt, degraded)).toBe(generatedAt);
    expect(marketQuoteAsOf(markets[1]!.ticker, generatedAt, degraded)).toBeNull();
    expect(marketQuoteAsOf("UNKNOWN", generatedAt, degraded)).toBeNull();
    expect(marketQuoteAsOf(markets[0]!.ticker, generatedAt, undefined)).toBeNull();
    expect(marketQuoteAsOf(markets[0]!.ticker, null, degraded)).toBeNull();
  });

  it("keeps Buy available for a fresh ask when the accepted feed round is more than 60 seconds old", () => {
    const card = cards.items.find((item) => item.series.ticker === markets[0]!.ticker)!;
    expect(cards.generatedAt - markets[0]!.spotUpdatedAt!).toBeGreaterThan(60);
    const quoteAsOf = marketQuoteAsOf(card.series.ticker, cards.generatedAt, markets);
    expect(payoffCardView(card, 1n, null, cards.generatedAt, quoteAsOf).state).toBe("live");
    expect(payoffCardView(card, 1n, null, cards.generatedAt + 61, quoteAsOf).state).toBe("stale");
  });

  it("requires spot and update time to become unavailable together", () => {
    const healthy = markets[0]!;
    expect(marketsResponseSchema.safeParse([{ ...healthy, spot: null, spotUpdatedAt: null }]).success).toBe(true);
    expect(marketsResponseSchema.safeParse([{ ...healthy, spot: null }]).success).toBe(false);
    expect(marketsResponseSchema.safeParse([{ ...healthy, spotUpdatedAt: null }]).success).toBe(false);
  });
});

/*
 * The DISPLAY fallback (lib/v2/displaySpot.ts) must never reach a trade: with a display price in hand and no
 * strict live spot, selectTradeSpot still says null, so every ticket, quote and trade button stays shut.
 */
describe("the display fallback never reaches selectTradeSpot", () => {
  it("returns null when only the display fallback has a price", async () => {
    resetDisplayCache();
    const now = 1_790_223_000;
    const display = await resolveDisplaySpot("NVDA", null, {
      chainlink: async () => ({ raw: 225_549_701n, updatedAt: now - 39_600 }),
      pool: async () => null,
      now: () => now,
    }, { NVDA: { feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", pool: null, stockIsToken0: false } });
    expect(display?.raw, "fixture: the display fallback has a price").toBe(225_549_701n);
    // API up but without a spot (the oracle refused an old print): no trade spot.
    expect(selectTradeSpot(null, false, 0, undefined, 0, true, now * 1000)).toBeNull();
    // API down and the direct oracle read failed: no trade spot either.
    expect(selectTradeSpot(null, true, now * 1000 - 1_000, undefined, 0, true, now * 1000)).toBeNull();
    resetDisplayCache();
  });
});
