import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Card } from "./api-types";
import { formatShareQuantity, formatShares, formatUsdg, payoffCardView } from "./payoffCard";

const FIXTURES = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const cards = JSON.parse(readFileSync(`${FIXTURES}/cards.json`, "utf8")) as { items: Card[]; generatedAt: number };

describe("payoff card view", () => {
  it("keeps the fee-inclusive 0.01 share card as the source of truth", () => {
    const card = cards.items[1];
    const view = payoffCardView(card, 1n, null, cards.generatedAt, cards.generatedAt);
    expect(view.state).toBe("live");
    expect(view.cost).toBe(BigInt(card.perUnit.cost.raw));
    expect(view.payout).toBe(BigInt(card.perUnit.payoutAtTarget.raw));
    expect(view.multiple).toBe(card.perUnit.multiple);
    expect(view.sentence).toContain("Pay 0.004387 USDG → estimated settlement value 0.19 USDG");
    expect(view.sentence).toContain("Max loss: 0.004387 USDG.");
    expect(view.buyHref).toContain("?buy=1&shares=0.01");
  });

  // This case used to expect premium(bestAsk, 10) + fee, i.e. every unit at the BEST ask while the
  // depth behind unitsAvailable spans levels. The card wire has no best-level depth, so a size other than one unit or
  // one share now shows no cost rather than a best-ask figure the book may not fill.
  it("shows no cost for a size the API does not price (not one unit, not one share), rather than a best-ask guess", () => {
    const card = cards.items[1];
    const view = payoffCardView(card, 10n, null, cards.generatedAt, cards.generatedAt);
    expect(view.state).toBe("live");
    expect(view.cost).toBeNull();
    expect(view.profitAtTarget).toBeNull();
    expect(view.multiple).toBeNull();
    expect(view.buyHref).toContain("shares=0.1");
    // A multi-level fixture ask: even at a size inside the whole depth, no single-price cost is claimed.
    const deep = cards.items.find((item) => BigInt(item.unitsAvailable) > 100n)!;
    expect(payoffCardView(deep, BigInt(deep.unitsAvailable) - 1n, null, cards.generatedAt, cards.generatedAt).cost).toBeNull();
  });

  it("uses the v3 full-share quote when the best level is thinner than a share", () => {
    const card = cards.items.find((item) => BigInt(item.unitsAvailable) < 100n && item.perShare);
    expect(card).toBeDefined();
    const view = payoffCardView(card!, 100n, null, cards.generatedAt, cards.generatedAt);
    expect(view.state).toBe("live");
    expect(view.quotedAcrossLevels).toBe(true);
    expect(view.cost).toBe(BigInt(card!.perShare!.cost.raw));
    expect(view.payout).toBe(BigInt(card!.perShare!.payoutAtTarget.raw));
    expect(view.multiple).toBe(card!.perShare!.multiple);
  });

  it("marks thin depth, stale quotes, and past cutoff without promising a fill", () => {
    const thin = cards.items[0]; // Fixture's highest-multiple ask has only 40 units.
    expect(payoffCardView(thin, 100n, null, cards.generatedAt, cards.generatedAt)).toMatchObject({ state: "thin", cost: null, availableShares: "0.4" });
    expect(payoffCardView(thin, 1n, null, cards.generatedAt + 61, cards.generatedAt).state).toBe("stale");
    expect(payoffCardView(thin, 1n, null, null, cards.generatedAt).state).toBe("stale");
    const resaleCard = { ...thin, series: { ...thin.series, status: "cutoff" as const } };
    expect(payoffCardView(resaleCard, 1n, null, thin.series.mintCutoff, thin.series.mintCutoff).state).toBe("live");
    expect(payoffCardView(resaleCard, 1n, null, thin.series.expiry, thin.series.expiry).state).toBe("cutoff");
  });

  it("formats tiny amounts exactly", () => {
    expect(formatShares(1n)).toBe("0.01");
    expect(formatShares(10n)).toBe("0.1");
    expect(formatShares(100n)).toBe("1");
    expect(formatShareQuantity(0n)).toBe("0 shares");
    expect(formatShareQuantity(1n)).toBe("0.01 shares");
    expect(formatShareQuantity(100n)).toBe("1 share");
    expect(formatShareQuantity(101n)).toBe("1.01 shares");
    expect(formatUsdg(4387n)).toBe("0.004387");
  });

  it("mirrors the put card sentence and keeps the paid cost as max loss", () => {
    const base = cards.items[1];
    const put: Card = { ...base,
      series: { ...base.series, isPut: true, strike: { raw: "200000000", decimals: 6, formatted: "200" } },
      target: { raw: "190000000", decimals: 6, formatted: "190" },
      perUnit: { cost: { raw: "11000", decimals: 6, formatted: "0.011" },
        payoutAtTarget: { raw: "99500", decimals: 6, formatted: "0.0995" }, multiple: 9.04 },
    };
    const view = payoffCardView(put, 1n, null, cards.generatedAt, cards.generatedAt);
    expect(view.cost).toBe(11_000n);
    expect(view.payout).toBe(99_500n);
    expect(view.sentence).toContain("falls to $190.00");
    expect(view.sentence).toContain("receive 0.0995 USDG");
    expect(view.sentence).toContain("Max loss: 0.011 USDG.");
  });
});
