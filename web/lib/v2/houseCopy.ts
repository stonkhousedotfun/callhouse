/**
 * House vault disclosure copy. Import these strings on the page; do not paraphrase them there.
 *
 * The four facts:
 * - "you can lose money; our bot does the quoting
 *   inside on-chain limits; withdrawals are processed once a week", and past epochs as facts
 *   "including losing ones".
 * - withdrawals are paid in kind, pro rata, so the vault never
 *   has to swap to pay someone out.
 * - the copy rule itself: depositors can lose money, our bot
 *   does the quoting, results are per-epoch facts including losing epochs, and none of the
 *   forward-looking rate words the compliance table forbids. Its exact wording
 *   is not quoted here because this file is linted against that same table.
 *
 *
 *
 * NOTHING MACHINE-CHECKS THIS WORDING ANY MORE. copy-lint
 * and the no-rate rule in houseCopy.test.ts were removed together, because
 * the lending vault's interest percentage must BE SHOWN and a rule forbidding "a percentage per unit of
 * time" cannot coexist with a requirement to publish one.
 *
 * SO THE DISCIPLINE IS NOW THE AUTHOR'S, AND IT IS WORTH STATING PLAINLY. Every string below says
 * what happened in ONE epoch and says nothing about what happens next. The failure it guards
 * against is not a banned word; it is a forward-looking claim wearing the clothes of a fact -- an
 * average across epochs, a run of good ones, a figure per unit of time. A linter went green on
 * those anyway, which is part of why removing it costs less than it appears to.
 *
 * Unrelated and still enforced: houseEpoch.ts returns NAV_NOT_AVAILABLE for a running epoch.
 * That is a correctness guard, not a copy rule, and this decision does not reach it.
 */

export const HOUSE_DISCLOSURE_CAN_LOSE =
  "You can lose money. The vault trades with depositors' money and can end a day or week with less USDG and stock than it started with.";

export const HOUSE_DISCLOSURE_BOT_QUOTES =
  "Our bot does the trading, inside limits set on chain. The limits cap its size and prices; they do not stop losses.";

export const HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS =
  "Withdrawals are paid once a week, at the market close on the week's last trading day, after that week's options settle. You get your share of the vault's USDG and its stock, not cash only. A request made during the week waits until then.";

export const HOUSE_DISCLOSURE_PER_EPOCH_FACTS =
  "The figures below are what happened in each period, losing ones included. They are past results, not a rate or a forecast.";

/**
 * The daily flavour's withdrawal fact. Same shape as the weekly
 * one so a page swaps one for the other by cadence and nothing else; the weekly string is unchanged byte for byte.
 */
export const HOUSE_DISCLOSURE_DAILY_WITHDRAWALS =
  "Withdrawals are paid once a day, at the market close, after that day's options settle. You get your share of the vault's USDG and its stock, not cash only. A request made during the day waits until then.";

export type HouseCadence = "weekly" | "daily";

/**
 * (its House vault "Daily, Fridays only"). A DAILY
 * vault on a market that lists no daily expiries trades only in the day that ends at the week's Friday close: the other
 * days' closes have no option to settle, so the vault just prices deposits and withdrawals there. The page says so,
 * plainly and by name ("Fridays"), instead of the daily copy's "after that day's options settle".
 * `marketListsDailies` is the market's registry listing (lib/v2/presets.ts dailyOffered). A weekly or unknown vault is
 * never Friday-only here: its copy already names the week's last trading day or no day at all.
 *
 * "Friday" is written with "(the week's last trading day)" wherever it states when the vault trades: in a week whose
 * Friday is a market holiday the weekly close is Thursday.
 */
export function houseTradesFridaysOnly(cadence: HouseCadence | null, marketListsDailies: boolean): boolean {
  return cadence === "daily" && !marketListsDailies;
}

/** The withdrawal fact of a Friday-only daily vault (houseTradesFridaysOnly). Same shape as the daily one. */
export const HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS =
  "Withdrawals are paid once a day, at the market close. This market's options expire on Fridays only (the week's last trading day), so the vault trades then and holds its USDG and stock on the other days. You get your share of the vault's USDG and its stock, not cash only. A request made during the day waits until that day's close.";

/**
 * The cadence the page may state, from the /v2/house `kind` (the indexer reads it from the vault's factory:
 * the launch factory's vaults are weekly, a factory's state it). `unknown` or absent is null: the page then
 * says the cadence is not known rather than defaulting to weekly, which is the guess that would print a false
 * disclosure on a daily vault.
 */
export function cadenceFromKind(kind: "weekly" | "daily" | "unknown" | undefined): HouseCadence | null {
  return kind === "weekly" || kind === "daily" ? kind : null;
}

/**
 * The card badge for a kind; an unknown kind is labelled so, never "Weekly". A Friday-only daily
 * vault (houseTradesFridaysOnly; pass the market's registry listing) is "Daily, Fridays only".
 */
export function houseCadenceBadge(kind: "weekly" | "daily" | "unknown" | undefined, marketListsDailies = true): string {
  const cadence = cadenceFromKind(kind);
  if (houseTradesFridaysOnly(cadence, marketListsDailies)) return "Daily, Fridays only";
  return cadence === "daily" ? "Daily" : cadence === "weekly" ? "Weekly" : "Schedule unknown";
}

/** When a withdrawal requested now is priced, by kind. A Friday-only daily vault says so. */
export function houseExitLine(kind: "weekly" | "daily" | "unknown" | undefined, marketListsDailies = true): string {
  const cadence = cadenceFromKind(kind);
  if (houseTradesFridaysOnly(cadence, marketListsDailies)) {
    return "Withdrawals are priced at today's close. This vault trades on Fridays only, when this market's options expire.";
  }
  if (cadence === "daily") return "Withdrawals are priced at today's close, after today's options settle.";
  // Never a weekday. In a holiday week the weekly expiry is the week's last trading day, not Friday.
  if (cadence === "weekly") return "Withdrawals are priced at the market close on the week's last trading day, after the week's options settle.";
  return "This vault's schedule is not known yet. Withdrawals are priced at its next close.";
}

export function houseWithdrawalDisclosure(cadence: HouseCadence, marketListsDailies = true): string {
  if (houseTradesFridaysOnly(cadence, marketListsDailies)) return HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS;
  return cadence === "daily" ? HOUSE_DISCLOSURE_DAILY_WITHDRAWALS : HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS;
}

/**
 * The withdrawal fact for a vault whose cadence the API does not know (`kind` unknown or absent). It states
 * the one thing true of every House vault -- paid in kind at the next boundary -- and names neither a day nor a week.
 */
export const HOUSE_DISCLOSURE_UNKNOWN_WITHDRAWALS =
  "This vault's schedule is not known yet, so this page cannot say when it closes. Withdrawals are paid at its next close, after its options settle. You get your share of its USDG and its stock, not cash only. Deposits are paused here until the schedule is known.";

/**
 * The four disclosures for a vault of this cadence; `HOUSE_DISCLOSURES` below is the weekly set, unchanged. Null
 * (an unknown kind) swaps in the unknown-cadence withdrawal fact rather than defaulting to weekly.
 */
export function houseDisclosures(cadence: HouseCadence | null, marketListsDailies = true): readonly string[] {
  const withdrawals = cadence === null ? HOUSE_DISCLOSURE_UNKNOWN_WITHDRAWALS : houseWithdrawalDisclosure(cadence, marketListsDailies);
  return [HOUSE_DISCLOSURE_CAN_LOSE, HOUSE_DISCLOSURE_BOT_QUOTES, withdrawals, HOUSE_DISCLOSURE_PER_EPOCH_FACTS];
}

/**
 * The page lede, which used to say "once a week" as a literal. Null (unknown kind) names no cadence.
 * A Friday-only daily vault (houseTradesFridaysOnly) says it trades on Fridays and still settles every day.
 */
export function houseLede(cadence: HouseCadence | null, marketListsDailies = true): string {
  if (cadence === null) return "The house vault trades this market with depositors' money. Deposits and withdrawals settle at the vault's close.";
  if (houseTradesFridaysOnly(cadence, marketListsDailies)) {
    return "The house vault trades this market with depositors' money on Fridays, when its options expire. Deposits and withdrawals still settle once a day, at the market close.";
  }
  return cadence === "daily"
    ? "The house vault trades this market with depositors' money. Deposits and withdrawals settle once a day, at the market close."
    : "The house vault trades this market with depositors' money. Deposits and withdrawals settle once a week, at the close on the week's last trading day.";
}

export const HOUSE_DISCLOSURES = [
  HOUSE_DISCLOSURE_CAN_LOSE,
  HOUSE_DISCLOSURE_BOT_QUOTES,
  HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS,
  HOUSE_DISCLOSURE_PER_EPOCH_FACTS,
] as const;

/*
 * (v9 House vault). Copy for two chain facts the page now shows. Every value these strings carry is one the
 * contract returned (previewDepositNow, performanceFeeOwed) or a transaction reported (DepositedNow); nothing here is
 * computed from other vault fields, and nothing estimates shares before a deposit is sent.
 */

/**
 * Restated: the vault's previewDepositNow is the rule, not a guess from what the vault holds.
 * A returned share count is exact (settled payouts included). A refusal, including the not-exact `NoSource` /
 * `StaleSpot` when a converted ITM call has no price a view can know, waits and this page quotes no shares.
 */
export const HOUSE_INSTANT_DEPOSIT_RULE =
  "A USDG deposit gets shares right away only when the vault's preview names the exact share count. When that preview refuses, the deposit waits for the close and this page does not quote a share count. Stock Token deposits always wait for the close.";

/** The USDG deposit button, by the path the vault's own previewDepositNow chose. Unknown keeps the queued label. */
export const HOUSE_DEPOSIT_NOW_LABEL = "Deposit USDG now";
export const HOUSE_DEPOSIT_QUEUE_LABEL = "Queue USDG deposit";

/**
 * What the vault said about the amount entered; null before it has answered.
 * `false` is every refusal, including a preview that is not exact. That line does not say the deposit
 * gets shares now, and it carries no count.
 */
export function houseDepositRouteLine(instant: boolean | null): string | null {
  if (instant === true) return "The vault says this deposit gets shares now.";
  if (instant === false) return "The vault says this deposit waits for the close.";
  return null;
}

/** The notice after an instant deposit, quoting the shares the transaction's DepositedNow log reported. */
export function houseDepositedNowNotice(sharesText: string | null): string {
  return sharesText === null
    ? "Deposited. Your shares were added in this transaction; refresh to see them."
    : `Deposited. You got ${sharesText} shares.`;
}

export const HOUSE_DEPOSIT_QUEUED_NOTICE = "Deposit queued. It joins at the next close.";

/**
 * A performance fee charged at a boundary and not yet paid (HouseVault.performanceFeeOwed). nav() already nets it,
 * so the page states it beside the value and never subtracts it again.
 */
export function housePerformanceFeeOwedLine(usdgText: string): string {
  return `A ${usdgText} USDG performance fee is owed and not yet paid. The value shown already takes it out; it is paid at a later close.`;
}
