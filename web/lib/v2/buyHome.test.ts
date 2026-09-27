import { describe, expect, it } from "vitest";

import type { Card, Market } from "./api-types";
import {
  BUY_HOME_HORIZON_S, buyHomeExpiries, buyHomeResaleOnly, buyHomeRow, buyHomeRows, launchMarkets, pickExpiry,
  scenarioLabel, scenarioPrice, tickerCards,
} from "./buyHome";

const usd = (dollars: number) => ({ raw: String(BigInt(Math.round(dollars * 1e6))), decimals: 6, formatted: dollars.toFixed(2) });
const NOW = 1_790_000_000;
const DAY = 86_400;

function market(ticker: string, over: Partial<Market> = {}): Market {
  return {
    ticker, name: `${ticker} Inc.`, underlying: `0x${"1".repeat(40)}`, status: "live", launch: true,
    tradingPaused: false, mintPaused: false,
    spot: usd(200), spotUpdatedAt: NOW - 60, strikeTick: usd(0.01), puts: true, mintFeePpm: 0,
    expiries: [NOW + DAY, NOW + 2 * DAY], cutoffExpiries: [],
    stats: { volume24h: usd(0), premium7d: usd(0), asOf: NOW, openInterestUnits: "0", seriesOpen: 2 },
    ...over,
  };
}

/** `fee` is the series' pinned exercise fee (0 unless set); `fee: null` omits it, as an older wire does. */
function card(over: { id?: string; ticker?: string; isPut?: boolean; strike?: number; spot?: number | null;
  expiry?: number; perShareCost?: number | null; perUnitCost?: number; units?: string; fee?: number | null } = {}): Card {
  const perShareCost = over.perShareCost === undefined ? 10 : over.perShareCost;
  const series = {
    longId: over.id ?? "1", shortId: "2", ticker: over.ticker ?? "NVDA", underlying: `0x${"1".repeat(40)}`,
    isPut: over.isPut ?? false, strike: usd(over.strike ?? 200), expiry: over.expiry ?? NOW + DAY,
    tenor: "daily" as const, mintCutoff: 0, mintFeePpm: 0, mintFeesHeld: usd(0), mintFeesAccrued: usd(0), status: "open" as const,
    ...(over.fee === null ? {} : { exerciseFeeBps: over.fee ?? 0 }),
  };
  return {
    series, spot: over.spot === null ? null : usd(over.spot ?? 220), ask: usd(0.1), target: usd(250),
    // A deliberately different "target" multiple (9x): the row must never show it.
    perUnit: { cost: usd(over.perUnitCost ?? 0.2), payoutAtTarget: usd(0.5), multiple: 9 },
    perShare: perShareCost === null ? null : { cost: usd(perShareCost), payoutAtTarget: usd(50), multiple: 9 },
    maxLoss: "cost", unitsAvailable: over.units ?? "250", orderIds: ["7"],
  };
}

describe("the scenario is stated with every multiple", () => {
  it("labels calls +10% and puts −10%", () => {
    expect(scenarioLabel(false)).toBe("If +10%");
    expect(scenarioLabel(true)).toBe("If −10%");
  });

  it("moves spot by exactly 10%: up for a call, down for a put", () => {
    expect(scenarioPrice(220_000_000n, false)).toBe(242_000_000n);
    expect(scenarioPrice(180_000_000n, true)).toBe(162_000_000n);
  });

  it("call: payout at spot x 1.10 over the one-share cost, not the feed's target multiple", () => {
    // K 200, spot 220 -> 242. One share pays 242 - 200 = 42 USDG before rounding; 42 / 10 = 4.20, floored.
    const row = buyHomeRow(card({ strike: 200, spot: 220, perShareCost: 10 }));
    expect(row.scenarioLabel).toBe("If +10%");
    expect(row.scenarioMultiple).toBeGreaterThanOrEqual(4.19);
    expect(row.scenarioMultiple).toBeLessThanOrEqual(4.2);
    expect(row.scenarioMultiple).not.toBe(9);
  });

  it("put: payout at spot x 0.90 over the one-share cost", () => {
    // K 200, spot 180 -> 162. One share pays 200 - 162 = 38 USDG exactly; 38 / 10 = 3.80.
    const row = buyHomeRow(card({ isPut: true, strike: 200, spot: 180, perShareCost: 10 }));
    expect(row.scenarioLabel).toBe("If −10%");
    expect(row.scenarioMultiple).toBe(3.8);
  });

  it("an out-of-the-money scenario is 0x, not hidden", () => {
    // K 300, spot 220 -> 242: below the strike, pays nothing.
    expect(buyHomeRow(card({ strike: 300, spot: 220 })).scenarioMultiple).toBe(0);
  });

  it("the exercise fee lowers the multiple", () => {
    const free = buyHomeRow(card({ isPut: true, spot: 180 })).scenarioMultiple!;
    const charged = buyHomeRow(card({ isPut: true, spot: 180, fee: 100 })).scenarioMultiple!;
    expect(charged).toBeLessThan(free);
  });

  it("each row prices on ITS series' pinned fee, not one fee for the whole table", () => {
    // Same card twice, pinned at 25 and at 200 bps: the multiples and break-evens must differ, and each must match the
    // row priced alone on its own fee (a shared default would make them equal).
    const low = buyHomeRow(card({ isPut: true, spot: 180, fee: 25 }));
    const high = buyHomeRow(card({ isPut: true, spot: 180, fee: 200 }));
    expect(high.scenarioMultiple!).toBeLessThan(low.scenarioMultiple!);
    expect(high.breakeven!).toBeLessThan(low.breakeven!);
    const rows = buyHomeRows([card({ id: "p25", isPut: true, spot: 180, fee: 25 }), card({ id: "p200", isPut: true, spot: 180, fee: 200 })],
      { expiry: null, filter: "all", sort: "expiry" });
    expect(rows.map((r) => [r.key, r.scenarioMultiple, r.breakeven]))
      .toEqual([["p25", low.scenarioMultiple, low.breakeven], ["p200", high.scenarioMultiple, high.breakeven]]);
  });

  it("an unknown pinned fee shows no multiple and no break-even, never a default-priced figure", () => {
    const row = buyHomeRow(card({ strike: 200, spot: 220, perShareCost: 10, fee: null }));
    expect(row.scenarioMultiple).toBeNull();
    expect(row.breakeven).toBeNull();
    // The rest of the row is still there: the ask is real, only the fee-dependent figures are unknown.
    expect(row.costPerShare).toBe(10_000_000n);
    expect(row.href).toBe("/nvda/1");
  });

  it("no spot means no scenario, so no multiple at all (never the target multiple)", () => {
    const row = buyHomeRow(card({ spot: null }));
    expect(row.scenarioMultiple).toBeNull();
  });
});

describe("one-share cost and break-even", () => {
  it("uses perShare when the book holds a share", () => {
    const row = buyHomeRow(card({ perShareCost: 12.5 }));
    expect(row.costPerShare).toBe(12_500_000n);
    expect(row.partial).toBe(false);
  });

  it("falls back to perUnit x 100 under one share, and says so", () => {
    const row = buyHomeRow(card({ perShareCost: null, perUnitCost: 0.2, units: "40" }));
    expect(row.costPerShare).toBe(20_000_000n);
    expect(row.partial).toBe(true);
  });

  it("break-even is strike + cost for a call and strike − cost for a put when fees are zero", () => {
    expect(buyHomeRow(card({ strike: 200, perShareCost: 10 })).breakeven).toBeGreaterThanOrEqual(210_000_000n);
    expect(buyHomeRow(card({ strike: 200, perShareCost: 10 })).breakeven).toBeLessThanOrEqual(210_000_100n);
    expect(buyHomeRow(card({ isPut: true, strike: 200, perShareCost: 10 })).breakeven).toBe(190_000_000n);
  });

  it("links each row to its option page", () => {
    expect(buyHomeRow(card({ id: "42", ticker: "SPCX" })).href).toBe("/spcx/42");
  });
});

describe("launch markets and the day picker's expiries", () => {
  const markets = [
    market("NVDA"),
    market("SPCX", { expiries: [NOW + DAY, NOW + 3 * DAY, NOW - 10] }),
    market("AAPL", { launch: false, expiries: [NOW + 4 * DAY] }),
    market("TSLA", { status: "paused", expiries: [NOW + 5 * DAY] }),
  ];

  it("keeps only live launch markets", () => {
    expect(launchMarkets(markets).map((m) => m.ticker)).toEqual(["NVDA", "SPCX"]);
    expect(tickerCards(markets).map((m) => m.ticker)).toEqual(["NVDA", "SPCX"]);
    expect(tickerCards(undefined)).toEqual([]);
  });

  it("unions launch expiries, drops expired and non-launch ones, sorts ascending", () => {
    expect(buyHomeExpiries(markets, NOW)).toEqual([NOW + DAY, NOW + 2 * DAY, NOW + 3 * DAY]);
  });

  it("drops anything past the daily horizon (no weekly or monthly listings on this page)", () => {
    const far = [market("NVDA", { expiries: [NOW + DAY, NOW + BUY_HOME_HORIZON_S + 1, NOW + 30 * DAY] })];
    expect(buyHomeExpiries(far, NOW)).toEqual([NOW + DAY]);
  });

  it("a Friday-only market (SPCX) always has its next Friday on the page, even right after Friday's close", () => {
    // Friday 2026-09-25 16:00 New York (20:00Z) is SPCX's Friday close; one minute later its next listed expiry is the
    // following Friday, 7 days less a minute away. Before (6.5 days) SPCX had no day on the page until Saturday.
    const friClose = Date.UTC(2026, 8, 25, 20, 0, 0) / 1_000;
    const now = friClose + 60;
    const nextFri = friClose + 7 * DAY;
    const spcx = [market("SPCX", { expiries: [nextFri, nextFri + 7 * DAY] })];
    expect(buyHomeExpiries(spcx, now)).toEqual([nextFri]);
    expect(BUY_HOME_HORIZON_S).toBeGreaterThanOrEqual(7 * DAY);
  });

  it("an empty book still yields the listed days, so the picker stays", () => {
    expect(buyHomeExpiries([market("NVDA")], NOW)).toHaveLength(2);
    expect(buyHomeExpiries([], NOW)).toEqual([]);
  });

  it("keeps a still-listed selection and otherwise picks the nearest", () => {
    expect(pickExpiry([1, 2, 3], 2)).toBe(2);
    expect(pickExpiry([1, 2, 3], 9)).toBe(1);
    expect(pickExpiry([], 2)).toBeNull();
  });
});

describe("the table's filters and sort", () => {
  const cards = [
    card({ id: "a", spot: 220, strike: 210, perShareCost: 10 }), // call, If +10%: (242-210)/10 ~ 3.2
    card({ id: "b", spot: 220, strike: 200, perShareCost: 10 }), // call ~ 4.2
    card({ id: "c", isPut: true, spot: 180, strike: 200, perShareCost: 10 }), // put 3.8
    card({ id: "d", spot: null }), // no scenario
    card({ id: "e", expiry: NOW + 2 * DAY }), // other day
  ];
  const opts = { expiry: NOW + DAY, filter: "all" as const, sort: "multiple" as const };

  it("shows only the selected day", () => {
    expect(buyHomeRows(cards, opts).map((r) => r.key)).not.toContain("e");
  });

  it("All / Calls / Puts", () => {
    expect(buyHomeRows(cards, { ...opts, filter: "call" }).every((r) => !r.isPut)).toBe(true);
    expect(buyHomeRows(cards, { ...opts, filter: "put" }).map((r) => r.key)).toEqual(["c"]);
  });

  it("Highest multiple sorts by the multiple the row shows, rows without one last", () => {
    expect(buyHomeRows(cards, opts).map((r) => r.key)).toEqual(["b", "c", "a", "d"]);
  });

  it("Soonest sorts by expiry and keeps feed order within a day", () => {
    expect(buyHomeRows(cards, { ...opts, expiry: null, sort: "expiry" }).map((r) => r.key)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("Most traded keeps the feed's own order", () => {
    expect(buyHomeRows(cards, { ...opts, sort: "volume" }).map((r) => r.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("no cards is an empty table, not an error", () => {
    expect(buyHomeRows(undefined, opts)).toEqual([]);
  });
});

describe("cutoff days on the Buy home", () => {
  it("lists a launch market's cutoff day, because resale asks trade until expiry", () => {
    const markets = [market("NVDA", { expiries: [NOW + 2 * DAY], cutoffExpiries: [NOW + 3_600] })];
    expect(buyHomeExpiries(markets, NOW)).toEqual([NOW + 3_600, NOW + 2 * DAY]);
    expect(buyHomeResaleOnly(markets, NOW)).toEqual([NOW + 3_600]);
  });

  it("a day still writable on another launch market is not resale-only", () => {
    const markets = [
      market("NVDA", { expiries: [NOW + DAY], cutoffExpiries: [NOW + 3_600] }),
      market("SPCX", { expiries: [NOW + 3_600, NOW + DAY], cutoffExpiries: [] }),
    ];
    expect(buyHomeExpiries(markets, NOW)).toEqual([NOW + 3_600, NOW + DAY]);
    expect(buyHomeResaleOnly(markets, NOW)).toEqual([]);
  });

  it("drops past, non-launch and paused-listing cutoff days like any other", () => {
    const markets = [
      market("NVDA", { expiries: [], cutoffExpiries: [NOW - 10, NOW + BUY_HOME_HORIZON_S + 1] }),
      market("AAPL", { launch: false, expiries: [], cutoffExpiries: [NOW + 3_600] }),
      market("TSLA", { status: "paused", expiries: [], cutoffExpiries: [NOW + 3_600] }),
    ];
    expect(buyHomeExpiries(markets, NOW)).toEqual([]);
    expect(buyHomeResaleOnly(markets, NOW)).toEqual([]);
  });
});
