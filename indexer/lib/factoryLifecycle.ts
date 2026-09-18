import type { Address, Hex } from "viem";

/**
 * The pure decisions the factory-market handlers make, with no Ponder import so
 * src/factoryLifecycle.test.ts can pin them. Same split as lib/lifecycle.ts for the vault: the
 * handlers in src/factory.ts and src/writerAccount.ts import `ponder:registry`, which exists only
 * inside a Ponder process, so the choices they delegate live here and are unit-tested.
 *
 * WHAT THE LOGS SAY, AND WHAT THEY DO NOT (contracts/src/solo/Account.sol):
 *
 *   WriteRequested(lots)   `requestWrite`. 0 lots takes the account out of the keeper's pending
 *                          list; n lots puts it in. Reverts while something is listed.
 *   LotsListed(...)        `list`: the week's terms are pinned onto the account and `lots` one-lot
 *                          Seaport orders are validated. Only from pending (`NothingToList`).
 *   LotFilled(...)         one order filled, one contract written. `premiumUsdg` is the whole ask.
 *   Settled(nvda, usdg)    `settle`, after the account's own expiry: what the Valorem redeem
 *                          returned. (0, 0) when nothing was written — AND when the redeem
 *                          reverted, in which case the account keeps its claim and `list` will
 *                          revert `StillOpen` until something changes. The two are told apart
 *                          here by whether the week had fills (`settlementOutcome`).
 *
 * Nothing here reads the chain. Every helper is a function of the row as the previous events
 * left it and the event in hand.
 */

/*//////////////////////////////////////////////////////////////
                          ACCOUNT STATUS
//////////////////////////////////////////////////////////////*/

/** `writer_account.status`. Mirrors `ponder.schema.ts writerAccountStatus`; the API test pins the two together. */
export type WriterAccountStatus = "idle" | "pending" | "listed" | "settled";

export type AccountStatusEvent =
  | { kind: "WriteRequested"; lots: bigint }
  | { kind: "LotsListed" }
  | { kind: "Settled" };

/**
 * The status an account takes after one of its three state-moving events.
 *
 *   WriteRequested(0)  idle      the owner withdrew the request; the keeper skips this account.
 *   WriteRequested(n)  pending   waiting for the keeper's `listFor` (or the owner's own `list`).
 *   LotsListed         listed    orders on the book under a pinned week; nothing more can be
 *                                requested until `settle`.
 *   Settled            settled   flat again, request cleared on chain (`requestedLots = 0`), so a
 *                                new `requestWrite` is needed before the next week. Kept distinct
 *                                from `idle` because "just settled" is what the account page
 *                                shows next to the settlement row.
 *
 * The previous status is deliberately not an input: the contract already refuses every
 * out-of-order call (`AlreadyListed`, `NothingToList`, `TooEarly`), so a log that arrives is a
 * transition that happened, and the tape follows the log.
 */
export function nextStatus(event: AccountStatusEvent): WriterAccountStatus {
  switch (event.kind) {
    case "WriteRequested":
      return event.lots === 0n ? "idle" : "pending";
    case "LotsListed":
      return "listed";
    case "Settled":
      return "settled";
  }
}

/*//////////////////////////////////////////////////////////////
                           PENDING LOTS
//////////////////////////////////////////////////////////////*/

/** The lots an account contributes to the market's `pendingLots`: its request, only while pending. */
export function pendingContribution(a: { status: WriterAccountStatus; requestedLots: bigint }): bigint {
  return a.status === "pending" ? a.requestedLots : 0n;
}

/**
 * The market's `pendingLots` after one account moved: the running sum less what the account
 * contributed before, plus what it contributes now. Floored at zero, because a replay bounded
 * inside a week can see a `LotsListed` for a request it never indexed.
 */
export function pendingLotsAfter(
  total: bigint,
  before: { status: WriterAccountStatus; requestedLots: bigint },
  after: { status: WriterAccountStatus; requestedLots: bigint },
): bigint {
  const next = total - pendingContribution(before) + pendingContribution(after);
  return next > 0n ? next : 0n;
}

/*//////////////////////////////////////////////////////////////
                            SETTLEMENT
//////////////////////////////////////////////////////////////*/

/**
 * `account_settlement.outcome`.
 *
 *   unfilled    nothing was written this listing, so there was no claim: `Settled(0, 0)` and the
 *               lots came off the book unsold. The most likely outcome, published as a row.
 *   assigned    the redeem returned strike USDG: contracts were taken at the strike. The asset
 *               part may be non-zero too (partial assignment); USDG in is the verdict.
 *   expired     written, expired out of the money: the collateral came back, no USDG.
 *   unredeemed  written, and the redeem returned nothing at all. `ValoremLib.tryRedeemClaim`
 *               failed (Valorem or a token refused), the account KEEPS its claim, option id and
 *               written count, and the next `list` reverts `StillOpen`. Nothing in the tape can
 *               resolve it; it is published so somebody looks.
 */
export type SettlementOutcome = "unfilled" | "assigned" | "expired" | "unredeemed";

export function settlementOutcome(s: { filledLots: bigint; assetReturned: bigint; strikeUsdg: bigint }): SettlementOutcome {
  if (s.filledLots === 0n) return "unfilled";
  if (s.strikeUsdg > 0n) return "assigned";
  if (s.assetReturned > 0n) return "expired";
  return "unredeemed";
}

/**
 * The account columns `settle` resets, as the contract resets them: the request, the listing
 * and its pinned week are all cleared whatever happened. The option id follows the contract too:
 * cleared on a redeemed or empty week, KEPT on an unredeemed one, where `optionId()` on chain
 * still names the type the stuck claim belongs to.
 */
export function accountAfterSettled(
  prev: { optionId: bigint | null },
  outcome: SettlementOutcome,
): {
  status: WriterAccountStatus;
  requestedLots: bigint;
  listedLots: bigint;
  filledLots: bigint;
  listedWeekId: number | null;
  listedAskUsdg: bigint;
  optionId: bigint | null;
} {
  return {
    status: nextStatus({ kind: "Settled" }),
    requestedLots: 0n,
    listedLots: 0n,
    filledLots: 0n,
    listedWeekId: null,
    listedAskUsdg: 0n,
    optionId: outcome === "unredeemed" ? prev.optionId : null,
  };
}

/*//////////////////////////////////////////////////////////////
                           WEEK TOTALS
//////////////////////////////////////////////////////////////*/

/** The running totals a `market_week` row (and, summed over weeks, the market row) carries. */
export type WeekTotals = {
  lotsListed: bigint;
  lotsFilled: bigint;
  premiumUsdg: bigint;
  accountsListed: number;
  accountsSettled: number;
  assetReturned: bigint;
  assignedUsdg: bigint;
};

export const ZERO_WEEK_TOTALS: WeekTotals = {
  lotsListed: 0n,
  lotsFilled: 0n,
  premiumUsdg: 0n,
  accountsListed: 0,
  accountsSettled: 0,
  assetReturned: 0n,
  assignedUsdg: 0n,
};

/**
 * Just the seven totals of a row that carries more (a `market_week` row has its terms and key
 * beside them). The helpers below return exactly these, so a caller can spread the result into a
 * patch without dragging a row's primary key along.
 */
export const weekTotals = (w: WeekTotals): WeekTotals => ({
  lotsListed: w.lotsListed,
  lotsFilled: w.lotsFilled,
  premiumUsdg: w.premiumUsdg,
  accountsListed: w.accountsListed,
  accountsSettled: w.accountsSettled,
  assetReturned: w.assetReturned,
  assignedUsdg: w.assignedUsdg,
});

/** One account listed `lots` under this week. */
export function weekAfterListing(w: WeekTotals, lots: bigint): WeekTotals {
  return { ...weekTotals(w), lotsListed: w.lotsListed + lots, accountsListed: w.accountsListed + 1 };
}

/** One lot filled: one contract, `premiumUsdg` paid (the whole ask, fee item included). */
export function weekAfterFill(w: WeekTotals, premiumUsdg: bigint): WeekTotals {
  return { ...weekTotals(w), lotsFilled: w.lotsFilled + 1n, premiumUsdg: w.premiumUsdg + premiumUsdg };
}

/** One account settled under this week: what its redeem returned, both legs. */
export function weekAfterSettlement(w: WeekTotals, s: { assetReturned: bigint; strikeUsdg: bigint }): WeekTotals {
  return {
    ...weekTotals(w),
    accountsSettled: w.accountsSettled + 1,
    assetReturned: w.assetReturned + s.assetReturned,
    assignedUsdg: w.assignedUsdg + s.strikeUsdg,
  };
}

/*//////////////////////////////////////////////////////////////
                          SETUP SETTINGS
//////////////////////////////////////////////////////////////*/

/** `AccountFactory.policy()` as viem decodes it: minOtm, maxOtm, minPremium, maxUtilization, protocolFeeBps, maxContractsCap. */
export type FactoryPolicyTuple = readonly [number, number, number, number, number, bigint];

/** What `Factory:setup` could read, null per view that did not answer. */
export type FactoryReads = {
  asset: Address | null;
  feed: Address | null;
  clear: Address | null;
  implementation: Address | null;
  policy: FactoryPolicyTuple | null;
  feeRecipient: Address | null;
  depositCap: bigint | null;
};

export type FactorySettings = {
  asset?: Address;
  feed?: Address;
  clear?: Address;
  implementation?: Address;
  minOtmBps?: number;
  maxOtmBps?: number;
  minPremiumBps?: number;
  maxUtilizationBps?: number;
  protocolFeeBps?: number;
  maxContractsCap?: bigint;
  feeRecipient?: Address;
  depositCap?: bigint;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const present = (a: Address | null): a is Address => a !== null && a.toLowerCase() !== ZERO_ADDRESS;

/**
 * The market columns the setup read seeds: whatever answered, and nothing else, so an unread
 * view leaves its column null (published as unverified) rather than a guessed zero. A zero
 * address is "no factory at that block", not a setting: the constructor reverts `ZeroAddr` on
 * every one of these, and `implementation` is a fresh deployment.
 */
export function factorySettings(reads: FactoryReads): FactorySettings {
  const out: FactorySettings = {};
  if (present(reads.asset)) out.asset = reads.asset;
  if (present(reads.feed)) out.feed = reads.feed;
  if (present(reads.clear)) out.clear = reads.clear;
  if (present(reads.implementation)) out.implementation = reads.implementation;
  if (reads.policy !== null) {
    out.minOtmBps = Number(reads.policy[0]);
    out.maxOtmBps = Number(reads.policy[1]);
    out.minPremiumBps = Number(reads.policy[2]);
    out.maxUtilizationBps = Number(reads.policy[3]);
    out.protocolFeeBps = Number(reads.policy[4]);
    out.maxContractsCap = BigInt(reads.policy[5]);
  }
  if (present(reads.feeRecipient)) out.feeRecipient = reads.feeRecipient;
  if (reads.depositCap !== null) out.depositCap = reads.depositCap;
  return out;
}

/*//////////////////////////////////////////////////////////////
                               KEYS
//////////////////////////////////////////////////////////////*/

/** `market_week.id`. The factory is in the key so a shared database could hold more than one market's weeks. */
export const marketWeekId = (factory: Address, weekId: number | bigint): string =>
  `${factory.toLowerCase()}-${weekId.toString()}`;

/** `lot_fill.id` / `account_settlement.id`: transaction hash and log index, unique per event. */
export const txLogId = (txHash: Hex, logIndex: number): string => `${txHash.toLowerCase()}-${logIndex}`;

/**
 * The expiry an account's listing actually gets: `WriterAccount.list` sets
 * `expiryTs = baseExpiryTs + index`, one second per account index, so every account's option
 * type is distinct in Valorem and no two accounts share a claim bucket.
 */
export const accountExpiryTs = (baseExpiryTs: bigint, index: number): bigint => baseExpiryTs + BigInt(index);
