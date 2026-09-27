/**
 * The pure half of the public Earn yield and of "earliest withdrawal" for every vault: no database, no
 * RPC, so each branch is tested on its own (earnYield.test.ts). The sampler (earnSample.ts) and the routes
 * (api/v2/earn.ts, api/v2/house.ts) do the reads and hand the values here.
 *
 * Every rule below MIRRORS callhouse-contracts at the attached base (src/v2/periphery/earn/EarnVault.sol,
 * src/v2/periphery/earn/adapters/Erc4626VenueAdapter.sol, src/v2/periphery/house/HouseVault.sol). The line
 * references are to that source; a change there is a change here.
 */

/**
 * EarnVault.ONE_SHARE (a compiled 1e18, EarnVault.sol:263): `highWaterMark()` reports per it
 * (EarnVault.sol:1407), so {pricePerShare} must use the SAME constant to be compared with the mark, not `decimals()`.
 * It is also one whole share (18 decimals over a 1e12-per-USDG-unit first mint), so the price reads
 * about 1e6 USDG base units at par, not ~1e18.
 */
export const ONE_SHARE = 10n ** 18n;
/** V2Constants.BPS: `skim` divides `gain * skimBps` by it (EarnVault.sol:662). */
export const BPS = 10_000n;
export const YEAR_S = 365 * 86_400;
export const DAY_S = 86_400;
/** One sample per vault per hour (v2EarnVaultSample.id). */
export const EARN_SAMPLE_INTERVAL_S = 3_600;
/**
 * The share amount the venue's `convertToAssets` is asked about. Only the RATIO between two samples is used, so the
 * value is arbitrary as long as it never changes; it is large so a 6-decimal asset keeps precision against an
 * 18-decimal share (1e18 shares of a Morpho vault convert to ~1e6 USDG units, too coarse for a 24h growth figure).
 */
export const EARN_VENUE_PROBE_SHARES = 10n ** 27n;

export type ApyReason = "no-samples" | "short-history" | "no-price" | "out-of-range";

export type Apy = {
  bps: number | null;
  reason: ApyReason | null;
  from: number | null;
  to: number | null;
};

export type PriceSample = { ts: number; price: bigint };

/**
 * `totalAssets * 1e18 / totalSupply`: the unit `highWaterMark()` is reported in (the vault keeps its own
 * `_pricePerShare` 1e12 times finer, EarnVault.sol:1605, and reports the mark floored to this). The contract answers 0 for
 * an empty supply; this answers null, because a stored 0 would later read as a total loss rather than "no price".
 */
export function pricePerShare(totalAssets: bigint | null, totalSupply: bigint | null): bigint | null {
  if (totalAssets === null || totalSupply === null || totalSupply === 0n) return null;
  return (totalAssets * ONE_SHARE) / totalSupply;
}

/**
 * The price a holder keeps if `skim()` ran at this block: `price` less the fee it would take.
 * `skim` charges `(priceNow - mark) * supply / markUnit * skimBps / BPS` and nothing at or below the mark,
 * so per whole share that is `(price - mark) * skimBps / BPS`. This is a holder-keeps figure, not yield.
 * The mark also rises on a mint (EarnVault._markAfterMint), so a higher mark with the same share
 * price is not income. Realised APY uses {realisedSamplePrice}, the gross share price.
 */
export function netOfSkim(price: bigint | null, highWaterMark: bigint | null, skimBps: number | null): bigint | null {
  if (price === null || highWaterMark === null || skimBps === null) return null;
  if (price <= highWaterMark) return price;
  return price - ((price - highWaterMark) * BigInt(skimBps)) / BPS;
}

/**
 * The price realised APY is measured on. The gross share price, never {netOfSkim}.
 * A mint blends the mark upward without a fee, so the net-of-mark series can rise while the share
 * price does not. The cut that actually left the vault is the Skimmed fee.
 */
export function realisedSamplePrice(sample: {
  pricePerShare: bigint | null;
  netPricePerShare?: bigint | null;
}): bigint | null {
  return sample.pricePerShare;
}

/** What one Skimmed log meant. `skimBps` is the rate in force when the log was emitted, or null if unseen. */
export type SkimmedKind = "collected" | "nothing" | "zero-rate" | "dust" | "refused";

/**
 * Three shapes the vault emits, plus the zero-rate and dust shapes:
 *   fee > 0                         collected — the fee left the vault
 *   gain == 0 && fee == 0           nothing — flat, a loss, an open queue, or an unreadable venue
 *                                   (the log does not split those; the mark is unchanged)
 *   gain > 0 && fee == 0 && bps 0   zero-rate — the mark moves to the price and nothing is owed
 *   gain > 0 && fee == 0 && bps > 0 && gain * bps / BPS == 0
 *                                   dust — the fee rounds to nothing at this rate, so the vault moves
 *                                   the mark to the price and nothing is owed (EarnVault._settleSkim's `fee == 0`
 *                                   arm; `_skimFeeOn(gain) = gain * skimBps / BPS`)
 *   gain > 0 && fee == 0 && bps > 0 refused — the fee was due and the vault could not raise or deliver it; still owed
 *   gain > 0 && fee == 0 && bps null  refused — the rate was not observed; fail closed toward "still owed"
 * a processQueue that drains the queue runs the same skim (EarnVault.sol:808), so these
 * shapes come from that call too. Dust is reachable there: the fee the drain charges is measured again after the mints
 * and any redemptions in between, so a fee of a unit or two when the first deposit was priced can round to nothing.
 */
export function classifySkimmed(gain: bigint, fee: bigint, skimBps: number | null): SkimmedKind {
  if (fee > 0n) return "collected";
  if (gain === 0n) return "nothing";
  if (skimBps === 0) return "zero-rate";
  if (skimBps !== null && (gain * BigInt(skimBps)) / BPS === 0n) return "dust";
  return "refused";
}

/**
 * Growth from `start` to `end`, compounded to a 365-day year, in signed bps. NEVER EXTRAPOLATED: `start` must sit at
 * least `windowS` before `end` (the caller picks the newest sample at or before `end.ts - windowS`), so a vault with
 * less history than the window gets null and `short-history`, not a figure annualised from a few hours.
 */
export function trailingApy(end: PriceSample | undefined, start: PriceSample | undefined, windowS: number): Apy {
  if (end === undefined) return { bps: null, reason: "no-samples", from: null, to: null };
  if (start === undefined || end.ts - start.ts < windowS) {
    return { bps: null, reason: "short-history", from: null, to: end.ts };
  }
  if (start.price <= 0n) return { bps: null, reason: "no-price", from: start.ts, to: end.ts };
  const span = end.ts - start.ts;
  // 1e12 fixed point keeps ~12 significant digits of the ratio through the Number conversion.
  const ratio = Number((end.price * 10n ** 12n) / start.price) / 1e12;
  const bps = Math.round(Math.expm1((Math.log(ratio) * YEAR_S) / span) * 10_000);
  if (!Number.isSafeInteger(bps)) return { bps: null, reason: "out-of-range", from: start.ts, to: end.ts };
  return { bps, reason: null, from: start.ts, to: end.ts };
}

export type VenueLiquidity = { amount: bigint | null; source: "maxWithdraw" | "position" | null };

/**
 * What the vault can take out of its venue now.
 *
 * Erc4626VenueAdapter.withdrawable() answers 0 whenever `maxIsAdvisory` (a venue whose `maxDeposit` read 0 at
 * construction, i.e. a Morpho Vault V2 such as Steakhouse USDG), yet `withdraw` still pays there through
 * `_withdrawAdvisory`, which redeems against `convertToAssets(balanceOf(adapter))` and never consults `maxWithdraw`
 * (Erc4626VenueAdapter.sol `withdrawable`, `_withdrawAdvisory`). EarnVault._raise -> _pull calls that `withdraw`
 * and is never capped by `withdrawable()` (EarnVault.sol:1412-1431). So on an advisory venue the figure is the
 * position (`adapter.totalAssets()`), and on a standard ERC-4626 venue it is `maxWithdraw`, which there is the
 * real bound at high utilisation. An adapter whose `maxIsAdvisory` cannot be read (not an Erc4626VenueAdapter) is
 * not read, never guessed in either direction.
 */
export function venueLiquidity(input: {
  advisory: boolean | null;
  withdrawable: bigint | null;
  position: bigint | null;
}): VenueLiquidity {
  if (input.advisory === true) {
    return input.position === null ? { amount: null, source: null } : { amount: input.position, source: "position" };
  }
  if (input.advisory === false) {
    return input.withdrawable === null
      ? { amount: null, source: null }
      : { amount: input.withdrawable, source: "maxWithdraw" };
  }
  return { amount: null, source: null };
}

export type EarliestWithdrawal = {
  kind: "now" | "queued" | "weekly" | "daily" | "unknown";
  at: number | null;
  reason:
    | "liquid"
    | "open-position"
    | "queue-ahead"
    | "venue-liquidity"
    | "venue-unreadable"
    | "epoch-boundary"
    | "boundary-pending"
    | "queue-closed"
    | "not-read";
  liquidityCap?: string | null;
};

const EARN_NOT_READ: EarliestWithdrawal = { kind: "unknown", at: null, reason: "not-read", liquidityCap: null };

/**
 * EarnVault, in the order `redeem` decides (EarnVault.sol:435-468):
 *   1. `_positionOpen()` -> the redemption queues, and `processQueue` serves nothing until every position is gone
 *      (:474-480). `at` is the latest expiry among the positions still held: the earliest the queue can move.
 *   2. The venue cannot be read (its last known value is not 0, or reached 0 only by
 *      subtracting pulls) -> nothing is priced: the redemption queues even when the wallet could pay it, and
 *      `processQueue` serves nothing, so an open queue waits on the venue too. Named BEFORE queue-ahead for that
 *      reason, as open-position is (the queued cards read this reason). `venueUnreadable` is the vault's
 *      own answer (convertToAssets reverting VenueUnreadable); unread is not-read (below), never "liquid".
 *   3. `_queueOpen()` (head <= tail, :1229-1231) -> it joins the back of the queue. Queued DEPOSITS hold it open too,
 *      and so does a cancelled entry until `processQueue` walks past it, which is why this reads `queue()` live
 *      rather than counting indexed rows.
 *   4. Otherwise `_raise(owed)` pays from the unescrowed wallet, then the vault's free Clearinghouse ledger, then a
 *      venue pull. Up to that sum is paid now; a zero sum queues.
 * `wallet` is `asset.balanceOf(vault) - escrowedAssets() - deferredAssets()`, saturating as `_unescrowed` is (see
 * {unescrowed}). `ledger` is `Clearinghouse.free(vault, asset)`: EarnVault._raise pulls it before the
 * venue, and leaving it out answered "venue-liquidity" (or a smaller cap) for a redemption `redeem` pays now.
 * `venueAttached` false means `_raise` has no venue to pull from (adapter == 0), so the venue term is 0 rather than unread.
 */
export function earnEarliestWithdrawal(input: {
  now: number;
  positionOpen: boolean | null;
  positionExpiry: number | null;
  queueOpen: boolean | null;
  venueUnreadable: boolean | null;
  wallet: bigint | null;
  ledger: bigint | null;
  venueAttached: boolean;
  venue: bigint | null;
}): EarliestWithdrawal {
  if (input.positionOpen === null) return { ...EARN_NOT_READ };
  if (input.positionOpen) {
    return { kind: "queued", at: input.positionExpiry, reason: "open-position", liquidityCap: null };
  }
  if (input.venueUnreadable === true) return { kind: "queued", at: null, reason: "venue-unreadable", liquidityCap: null };
  if (input.queueOpen === null) return { ...EARN_NOT_READ };
  if (input.queueOpen) return { kind: "queued", at: null, reason: "queue-ahead", liquidityCap: null };
  if (input.venueUnreadable === null) return { ...EARN_NOT_READ };
  const venue = input.venueAttached ? input.venue : 0n;
  if (input.wallet === null || input.ledger === null || venue === null) return { ...EARN_NOT_READ };
  const cap = input.wallet + input.ledger + venue;
  if (cap === 0n) return { kind: "queued", at: null, reason: "venue-liquidity", liquidityCap: "0" };
  return { kind: "now", at: input.now, reason: "liquid", liquidityCap: cap.toString() };
}

/**
 * The custom error a viem call error decoded against the call's ABI (ContractFunctionRevertedError's
 * `data.errorName`), anywhere in its cause chain; null when there is none (an RPC failure, a revert with no data).
 */
export function revertErrorName(error: unknown): string | null {
  let e: unknown = error;
  for (let i = 0; i < 12 && typeof e === "object" && e !== null; i += 1) {
    const data = (e as { data?: unknown }).data;
    if (typeof data === "object" && data !== null) {
      const name = (data as { errorName?: unknown }).errorName;
      if (typeof name === "string") return name;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * `_unescrowed()` = `_deliverable(wallet, 0)` (EarnVault.sol): the wallet minus queued-deposit escrow AND the payments
 * held for `claimDeferred`, floored at zero. That is what `_raise` can pay a redeemer from before a venue
 * pull. This subtracted escrow only, so it counted deferred receivers' money as liquid and could answer
 * "liquid", with a larger cap, for a redemption the contract queues. Any unread term is null, never 0: reading
 * deferred as 0 would repeat exactly that overstatement.
 */
export function unescrowed(balance: bigint | null, escrowed: bigint | null, deferred: bigint | null): bigint | null {
  if (balance === null || escrowed === null || deferred === null) return null;
  const reserved = escrowed + deferred;
  return balance > reserved ? balance - reserved : 0n;
}

/**
 * HouseVault. Before `epochEnd - settlementWindow`, a withdrawal requested now is priced at this epoch's end
 * (`rollEpoch`). From that cutoff until `rollEpoch` moves `epochEnd`, `requestWithdraw` reverts (HouseVault
 * `_requireBeforeCutoff`), so the answer is `queue-closed` and `at` is the NEXT epoch's end when the
 * caller knows it. `boundary-pending` stays on the wire for an older indexer; this function no longer returns it.
 */
export function houseEarliestWithdrawal(input: {
  now: number;
  kind: "weekly" | "daily" | "unknown";
  epochEnd: number | null;
  /** Seconds. The queue shuts once `now + settlementWindow >= epochEnd`. */
  settlementWindow: number;
  /** Epoch end after the next roll. Null when it has not been read. */
  nextEpochEnd?: number | null;
}): EarliestWithdrawal {
  if (input.epochEnd === null) return { kind: input.kind, at: null, reason: "not-read" };
  if (input.now + input.settlementWindow >= input.epochEnd) {
    return { kind: input.kind, at: input.nextEpochEnd ?? null, reason: "queue-closed" };
  }
  return { kind: input.kind, at: input.epochEnd, reason: "epoch-boundary" };
}
