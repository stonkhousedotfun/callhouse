import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Card, ConfigResponse } from "./api-types";
import { formatShareQuantity, formatShares, formatUsdg, payoffCardView } from "./payoffCard";
import { premium, takerFee } from "./payoff";

const FIXTURES = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const cards = JSON.parse(readFileSync(`${FIXTURES}/cards.json`, "utf8")) as { items: Card[]; generatedAt: number };
const config = JSON.parse(readFileSync(`${FIXTURES}/config.json`, "utf8")) as ConfigResponse;
const fees = { takerFeeFlat: BigInt(config.fees.takerFeeFlat.raw), takerFeeCapBps: config.fees.takerFeeCapBps };

describe("payoff card view", () => {
  it("keeps the fee-inclusive 0.01 share card as the source of truth", () => {
    const card = cards.items[1];
    const view = payoffCardView(card, 1n, fees, cards.generatedAt, cards.generatedAt);
    expect(view.state).toBe("live");
    expect(view.cost).toBe(BigInt(card.perUnit.cost.raw));
    expect(view.payout).toBe(BigInt(card.perUnit.payoutAtTarget.raw));
    expect(view.multiple).toBe(card.perUnit.multiple);
    expect(view.sentence).toContain("Pay 0.004387 USDG → estimated settlement value 0.19 USDG");
    expect(view.sentence).toContain("Max loss: 0.004387 USDG.");
    expect(view.buyHref).toContain("?buy=1&shares=0.01");
  });

  it("prices a larger chosen size with one fee on the take", () => {
    const card = cards.items[1];
    const view = payoffCardView(card, 10n, fees, cards.generatedAt, cards.generatedAt);
    const paid = premium(BigInt(card.ask.raw), 10n);
    expect(view.state).toBe("live");
    expect(view.cost).toBe(paid + takerFee(paid, fees));
    expect(view.cost).not.toBe(BigInt(card.perUnit.cost.raw) * 10n);
    expect(view.profitAtTarget).toBe(view.payout - view.cost!);
    expect(view.sentence).toContain(`Pay ${formatUsdg(view.cost!)} USDG`);
    expect(view.buyHref).toContain("shares=0.1");
  });

  it("uses the v3 full-share quote when the best level is thinner than a share", () => {
    const card = cards.items.find((item) => BigInt(item.unitsAvailable) < 100n && item.perShare);
    expect(card).toBeDefined();
    const view = payoffCardView(card!, 100n, fees, cards.generatedAt, cards.generatedAt);
    expect(view.state).toBe("live");
    expect(view.quotedAcrossLevels).toBe(true);
    expect(view.cost).toBe(BigInt(card!.perShare!.cost.raw));
    expect(view.payout).toBe(BigInt(card!.perShare!.payoutAtTarget.raw));
    expect(view.multiple).toBe(card!.perShare!.multiple);
  });

  it("marks thin depth, stale quotes, and past cutoff without promising a fill", () => {
    const thin = cards.items[0]; // Fixture's highest-multiple ask has only 40 units.
    expect(payoffCardView(thin, 100n, fees, cards.generatedAt, cards.generatedAt)).toMatchObject({ state: "thin", cost: null, availableShares: "0.4" });
    expect(payoffCardView(thin, 1n, fees, cards.generatedAt + 61, cards.generatedAt).state).toBe("stale");
    expect(payoffCardView(thin, 1n, fees, null, cards.generatedAt).state).toBe("stale");
    const resaleCard = { ...thin, series: { ...thin.series, status: "cutoff" as const } };
    expect(payoffCardView(resaleCard, 1n, fees, thin.series.mintCutoff, thin.series.mintCutoff).state).toBe("live");
    expect(payoffCardView(resaleCard, 1n, fees, thin.series.expiry, thin.series.expiry).state).toBe("cutoff");
  });

  it("requires fee settings before claiming a multi-unit cost and formats tiny amounts exactly", () => {
    const view = payoffCardView(cards.items[1], 10n, null, cards.generatedAt, cards.generatedAt);
    expect(view.cost).toBeNull();
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
    const view = payoffCardView(put, 1n, fees, cards.generatedAt, cards.generatedAt);
    expect(view.cost).toBe(11_000n);
    expect(view.payout).toBe(99_500n);
    expect(view.sentence).toContain("falls to $190.00");
    expect(view.sentence).toContain("receive 0.0995 USDG");
    expect(view.sentence).toContain("Max loss: 0.011 USDG.");
  });
});
