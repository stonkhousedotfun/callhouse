/**
 * WHEN DO I GET PAID. One source for that sentence on every money-in path the app exposes.
 * The screens show it; this file only decides it. Pure functions, no React, no chain reads:
 * every caller passes the live facts it already has (a series expiry, a vault's `epochEnd` and cadence,
 * the Earn vault's queue state) and gets back a {PayoutTiming}.
 *
 * THE TABLE THIS IMPLEMENTS has one row per path, each fact cited to the
 * contract line that makes it true. The contract citations there are at the v8 launch source
 * (the commit the v8 launch broadcast from). The `contracts/`
 * submodule in this repo was pinned OLDER than that, so it is not the source.
 *
 * THREE RULES, and how this file keeps them:
 *  1. No hard-coded day or hour. Every time is computed from the expiry or `epochEnd` the caller passes; the
 *     weekly/daily difference arrives as the vault's cadence, never as a weekday in a string.
 *  2. No promise the contract does not make. A keeper step (settle, redeem, roll, queue) is best-effort and
 *     permissionless, so {PayoutTiming.usualBy} is "usually by", {PayoutTiming.selfServe} says what the user can
 *     do instead, and nothing here is phrased as a guarantee.
 *  3. The unhappy path is always stated: {PayoutTiming.unhappy} is never empty.
 *
 * TIME ZONE. {PayoutTiming.whenEt} stays the New York stamp, which a server render can print. Times inside the
 * sentences follow the reader's zone when the input carries `timeZone`: "Sep 24,
 * 1:00 PM PDT (4:00 PM ET)"; without it they stay New York. For the reader's local time on its own,
 * {formatLocal} renders the same instant in the viewer's zone and ALWAYS names the zone, which is the
 * failure `time.ts` exists to prevent. Callers choose; both come from the same unix second.
 */

import { HOUSE_ROLL_OVERDUE_S, houseWindowWords } from "./houseEpoch";
import { formatConfiguredDelay } from "./marketDirectory";
import { marketStamp, stamp } from "./time";
import type { Cadence } from "./vaultCopy";
import { ZAP_DEADLINE_SECONDS } from "./zapTx";

/*//////////////////////////////////////////////////////////////
                  MIRRORED CONSTANTS (cite, never retype)
//////////////////////////////////////////////////////////////*/

/** `V2Constants.FINALIZE_DELAY` = 120 s (src/v2/interfaces/V2Constants.sol). `SettlementOracle.finalize`
 *  refuses before `expiry + FINALIZE_DELAY`. */
export const FINALIZE_DELAY_S = 120;

/** The DEFAULT wait when only one price source answers: the launch registry's `v2.defaults.uncorroboratedDelayS`
 *  (ops/markets/tier1.json), passed to `SettlementOracle.setMarket` by RegisterMarkets.s.sol, and the contract's
 *  own `DEFAULT_UNCORROBORATED_DELAY` (6 h). It is NOT fixed: `uncorroboratedDelay` is per market and the config
 *  admin can change it with `setMarket`, within 30 min to 24 h (SettlementOracle `MIN_`/`MAX_UNCORROBORATED_DELAY`).
 *  The live value is on /v2/markets `settlement.uncorroboratedDelayS`; a caller that has it passes it
 *  (`uncorroboratedDelayS` below) and this default is used only when it does not, and then the copy says "by default"
 * */
export const UNCORROBORATED_DELAY_S = 21_600;

/** `V2Constants.RESOLVE_DELAY` = 48 h (V2Constants.sol): the earliest an admin can resolve a vetoed or
 *  stuck expiry (SettlementOracle.adminResolve). */
export const RESOLVE_DELAY_S = 172_800;

/** The cranker's `POLL_INTERVAL_MS` default, 60 000 ms (keeper/src/v2/config.ts `POLL_INTERVAL_MS`); it also wakes itself at
 *  each expiry (its rendered env). This is the "usually" slack after a step becomes possible. */
export const KEEPER_POLL_S = 60;

/*//////////////////////////////////////////////////////////////
                                 TYPES
//////////////////////////////////////////////////////////////*/

export type PayoutPath =
  | "buy-call"
  | "sell-call"
  | "resting-order"
  | "self-redeem"
  | "close-pair"
  | "ledger-withdraw"
  | "house-deposit"
  | "house-withdraw"
  | "house-deposit-cancel"
  | "earn-vault-deposit"
  | "earn-vault-redeem"
  | "zap";

/** How the money reaches the user once it is due. */
export type Arrival =
  /** In the same transaction the user sends. */
  | "immediate"
  /** A keeper (or anyone) sends it to the user's wallet; the user does nothing. */
  | "automatic"
  /** The user must send a claim transaction. */
  | "claim";

export type PayoutTiming = {
  path: PayoutPath;
  arrival: Arrival;
  /** Unix seconds of the earliest moment the payment can happen, or null when it waits on an event with no
   *  clock (a counterparty filling an order, an admin action). */
  earliestAt: number | null;
  /** Unix seconds by which it usually has happened if keepers run on time. Never a guarantee; null when no
   *  honest estimate exists. */
  usualBy: number | null;
  /** True when `now` is past {usualBy} and the payment is still due: the keeper is late. */
  late: boolean;
  /** What has to happen first, in order. Empty for an immediate path. */
  steps: string[];
  /** One plain sentence for the screen. */
  headline: string;
  /** What the user can do if the keeper is late, or null when there is nothing to do but wait. */
  selfServe: string | null;
  /** What happens when it goes the other way. Never empty. */
  unhappy: string;
  /** America/New_York stamp of {usualBy} (else {earliestAt}), the app's canonical market time; null when both are. */
  whenEt: string | null;
};

/*//////////////////////////////////////////////////////////////
                               RENDERING
//////////////////////////////////////////////////////////////*/

/**
 * The same instant in the viewer's zone, zone named ("Sep 25, 2026, 9:00 PM GMT+1"). `timeZone` undefined means
 * the runtime's zone, which in a browser is the reader's. Seconds in, never milliseconds (time.ts rule).
 */
export function formatLocal(unixSeconds: number, timeZone?: string): string {
  if (!Number.isFinite(unixSeconds)) throw new RangeError("timestamps are unix seconds");
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZone, timeZoneName: "short",
  }).format(new Date(unixSeconds * 1000));
}

/**
 * A time inside a sentence. With the reader's zone, "Sep 24, 1:00 PM PDT (4:00 PM ET)"; without one (a
 * server render, or a caller that has not passed it yet), the New York stamp as before.
 */
function when(unixSeconds: number, timeZone: string | undefined): string {
  return timeZone === undefined ? stamp(unixSeconds) : marketStamp(unixSeconds, timeZone);
}

function requireSeconds(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be unix seconds`);
  return Math.trunc(value);
}

function timing(t: Omit<PayoutTiming, "whenEt" | "late">, now: number, due: boolean): PayoutTiming {
  const at = t.usualBy ?? t.earliestAt;
  return { ...t, late: due && t.usualBy !== null && now > t.usualBy, whenEt: at === null ? null : stamp(at) };
}

/*//////////////////////////////////////////////////////////////
                           OPTION SETTLEMENT
//////////////////////////////////////////////////////////////*/

/**
 * The single-source wait to use. The market's live `settlement.uncorroboratedDelayS` when the caller has a
 * usable one (a positive whole number of seconds); otherwise {UNCORROBORATED_DELAY_S}, flagged as the default so the
 * sentence says so instead of stating it as this market's value.
 */
function singleSourceDelay(live: number | undefined): { seconds: number; live: boolean } {
  return live !== undefined && Number.isSafeInteger(live) && live > 0
    ? { seconds: live, live: true }
    : { seconds: UNCORROBORATED_DELAY_S, live: false };
}

/** "about 90 minutes longer" from the market's live wait; "about 6 hours longer by default (each market sets its own)"
 *  when only the default is known. */
function singleSourceWaitWords(live: number | undefined): string {
  const delay = singleSourceDelay(live);
  return `about ${formatConfiguredDelay(delay.seconds)} longer` + (delay.live ? "" : " by default (each market sets its own)");
}

/**
 * When a settled option pays, as a pair of times. Corroborated (two sources agree): finalizable from
 * `expiry + FINALIZE_DELAY`. One source only: the market's single-source wait on top (`uncorroboratedDelayS`, the live
 * per-market value when passed, else {UNCORROBORATED_DELAY_S}). `Clearinghouse.settle` then redeems in the same
 * cranker tick (keeper/src/v2/cranker/main.ts:3 "settle, prune then redeem").
 */
export function settlementWindow(expiry: number, uncorroboratedDelayS?: number): { earliestAt: number; usualBy: number; singleSourceBy: number } {
  const e = requireSeconds("expiry", expiry);
  return {
    earliestAt: e + FINALIZE_DELAY_S,
    usualBy: e + FINALIZE_DELAY_S + KEEPER_POLL_S,
    singleSourceBy: e + FINALIZE_DELAY_S + singleSourceDelay(uncorroboratedDelayS).seconds + KEEPER_POLL_S,
  };
}

const SETTLE_STEPS = [
  "the option expires",
  "the final price is set (two price sources agree, or one source after its waiting period)",
  "the option is settled",
  "your position is paid out",
];

const SELF_REDEEM = "Once the option is settled, you can redeem it yourself from Portfolio.";

/** `uncorroboratedDelayS` is the market's live /v2/markets `settlement.uncorroboratedDelayS`; omitted, the
 *  sentence names {UNCORROBORATED_DELAY_S} as the default. */
export type BuyCallInput = { expiry: number; now: number; timeZone?: string; uncorroboratedDelayS?: number };

/** Buying a call (TradeTicket `take` with buying = true). Premium leaves now; any payout comes after expiry. */
export function buyCallTiming(input: BuyCallInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  const w = settlementWindow(input.expiry, input.uncorroboratedDelayS);
  return timing({
    path: "buy-call",
    arrival: "automatic",
    earliestAt: w.earliestAt,
    usualBy: w.usualBy,
    steps: SETTLE_STEPS,
    headline: `You pay the premium now. If the call ends in the money, the payout usually arrives a few minutes after expiry (${when(w.usualBy, input.timeZone)}).`,
    selfServe: SELF_REDEEM,
    unhappy:
      "A call that ends at or below its strike pays nothing. If only one price source answers, payment waits " +
      `${singleSourceWaitWords(input.uncorroboratedDelayS)}; a disputed price waits for an admin decision, at least ` +
      `${RESOLVE_DELAY_S / 3_600} hours after expiry. You get USDG when the swap succeeds, otherwise the Stock Token ` +
      "(always the Stock Token if you chose in-kind payouts, and to your Clearinghouse balance if you chose that).",
  }, now, now >= w.earliestAt);
}

/** `uncorroboratedDelayS`: as {BuyCallInput}. */
export type SellCallInput = { expiry: number; now: number; writes: boolean; timeZone?: string; uncorroboratedDelayS?: number };

/**
 * Selling a call into a bid (TradeTicket `take` with buying = false). The premium is paid inside the fill. When
 * the sale WRITES a new call, the collateral stays locked until the series settles.
 */
export function sellCallTiming(input: SellCallInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  const w = settlementWindow(input.expiry, input.uncorroboratedDelayS);
  if (!input.writes) {
    return timing({
      path: "sell-call",
      arrival: "immediate",
      earliestAt: now,
      usualBy: null,
      steps: [],
      headline: "You receive the premium in the same transaction as the sale.",
      selfServe: null,
      unhappy: "If the USDG transfer to you fails, the premium is held for you on the order book; claim it there.",
    }, now, false);
  }
  return timing({
    path: "sell-call",
    arrival: "automatic",
    earliestAt: w.earliestAt,
    usualBy: w.usualBy,
    steps: SETTLE_STEPS,
    headline: `You receive the premium now. Your collateral is locked until the option settles, usually a few minutes after expiry (${when(w.usualBy, input.timeZone)}).`,
    selfServe: SELF_REDEEM,
    unhappy:
      "If the call ends in the money, some or all of your Stock Token collateral goes to the buyer and you keep the " +
      "premium. If only one price source answers, the collateral waits " +
      `${singleSourceWaitWords(input.uncorroboratedDelayS)}.`,
  }, now, now >= w.earliestAt);
}

export type RestingOrderInput = { kind: "ask" | "bid"; validUntil: number; now: number; timeZone?: string };

/** A resting order (`place`). Nothing moves until someone fills it. */
export function restingOrderTiming(input: RestingOrderInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  const until = requireSeconds("validUntil", input.validUntil);
  const ask = input.kind === "ask";
  return timing({
    path: "resting-order",
    arrival: "immediate",
    earliestAt: null,
    usualBy: null,
    steps: ["another trader fills your order before it expires"],
    headline: ask
      ? `You are paid the premium in the transaction that fills your ask, if it fills before ${when(until, input.timeZone)}.`
      : `Your bid's USDG is held on the order book until it fills or expires (${when(until, input.timeZone)}).`,
    selfServe: ask ? null : "You can cancel an unfilled bid at any time to get its USDG back.",
    unhappy: ask
      ? "An ask that nobody fills pays nothing and expires."
      : "An unfilled bid is refunded when it is cancelled, or cleaned up after it expires; if that transfer fails, the USDG is held on the order book for you to claim.",
  }, now, false);
}

export type SelfRedeemInput = { settled: boolean; expiry: number; now: number; timeZone?: string };

/** Portfolio `redeem`: the user settles their own position. */
export function selfRedeemTiming(input: SelfRedeemInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  const w = settlementWindow(input.expiry);
  return timing({
    path: "self-redeem",
    arrival: "immediate",
    earliestAt: input.settled ? now : w.earliestAt,
    usualBy: input.settled ? null : w.usualBy,
    steps: input.settled ? [] : SETTLE_STEPS.slice(0, 3),
    headline: input.settled
      ? "Redeeming pays you in the same transaction."
      : "You can redeem once the option is settled; a keeper usually does it for you a few minutes after expiry.",
    selfServe: null,
    unhappy: "A position that settled out of the money redeems for nothing.",
  }, now, false);
}

/** Portfolio `close`: closing a long and short pair frees the collateral now, to your Clearinghouse balance. */
export function closePairTiming(now: number): PayoutTiming {
  const t = requireSeconds("now", now);
  return timing({
    path: "close-pair",
    arrival: "immediate",
    earliestAt: t,
    usualBy: null,
    steps: [],
    headline: "Closing frees your collateral to your Clearinghouse balance in the same transaction; withdraw it from there.",
    selfServe: null,
    unhappy: "An option that has already settled cannot be closed; redeem it instead.",
  }, t, false);
}

/** Earn `withdraw` from the Clearinghouse balance: a plain transfer. */
export function ledgerWithdrawTiming(now: number): PayoutTiming {
  const t = requireSeconds("now", now);
  return timing({
    path: "ledger-withdraw",
    arrival: "immediate",
    earliestAt: t,
    usualBy: null,
    steps: [],
    headline: "Withdrawing from your Clearinghouse balance pays you in the same transaction.",
    selfServe: null,
    unhappy: "Collateral backing a call you sold cannot be withdrawn until that option settles.",
  }, t, false);
}

/*//////////////////////////////////////////////////////////////
                               HOUSE VAULT
//////////////////////////////////////////////////////////////*/

/**
 * `settlementWindow`: the chain's `SETTLEMENT_WINDOW()` in seconds. HouseVault's queue calls refuse PastCutoff
 * from `epochEnd` minus it. Absent or null while unread: only the close is known, and the chain refuses the rest.
 */
export type HouseInput = { cadence: Cadence; epochEnd: number; now: number; timeZone?: string; settlementWindow?: number | null };

/** When a queued request or cancel stops (`_requireBeforeCutoff`), or the close itself while the window is unread. */
function houseQueueCutoff(input: HouseInput, end: number): number {
  return typeof input.settlementWindow === "number" ? end - input.settlementWindow : end;
}

/** "the close", or "30 minutes before the close" once the window is read. */
function houseCutoffWords(input: HouseInput): string {
  return typeof input.settlementWindow === "number" ? `${houseWindowWords(input.settlementWindow)} before the close` : "the close";
}

const HOUSE_STEPS = [
  "the vault's close passes",
  "the final price for that close is set",
  "every option the vault holds has settled and it has no open orders",
  "the close is processed",
];

const HOUSE_ROLL_SELF_SERVE = "Anyone can process the close once the price is final.";

function houseCloseWord(cadence: Cadence): string {
  return cadence === "daily" ? "today's close" : "this week's close";
}

function houseRoll(epochEnd: number): { usualBy: number } {
  return { usualBy: epochEnd + FINALIZE_DELAY_S + KEEPER_POLL_S };
}

/**
 * A House deposit (`requestDeposit`). Queued now, priced at `epochEnd`, shares credited when the user claims after
 * the boundary. Before the queue cutoff (`epochEnd - SETTLEMENT_WINDOW`) it can be cancelled; from the cutoff
 * on the request is refused until the roll.
 */
export function houseDepositTiming(input: HouseInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  const end = requireSeconds("epochEnd", input.epochEnd);
  const r = houseRoll(end);
  const open = now < houseQueueCutoff(input, end);
  return timing({
    path: "house-deposit",
    arrival: "claim",
    earliestAt: end,
    usualBy: r.usualBy,
    steps: [...HOUSE_STEPS, "you claim your shares"],
    headline: open
      // "if it queues": a v9 USDG deposit into an empty or flat vault gets shares at once (depositNow).
      ? `If your deposit queues, it is priced at ${houseCloseWord(input.cadence)} (${when(end, input.timeZone)}). Claim your shares after the close is processed, usually a few minutes later.`
      : `Deposits reopen after the ${when(end, input.timeZone)} close is processed; until then a new request is refused.`,
    selfServe: HOUSE_ROLL_SELF_SERVE,
    unhappy:
      `Processing waits for a final price and for the vault to have no open options; after ${HOUSE_ROLL_OVERDUE_S / 3_600} hours it is flagged overdue. ` +
      `A deposit that prices to zero shares is returned as deposited when you claim. You can cancel until ${houseCutoffWords(input)}, not after.`,
  }, now, !open);
}

/**
 * A House withdrawal (`requestWithdraw`). Paid IN KIND (USDG and the Stock Token) when you claim after the boundary.
 * Like the queued deposit, the request and its cancel stop at the queue cutoff (`epochEnd - SETTLEMENT_WINDOW`,
 * ) and reopen after the roll.
 */
export function houseWithdrawTiming(input: HouseInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  const end = requireSeconds("epochEnd", input.epochEnd);
  const r = houseRoll(end);
  const open = now < houseQueueCutoff(input, end);
  return timing({
    path: "house-withdraw",
    arrival: "claim",
    earliestAt: end,
    usualBy: r.usualBy,
    steps: [...HOUSE_STEPS, "you claim your USDG and Stock Tokens"],
    headline: open
      ? `Your withdrawal is priced at ${houseCloseWord(input.cadence)} (${when(end, input.timeZone)}) and paid in USDG and Stock Tokens, ` +
        "your share of each. Claim it after the close is processed, usually a few minutes later."
      : `Withdrawal requests reopen after the ${when(end, input.timeZone)} close is processed; until then a new request is refused.`,
    selfServe: HOUSE_ROLL_SELF_SERVE,
    unhappy:
      "You get a share of what the vault holds, not a fixed USDG amount, after any performance fee on the period's gains. " +
      `If the close is late it is flagged overdue after ${HOUSE_ROLL_OVERDUE_S / 3_600} hours. You can cancel until ${houseCutoffWords(input)}, not after.`,
  }, now, !open);
}

/** Cancelling a queued House deposit (`cancelDepositRequest`): immediate, but only before the queue cutoff. */
export function houseDepositCancelTiming(input: HouseInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  const end = requireSeconds("epochEnd", input.epochEnd);
  const cutoff = houseQueueCutoff(input, end);
  const open = now < cutoff;
  return timing({
    path: "house-deposit-cancel",
    arrival: "immediate",
    earliestAt: open ? now : null,
    usualBy: null,
    steps: [],
    headline: open
      ? `Cancelling returns your queued deposit in the same transaction, until ${when(cutoff, input.timeZone)}.`
      : now < end
        ? `Cancels stop ${houseCutoffWords(input)}, so this deposit can no longer be cancelled; it is priced at that close.`
        : "The close has passed, so this deposit can no longer be cancelled; it is priced at that close.",
    selfServe: null,
    unhappy: `From ${houseCutoffWords(input)}, a queued deposit stays in and is priced at that close.`,
  }, now, false);
}

/*//////////////////////////////////////////////////////////////
                         EARN VAULT (the Lend page)
//////////////////////////////////////////////////////////////*/

export type EarnVaultInput = {
  now: number;
  /** `EarnVault` holds a written short, a long, or resale escrow (its `_positionOpen`). */
  positionOpen: boolean;
  /** The FIFO queue has entries (its `_queueOpen`). */
  queueOpen: boolean;
  /** Expiry of the series holding the vault open, when known; null when unknown or none. */
  openExpiry: number | null;
  /** The reader's zone for times in the sentences; omitted keeps New York. */
  timeZone?: string;
};

function earnQueueBy(input: EarnVaultInput): number | null {
  if (!input.positionOpen) return requireSeconds("now", input.now) + KEEPER_POLL_S;
  if (input.openExpiry === null) return null;
  return settlementWindow(input.openExpiry).usualBy + KEEPER_POLL_S;
}

const EARN_QUEUE_STEPS = [
  "the vault's open call expires and settles",
  "the queue is processed, in order",
];

const EARN_SELF_SERVE = "Anyone can process the queue, including you from the Lend page.";

/** An Earn vault deposit (`deposit`): shares now, or queued while a series is written or the queue is open. */
export function earnVaultDepositTiming(input: EarnVaultInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  if (!input.positionOpen && !input.queueOpen) {
    return timing({
      path: "earn-vault-deposit",
      arrival: "immediate",
      earliestAt: now,
      usualBy: null,
      steps: [],
      headline: "You receive vault shares in the same transaction.",
      selfServe: null,
      unhappy: "A deposit that would price to zero shares is refused.",
    }, now, false);
  }
  const by = earnQueueBy(input);
  return timing({
    path: "earn-vault-deposit",
    arrival: "automatic",
    earliestAt: input.positionOpen && input.openExpiry !== null ? settlementWindow(input.openExpiry).earliestAt : now,
    usualBy: by,
    steps: input.positionOpen ? EARN_QUEUE_STEPS : EARN_QUEUE_STEPS.slice(1),
    headline:
      "Your deposit is queued" + (input.positionOpen ? " while the vault has an open call" : " behind earlier requests") +
      "; you get your shares when the queue reaches it" + (by === null ? "." : `, usually by ${when(by, input.timeZone)}.`),
    selfServe: EARN_SELF_SERVE,
    unhappy: "A queued deposit is priced when processed, not now. One that would price to zero shares is refunded instead. You can cancel a queued entry.",
  }, now, by !== null);
}

/** An Earn vault redemption (`redeem`): USDG now when nothing blocks it, else queued FIFO and paid when served. */
export function earnVaultRedeemTiming(input: EarnVaultInput): PayoutTiming {
  const now = requireSeconds("now", input.now);
  if (!input.positionOpen && !input.queueOpen) {
    return timing({
      path: "earn-vault-redeem",
      arrival: "immediate",
      earliestAt: now,
      usualBy: null,
      steps: [],
      headline: "You receive USDG in the same transaction when the vault can raise it from its venue.",
      selfServe: EARN_SELF_SERVE,
      // EarnVault.redeem pays the WHOLE amount or queues the WHOLE amount (`have < owed` -> `_enqueue(shares, ...)`,
      // nothing burned, nothing paid). There is no partial payment, so this must not promise "the rest".
      unhappy: "If the vault and its venue cannot raise the whole amount right now, nothing is paid yet: the whole withdrawal is queued and paid when the queue is processed.",
    }, now, false);
  }
  const by = earnQueueBy(input);
  return timing({
    path: "earn-vault-redeem",
    arrival: "automatic",
    earliestAt: input.positionOpen && input.openExpiry !== null ? settlementWindow(input.openExpiry).earliestAt : now,
    usualBy: by,
    steps: input.positionOpen ? EARN_QUEUE_STEPS : EARN_QUEUE_STEPS.slice(1),
    headline:
      "Your withdrawal is queued" + (input.positionOpen ? " while the vault has an open call" : " behind earlier requests") +
      "; USDG is sent to you when the queue reaches it" + (by === null ? "." : `, usually by ${when(by, input.timeZone)}.`),
    selfServe: EARN_SELF_SERVE,
    unhappy:
      "It is priced when paid, not when you asked, and may be paid in parts if the venue is short. " +
      "You can cancel a queued withdrawal to get your shares back.",
  }, now, by !== null);
}

/*//////////////////////////////////////////////////////////////
                                   ZAP
//////////////////////////////////////////////////////////////*/

/** `writeZap` / `exitZap`: one swap, paid in the same transaction or reverted. */
export function zapTiming(now: number): PayoutTiming {
  const t = requireSeconds("now", now);
  return timing({
    path: "zap",
    arrival: "immediate",
    earliestAt: t,
    usualBy: null,
    steps: [],
    headline: `The swap pays you in the same transaction, if it is mined within ${ZAP_DEADLINE_SECONDS / 60} minutes.`,
    selfServe: null,
    unhappy: "If the price moves past your slippage limit or the deadline passes, the transaction reverts and nothing is swapped.",
  }, t, false);
}
