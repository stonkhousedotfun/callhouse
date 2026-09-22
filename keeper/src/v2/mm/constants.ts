/**
 * What the MM bot plans with: protocol constants (callhouse-contracts V2Constants.sol, MakerVault.sol)
 * and the FIXED gas limits of its vault calls.
 *
 * WHY FIXED GAS. MakerVault.cancel and replace reach OrderBook refunds that are best-effort transfers
 * (OrderBook._payOrOwe: a USDG transfer that fails is credited to `owed` instead of reverting). An
 * eth_estimateGas limit is the smallest at which the outer call succeeds, which can be one where the
 * inner transfer ran out of gas and the refund went to `owed` (F2-04 found the same shape in the
 * oracle). The limits below are the measured worst case with headroom (keeper/README.md "The MM bot"
 * records the devnet numbers); unused gas is not charged.
 */

/* ---- V2Constants.sol / MakerVault.sol ---- */
export const PRICE_TICK = 100n;
export const BPS = 10_000n;
export const UNITS_PER_SHARE = 100n;
/** Clearinghouse.mintCutoff(longId) = expiry − SETTLEMENT_WINDOW. */
export const SETTLEMENT_WINDOW = 1_800;
/** MakerVault.MAX_LIVE_ORDERS_PER_SERIES. The bot keeps at most three (bid, write ask, resale ask). */
export const MAX_LIVE_ORDERS_PER_SERIES = 16;
/**
 * V2Constants.FEE_CHANGE_DELAY: OrderBook.setFeeParams takes effect this long after it is scheduled.
 * INTERFACE_VERSION 8 raised it from 24 h to 48 h (owner decision V3-D13) — read from
 * `callhouse-contracts src/v2/interfaces/V2Constants.sol:60`, `uint40 internal constant FEE_CHANGE_DELAY =
 * 48 hours`, whose own comment at :56-59 explains that this is the window makers and takers see ON CHAIN
 * and that the AccessManager's 48 h FEE_MANAGER execution delay runs BEFORE the change is even scheduled.
 */
export const FEE_CHANGE_DELAY_S = 172_800;
/** V2Constants.PREMIUM_FEE_CEIL_BPS: the most premiumFeeBps and resaleFeeBps can ever be. */
export const PREMIUM_FEE_CEIL_BPS = 1_000;
/**
 * MakerVault.OUTFLOW_WINDOW (INTERFACE_VERSION 7, c21): the window `Limits.maxDailyOutflow` refills over. The vault
 * charges the NET USDG a quoter call moves out of `usdg.balanceOf(vault) + orderBook.owed(vault)` against a leaky
 * bucket that refills linearly over this window, so the quoter pays out at most the cap at once and at most twice the
 * cap in 24 h. Placing or replacing a Bid, and `take`, are booked AND enforced; a cancel is booked as a credit and
 * never enforced; the ask side, `close`, `claimOwed`, `sync` and the ledger moves are not booked at all.
 */
export const OUTFLOW_WINDOW_S = 86_400;

/** OrderBook OrderKind, in enum order. */
export const ORDER_KIND = ['Bid', 'AskResale', 'AskWrite'] as const;
export type OrderKindName = (typeof ORDER_KIND)[number];
export const KIND_INDEX: Record<OrderKindName, number> = { Bid: 0, AskResale: 1, AskWrite: 2 };

/* ---- fixed gas limits ---- */
export const MM_GAS = {
  /** vault.place: two exposure scans of up to 16 orders, the book's place (Bid 243k with escrow), tracking writes. */
  place: 1_200_000n,
  /** vault.replace: getOrders(1), two scans, the book's replace (AskResale: refund + re-escrow). */
  replace: 1_200_000n,
  /** vault.cancel: base, plus per order the book's refund (<= 66k) and one exposure refresh. */
  cancelBase: 150_000n,
  cancelEach: 250_000n,
  /** vault.sync: per series one exposure refresh. */
  syncBase: 80_000n,
  syncEach: 200_000n,
  /** vault.close: the Clearinghouse burns a long and a short and frees collateral, then one exposure refresh. */
  close: 600_000n,
  /** vault.claimOwed: one USDG transfer from the book. */
  claimOwed: 250_000n,
  /** vault.depositToClearinghouse: an exact approval and the Clearinghouse deposit (a Stock Token transfer). */
  deposit: 400_000n,
} as const;

/** Most order ids in one vault.cancel, and series in one vault.sync. */
export const CANCEL_CHUNK = 20;
export const SYNC_CHUNK = 25;

/* ---- the series log scan ---- */
export const LOG_CHUNK_BLOCKS = 50_000;
export const LOG_CHUNKS_PER_TICK = 40;
export const REORG_OVERLAP = 5n;
/**
 * The series scan's re-read below its cursor: 100 blocks, ~10 s at 0.1 s blocks, over the few blocks two nodes behind
 * one RPC URL disagree by (cranker/scanner.ts). Inserts are idempotent. The fill-log read keeps REORG_OVERLAP.
 */
export const SERIES_REORG_OVERLAP = 100n;
/**
 * The OrderFilled read of a tick's sales (fills.ts): LOG_CHUNK_BLOCKS ranges back from the head, at most this many. Normally
 * one range reaches the previous look; a longer gap (a bot down for hours) books what the ranges cannot account for
 * conservatively.
 */
export const FILL_LOG_MAX_CHUNKS = 4;

/** Concurrent /fair requests per tick. */
export const PRICING_CONCURRENCY = 8;
/** How long POST /kill waits for its cancels before answering 202 (they carry on). */
export const KILL_RESPONSE_WAIT_MS = 60_000;
