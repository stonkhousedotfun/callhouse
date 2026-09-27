/**
 * The public Earn interest on /earn, which was /lend, as a view model
 * so every refusal is a tested branch rather than a missing element.
 *
 * THREE FIGURES, AND THEY ARE NOT THE SAME CLAIM:
 *   realised       the vault's own gross share price over 7 / 30 days, measured by the indexer from hourly
 *                  on-chain samples. Not a mark delta: the mark also rises when someone deposits,
 *                  so "the mark moved" is not "yield arrived". The cut that left is the skimmed total.
 *   venue          the lending venue's own share-price growth over 24h / 7d (Steakhouse USDG, a Morpho vault),
 *                  also measured on chain. What the venue paid, before our cut.
 *   net estimate   venue 7d x (1 - skimBps / 10_000). An ESTIMATE of what the venue rate becomes after the cut.
 *                  skimBps is READ FROM THE VAULT (earnVault.skimBps()), never a typed 10%.
 *                  The cut is charged only on gain above the high-water
 *                  mark (EarnVault.skim), so on a flat or losing stretch it takes nothing -- the label says so.
 *
 * A null figure always carries the indexer's reason, worded for a depositor. A percentage is never shown without
 * the window it covers.
 */
import type { EarnApy, EarnVault } from "@/lib/v2/api-types";

export type ApyFigure = { text: string | null; note: string };

const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export function bpsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** One measured figure, or why there is none. `window` is the label the figure is read against ("7 days"). */
export function apyFigure(apy: EarnApy | undefined, window: string): ApyFigure {
  if (apy === undefined) return { text: null, note: "not reported by this indexer yet" };
  if (apy.bps !== null) {
    const span = apy.from !== null && apy.to !== null
      ? `, measured ${DATE.format(apy.from * 1_000)} to ${DATE.format(apy.to * 1_000)}` : "";
    return { text: bpsPercent(apy.bps), note: `annualised from the last ${window}${span}` };
  }
  switch (apy.reason) {
    case "short-history": return { text: null, note: `less than ${window} of history so far; no figure until there is` };
    case "no-samples": return { text: null, note: "no history recorded yet" };
    case "no-price": return { text: null, note: "no share price in that window" };
    case "out-of-range": return { text: null, note: "the measured change is outside what can be shown" };
    default: return { text: null, note: "unavailable" };
  }
}

/** Morpho's own page for a vault on Robinhood Chain (app.morpho.org/robinhood-chain/vault/<address>, checked live). */
export function morphoVaultUrl(address: string): string {
  return `https://app.morpho.org/robinhood-chain/vault/${address}`;
}

export type LendApyView =
  | { kind: "unconfigured" }
  | { kind: "not-sent" }
  | {
    kind: "figures";
    realised7d: ApyFigure;
    realised30d: ApyFigure;
    /** Null: no venue attached, so there is no venue rate at all. */
    venue: null | {
      name: string | null;
      address: string | null;
      href: string | null;
      apy24h: ApyFigure;
      apy7d: ApyFigure;
      net: ApyFigure;
    };
    /** The cut, as read from the vault; null when not read. */
    skimPercent: string | null;
  };

/**
 * @param vault the vault address, or null when none is configured.
 * @param row the /v2/earn row for it; undefined or null while loading or when absent.
 * @param skimBps / ceilBps earnVault.skimBps() and SKIM_BPS_CEIL(), null when not read.
 */
export function lendApyView(input: {
  vault: string | null;
  row: EarnVault | null | undefined;
  skimBps: number | null;
  ceilBps: number | null;
}): LendApyView {
  if (input.vault === null) return { kind: "unconfigured" };
  const row = input.row;
  // An indexer that predates sends none of these; saying "not reported" beats rendering four empty rows.
  if (!row || (row.apy7d === undefined && row.apy30d === undefined && row.venue === undefined)) return { kind: "not-sent" };

  const skimOk = input.skimBps !== null && (input.ceilBps === null || input.skimBps <= input.ceilBps);
  const venue = row.venue ?? null;
  let net: ApyFigure;
  if (venue === null) net = { text: null, note: "no venue attached" };
  else if (input.skimBps === null) net = { text: null, note: "the protocol cut could not be read from the vault" };
  else if (!skimOk) net = { text: null, note: "the vault reports a protocol cut above its own ceiling; no estimate while they disagree" };
  else if (venue.apy7d.bps === null) net = { ...apyFigure(venue.apy7d, "7 days") };
  else {
    const netBps = Math.round((venue.apy7d.bps * (10_000 - input.skimBps)) / 10_000);
    net = {
      text: bpsPercent(netBps),
      note: `estimate: the venue's 7-day rate less the ${bpsPercent(input.skimBps)} protocol cut, which is charged only on gain above the vault's high-water mark`,
    };
  }

  return {
    kind: "figures",
    realised7d: apyFigure(row.apy7d, "7 days"),
    realised30d: apyFigure(row.apy30d, "30 days"),
    venue: venue === null ? null : {
      name: venue.name,
      address: venue.address,
      href: venue.address === null ? null : morphoVaultUrl(venue.address),
      apy24h: apyFigure(venue.apy24h, "24 hours"),
      apy7d: apyFigure(venue.apy7d, "7 days"),
      net,
    },
    skimPercent: input.skimBps === null ? null : bpsPercent(input.skimBps),
  };
}
