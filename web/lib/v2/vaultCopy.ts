/**
 * Vault page copy, verbatim. Import these on the
 * page; do not paraphrase them there. `{placeholders}` are filled only by the functions below, and every number
 * that fills one comes from a chain read or the indexer, never from a literal in this file.
 *
 * CADENCE. A House vault is weekly or daily (`HouseVault.weekly()`). Every sentence that names a week,
 * a Friday or a day is a function of the cadence, not a constant, so a daily vault can never render a weekly
 * promise. The daily strings exist even while no daily vault is deployed; the tests pin both.
 *
 * NO RATE WITHOUT ITS FORMULA. The only rate these pages may show is the trailing measured one, and only with the
 * formula beside it (`trailingRate`). There is no other function here that produces a percentage per unit of time.
 */
import { displayRatioPercent } from "../numberFormat";

export type Cadence = "weekly" | "daily";

/**
 * A figure and the qualifier that must travel with it ("the label is part of the
 * value type so it cannot be omitted"). `text` null means the read failed and renders "not read", never 0.
 */
export type LabelledValue = { text: string | null; label: string; tone?: "plain" | "caution" };

export const VAULT_INDICATIVE_LABEL =
  "Estimate: a call is open, so this value is a cautious mark. Deposits and withdrawals are priced once no call is open.";

export const HOUSE_CUTOFF_WEEKLY =
  "Deposits made before this week's close are priced at it. Withdrawal requests are taken until the close is processed, and priced at that close.";

export const HOUSE_CUTOFF_DAILY =
  "Deposits made before today's close are priced at it. Withdrawal requests are taken until the close is processed, and priced at that close.";

export const HOUSE_IDLE_WEEKLY =
  "A queued deposit waits for the close on the week's last trading day before it earns or loses anything.";

/** The daily idle warning. */
export const HOUSE_IDLE_DAILY = "A queued deposit made after the close waits for the next close.";

/**
 * `FEE_ROUTE`. The design's string says "50 % / 50 %" because `burnBps` was 5 000 at launch; the page renders the
 * split from the splitter's `burnBps` READ, so a changed split can never be misreported. Null when not read.
 * Both shares go through lib/numberFormat.ts `displayRatioPercent` ("50%"), like the fee lines below.
 */
export function feeRouteLine(burnBps: number | null): string | null {
  if (burnBps === null || !Number.isInteger(burnBps) || burnBps < 0 || burnBps > 10_000) return null;
  const burn = displayRatioPercent(BigInt(burnBps), 10_000n);
  const treasury = displayRatioPercent(BigInt(10_000 - burnBps), 10_000n);
  return `Fees are split ${burn} to buy and burn STONKHOUSE, ${treasury} to the treasury.`;
}

export const NO_HISTORY =
  "This vault has not closed yet, so there is no result to show.";

export const NO_RATE_YET = "A rate is shown once the vault has closed four times.";

/**
 * The single-source wait is SettlementOracle's per-market `uncorroboratedDelay`, which the config admin can
 * change (`setMarket`, 30 min to 24 h). The House page does not load the market's live value, so the 6 hours is stated
 * as the default (payoutTiming.ts `UNCORROBORATED_DELAY_S`), never as a fixed fact. Same for the "Close delay" risk row.
 */
export const HOUSE_BOUNDARY_WAITING =
  "Market closed. Waiting for the final price (usually a few minutes; longer if only one price source answers, 6 hours by default, adjustable per market), then the close is processed.";

export const HOUSE_BOUNDARY_OVERDUE =
  "The close is more than seven hours late. Deposits and withdrawals stay queued until it is processed.";

/**
 * The vault could not lock this close's price sources when the epoch opened, so the contract
 * processes it only a week after the close. `until` is the formatted time (houseEpoch.ts houseHeldUntil).
 */
export const houseBoundaryHeld = (until: string) =>
  `This close is held until ${until}. The vault could not lock its price sources when this period opened, so the close is processed a week later. Deposits and withdrawals stay queued until then.`;

export const CLAIM_ZERO = "Claim even if it shows 0; that clears your request.";

export const EARN_QUEUE_PRICING =
  "A queued withdrawal is priced when it is paid, not when you asked. If the vault loses value in between, you share the loss.";

/**
 * An Earn vault with no shares. Both per-share views return 0 on `totalSupply == 0`, and 0 there is a
 * price nobody can get, so the hero says the vault is empty instead. Keyed on the supply READ being 0, never on the
 * value: a 0 with shares outstanding is a real zero and is still shown.
 */
export const EARN_NO_SHARES_VALUE = "No shares yet";
export const EARN_NO_SHARES_LABEL = "Nobody holds shares yet, so there is no share price to show.";

export const EARN_NO_VENUE = "No lending venue is connected, so idle USDG earns nothing until the treasury connects one.";

/** `as of the last close, {date} · not a live price` */
export function vaultMarkLabel(date: string): string {
  return `as of the last close, ${date} · not a live price`;
}

export function houseCutoff(cadence: Cadence): string {
  return cadence === "daily" ? HOUSE_CUTOFF_DAILY : HOUSE_CUTOFF_WEEKLY;
}

export function houseIdle(cadence: Cadence): string {
  return cadence === "daily" ? HOUSE_IDLE_DAILY : HOUSE_IDLE_WEEKLY;
}

/** Basis points to a two-decimal percent string, e.g. 0 -> "0.00 %". Null in, null out: a missing read is never 0. */
export function bpsPct(bps: number | null): string | null {
  if (bps === null || !Number.isInteger(bps) || bps < 0) return null;
  return `${(bps / 100).toFixed(2)} %`;
}

/**
 * basis points through lib/numberFormat.ts `displayRatioPercent` ("0%", "20%", "12.5%"). The same null rule
 * as {bpsPct}: a missing or malformed read is never shown as 0.
 */
function bpsRatio(bps: number | null): string | null {
  if (bps === null || !Number.isInteger(bps) || bps < 0) return null;
  return displayRatioPercent(BigInt(bps), 10_000n);
}

/**
 * `HOUSE_FEE_LINE`, with the rate and the ceiling both from chain reads. Null when either read is missing.
 * (ADDITION 3): `feeBps` is the rate IN FORCE (epochPerformanceFeeBps, what the next close charges). `stagedBps`
 * (performanceFeeBps) is a change the treasury has staged; rollEpoch promotes it at the next close, so it is charged
 * from the next epoch. Shown only when it was read and differs from the rate in force.
 */
export function houseFeeLine(feeBps: number | null, ceilBps: number | null, stagedBps: number | null = null): string | null {
  const pct = bpsRatio(feeBps);
  const ceil = bpsRatio(ceilBps);
  if (pct === null || ceil === null) return null;
  const staged = stagedBps === feeBps ? null : bpsRatio(stagedBps);
  const next = staged === null ? "" : ` It changes to ${staged} from the next epoch.`;
  return `Performance fee ${pct} now (up to ${ceil}), taken in USDG at each close, only on gains above the vault's previous high.${next}`;
}

/** `EARN_SKIM_LINE`, same rules. */
export function earnSkimLine(skimBps: number | null, ceilBps: number | null): string | null {
  const pct = bpsRatio(skimBps);
  const ceil = bpsRatio(ceilBps);
  if (pct === null || ceil === null) return null;
  return `Skim ${pct} now (up to ${ceil}), taken only on realised gains above the previous high, and only when no call is open and no queue is waiting.`;
}

/**
 * `TRAILING_RATE`: the one rate the pages may show. Measured from two boundary prices 28 days apart; null (render
 * NO_RATE_YET) until four boundaries exist or when either price is missing or non-positive.
 */
export function trailingRate(priceNow: number | null, price28dAgo: number | null, boundaries: number): string | null {
  if (boundaries < 4 || priceNow === null || price28dAgo === null || !(price28dAgo > 0) || !(priceNow > 0)) return null;
  const pct = ((priceNow / price28dAgo - 1) * 365) / 28 * 100;
  return `Past 28 days, annualised: (price now ÷ price 28 days ago − 1) × 365 ÷ 28 = ${pct.toFixed(2)} %. A past result, not a forecast.`;
}

/** One row of a vault's "What can go wrong" block: the risk, the plain words, and the bound the contract gives it. */
export type VaultRisk = { term: string; words: string; bound: string };

/** House. The two cadence-dependent rows are functions of the cadence. */
export function houseRisks(cadence: Cadence, ticker: string): VaultRisk[] {
  return [
    { term: "Inventory", words: `The vault holds ${ticker} stock and options. If ${ticker} falls, the vault's value falls too. A ${cadence === "daily" ? "day" : "week"} can end worth less than it started.`, bound: "Bot limits cap size and price (see On chain)." },
    cadence === "daily"
      ? { term: "Daily lock", words: "A queued deposit waits until the next close. It earns and risks nothing until then.", bound: "Deposit cutoff: the close." }
      // Never a weekday. In a holiday week the weekly close is the week's last trading day, not Friday.
      : { term: "Weekly lock", words: "A queued deposit waits until the close on the week's last trading day. It earns and risks nothing until then.", bound: "Deposit cutoff: the close." },
    cadence === "daily"
      ? { term: "Exit is at the close, in USDG and stock", words: "You cannot withdraw during the day. At the close you get a share of the vault's USDG and its stock, not a fixed USDG amount.", bound: "Your share, paid at the close." }
      : { term: "Exit is weekly, in USDG and stock", words: "You cannot withdraw mid-week. At the week's close you get a share of the vault's USDG and its stock, not a fixed USDG amount.", bound: "Your share, paid at the close." },
    { term: "One part short", words: "If the vault cannot pay one part of a withdrawal, the whole claim waits until it can. It never pays one part first.", bound: "Both parts or neither." },
    { term: "Close delay", words: "The close needs a final price: usually a few minutes after the market close, longer if only one price source answers (6 hours by default; the wait is set per market and can be changed). If nobody processes the close, it waits (our keeper is alerted after 7 hours).", bound: "Final price: minutes (two sources); one source: 6 h by default, adjustable." },
    { term: "Bot limits are not a floor", words: "Our bot trades within on-chain limits. They cap size and price; they do not stop a loss.", bound: "Limits read from the vault." },
    { term: "Total loss", words: "If the vault is worth nothing at a close, deposits waiting for that close are returned, not added to an empty vault.", bound: "Returned as deposited, when you claim." },
    // no House fee-change risk row (the House fee is not
    // planned to change). vaultCopy.test.ts pins the row's absence.
  ];
}

/** Earn. */
export const EARN_RISKS: readonly VaultRisk[] = [
  { term: "Covered-call cap", words: "If the stock rallies past the strike, the vault sells at the strike and keeps only the premium. Gains above the strike are given up.", bound: "Per option, at its strike." },
  { term: "Exit timing", words: "While a call is open you cannot exit at a set price. Your request waits and is priced once no call is open.", bound: "Queued until no call is open." },
  { term: "Queue loss", words: "A loss between your request and its payment is yours.", bound: "Priced when paid." },
  { term: "Venue", words: "Idle USDG is lent through a lending venue. If the venue cannot pay out, withdrawals wait until it can; the vault never makes up the cash.", bound: "Withdrawals wait; they do not fail for lack of cash." },
  { term: "Venue absent", words: "Until a venue is connected, idle USDG earns nothing.", bound: "Venue read from the vault." },
  // The Earn caps are one settable Limits struct, so neither is fixed. The treasury sets any
  // values (EarnVault.setLimits); the guardian's instant call (tightenLimits) can only lower them.
  { term: "Outflow cap", words: "The vault limits how much it sends to the order book each day. That limits how fast it sells calls, not your withdrawal.", bound: "Daily limit set on the vault; the treasury can change it, the guardian can only lower it." },
  { term: "Size caps", words: "How much the vault can sell per option is capped by limits set on the vault. The treasury can change them; the guardian can only lower them.", bound: "Caps set on the vault; changeable." },
  { term: "Skim can rise", words: "The treasury can raise the skim up to its ceiling, never above.", bound: "Ceiling read from the vault." },
  { term: "Estimate, not a price", words: "While a call is open, the value shown is a cautious estimate, not what you would get.", bound: "Display only." },
];

/** House: where the return comes from. Prose only; the live lines need more indexer data. */
export function houseYieldProse(ticker: string): string {
  return `Our bot trades ${ticker} options with the vault's USDG and stock. The vault earns premium when it sells, pays premium when it buys, and holds the stock it owns. It also earns a maker rebate when its quotes are taken.`;
}
export const HOUSE_NOT_LENT = "Idle USDG in this vault is not lent out.";
export const HOUSE_NO_FILLS = "No trades yet this period.";
export const HOUSE_RESULT_AT_BOUNDARY = "These are cash flows, not the result. The result is set once, at the close. See History.";
export function houseInKindLine(ticker: string): string {
  return `You get your share of the vault's USDG and its ${ticker} stock, not USDG only.`;
}

/** The mark label where the boundary's date is not on hand (the /house index; indexer would add it). */
export const VAULT_MARK_LABEL_UNDATED = "as of the last close · not a live price";
export function cadenceBadge(cadence: Cadence): string {
  return cadence === "daily" ? "Daily" : "Weekly";
}
