/**
 * The Buy home's table maths (Neon design).
 *
 * THE SCENARIO RULE. A multiple never appears bare. Every row's multiple is the
 * payout at a stated scenario divided by the cost: "If +10%" for a call (settlement at spot x 1.10) and "If -10%"
 * for a put (spot x 0.90). The spot is the card's oracle spot, the payout is `payoutAt` (net of the in-kind
 * exercise fee, the call valued in USDG at the scenario price), and the cost is the fee-inclusive ask for one
 * share. A card with no spot has no scenario, so it shows no multiple rather than the indexer's target multiple:
 * that target is a different scenario, and printing it under an "If +10%" header would be the bare multiple this
 * rule exists to remove.
 *
 * ONE SHARE. `perShare` is the 100-unit ticket with one taker fee, which is what "Cost · 1 sh" means. Under 100
 * ask units it is null and the row falls back to `perUnit` scaled to a share: the per-unit cost carries a whole
 * taker fee on 0.01 share, so the fallback overstates cost and understates the multiple. It is marked `partial`
 * so the page can say so; it is never the better-looking number.
 *
 * THE PINNED FEE. The payout is net of the exercise fee THIS series pinned at creation
 * (`card.series.exerciseFeeBps`), which is what redeem charges; the market's current default (`/v2/config`) can differ
 * after a setMarketConfig and is never used here. A wire without the field (earlier indexer) is an unknown fee:
 * the row shows no multiple and no breakeven rather than a figure priced on the default.
 *
 * LAUNCH SET ONLY. The ticker cards and the day picker read `market.launch && market.status === "live"`: NVDA and
 * SPCX at launch, whatever else the registry lists.
 */
import type { Card, Market, Money } from "@/lib/v2/api-types";
import { BPS, UNITS_PER_SHARE, breakeven, multipleAt, type PayoffPosition } from "@/lib/v2/payoff";

/** +/-10%. Basis points, so the scenario price is exact integer maths. */
export const SCENARIO_MOVE_BPS = 1_000n;
/**
 * How far ahead the page lists expiries. NVDA's run daily, up to about six sessions out; SPCX lists
 * its Friday closes only. The window is one week and a half-day, so the next
 * Friday is always inside it. At six and a half days it was not from Friday's close until 04:00 Saturday (New York),
 * and SPCX had no day on the page then. The day picker still shows at most DAY_PICKER_MAX days, and the next Friday is
 * at most five sessions away, so it is never the one cut.
 */
export const BUY_HOME_HORIZON_S = 7 * 24 * 60 * 60 + 12 * 60 * 60;

export type OptionFilter = "all" | "call" | "put";
export type BuyHomeSort = "multiple" | "expiry" | "volume";

export type TickerCard = { ticker: string; name: string; spot: Money | null; spotUpdatedAt: number | null };

export type BuyHomeRow = {
  key: string;
  ticker: string;
  isPut: boolean;
  strike: Money;
  expiry: number;
  /** "If +10%" or "If −10%": the scenario the multiple belongs to. */
  scenarioLabel: string;
  /** Payout at the scenario over the one-share cost, two decimals, rounded down; null without a spot, a cost or the
   *  series' pinned exercise fee. */
  scenarioMultiple: number | null;
  /** First profitable settlement price for a call, highest for a put; USDG base units. Null when the pinned fee is
   *  unknown. */
  breakeven: bigint | null;
  /** Fee-inclusive cost of one share, USDG base units. */
  costPerShare: bigint;
  /** True when the book holds under one share and the cost is the per-unit fallback (see the header). */
  partial: boolean;
  /** Units left on the ask side. One unit is 0.01 share. */
  unitsLeft: bigint;
  href: string;
};

/** The launch markets that are live, in registry order. */
export function launchMarkets(markets: readonly Market[] | undefined): Market[] {
  return (markets ?? []).filter((market) => market.launch && market.status === "live");
}

export function tickerCards(markets: readonly Market[] | undefined): TickerCard[] {
  return launchMarkets(markets).map(({ ticker, name, spot, spotUpdatedAt }) => ({ ticker, name, spot, spotUpdatedAt }));
}

/**
 * Listed expiries across the launch markets, future and inside BUY_HOME_HORIZON_S; the DayPicker caps the count.
 * A day past its mint cutoff (`cutoffExpiries`) is listed too, because resale asks trade until
 * expiry and this page buys; {buyHomeResaleOnly} names the days that are nothing but that.
 */
export function buyHomeExpiries(markets: readonly Market[] | undefined, now: number): number[] {
  const listed = new Set<number>();
  for (const market of launchMarkets(markets)) {
    for (const expiry of [...market.expiries, ...market.cutoffExpiries]) {
      if (expiry > now && expiry <= now + BUY_HOME_HORIZON_S) listed.add(expiry);
    }
  }
  return [...listed].sort((a, b) => a - b);
}

/**
 * The days {buyHomeExpiries} lists only because some launch market has them past the mint cutoff:
 * no launch market can still write on them. A day still open for writing on any launch market is not resale-only.
 */
export function buyHomeResaleOnly(markets: readonly Market[] | undefined, now: number): number[] {
  const writable = new Set(launchMarkets(markets).flatMap((market) => market.expiries));
  return buyHomeExpiries(markets, now).filter((expiry) => !writable.has(expiry));
}

/** The selected expiry if still listed, else the nearest listed one, else null. */
export function pickExpiry(expiries: readonly number[], selected: number | null): number | null {
  if (selected !== null && expiries.includes(selected)) return selected;
  return expiries[0] ?? null;
}

export function scenarioLabel(isPut: boolean): string {
  return isPut ? "If −10%" : "If +10%";
}

/** Spot moved by the scenario: up 10% for a call, down 10% for a put. */
export function scenarioPrice(spot: bigint, isPut: boolean): bigint {
  return (spot * (isPut ? BPS - SCENARIO_MOVE_BPS : BPS + SCENARIO_MOVE_BPS)) / BPS;
}

function oneShareCost(card: Card): { cost: bigint; partial: boolean } {
  if (card.perShare) return { cost: BigInt(card.perShare.cost.raw), partial: false };
  return { cost: BigInt(card.perUnit.cost.raw) * UNITS_PER_SHARE, partial: true };
}

export function buyHomeRow(card: Card): BuyHomeRow {
  const { series } = card;
  const { cost, partial } = oneShareCost(card);
  const exerciseFeeBps = series.exerciseFeeBps ?? null;
  const position: PayoffPosition | null = exerciseFeeBps === null ? null : {
    isPut: series.isPut, strike: BigInt(series.strike.raw), units: UNITS_PER_SHARE, exerciseFeeBps,
  };
  const spot = card.spot ? BigInt(card.spot.raw) : null;
  return {
    key: series.longId,
    ticker: series.ticker,
    isPut: series.isPut,
    strike: series.strike,
    expiry: series.expiry,
    scenarioLabel: scenarioLabel(series.isPut),
    scenarioMultiple: position === null || spot === null || cost === 0n ? null
      : multipleAt(scenarioPrice(spot, series.isPut), position, cost),
    breakeven: position === null ? null : breakeven(position, cost),
    costPerShare: cost,
    partial,
    unitsLeft: BigInt(card.unitsAvailable),
    href: `/${series.ticker.toLowerCase()}/${series.longId}`,
  };
}

/**
 * The table: cards for the selected day and option type, as rows, in the chosen order. "Highest multiple" sorts by
 * the multiple the row shows (rows without one last), so the order matches the column the reader is looking at.
 * "Soonest" and "Most traded" keep the feed's order within a day, which is the indexer's own ranking.
 */
export function buyHomeRows(cards: readonly Card[] | undefined, opts: {
  expiry: number | null; filter: OptionFilter; sort: BuyHomeSort;
}): BuyHomeRow[] {
  const rows = (cards ?? [])
    .filter((card) => opts.expiry === null || card.series.expiry === opts.expiry)
    .filter((card) => opts.filter === "all" || card.series.isPut === (opts.filter === "put"))
    .map((card) => buyHomeRow(card));
  if (opts.sort === "multiple") {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => (b.row.scenarioMultiple ?? -1) - (a.row.scenarioMultiple ?? -1) || a.index - b.index)
      .map(({ row }) => row);
  }
  if (opts.sort === "expiry") {
    return rows.map((row, index) => ({ row, index }))
      .sort((a, b) => a.row.expiry - b.row.expiry || a.index - b.index).map(({ row }) => row);
  }
  return rows;
}
