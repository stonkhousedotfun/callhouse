/**
 * Protocol constants the cranker plans with (callhouse-contracts src/v2/interfaces/V2Constants.sol)
 * and the FIXED gas limits it sends with.
 *
 * WHY FIXED GAS. snapshot, finalize, settle, redeemBatch and roll reach their inner work through
 * try/catch or raw calls that swallow an inner out-of-gas. eth_estimateGas binary-searches the
 * smallest limit at which the OUTER call succeeds, and that is a limit at which the inner call ran
 * out of gas and did nothing: a pool snapshot that records no price, a batch that redeems nobody
 * (F2-04's devnet found it). Every limit below is the measured worst case (callhouse-contracts
 * docs/V2-GAS.md, C2-04/C2-05/C2-09/C2-10 hand-offs) with headroom; unused gas is not charged.
 */

/* ---- V2Constants.sol ---- */
export const SETTLEMENT_WINDOW = 1_800;
export const FINALIZE_DELAY = 120;
export const SNAPSHOT_GRACE = 600;
export const MIN_SERIES_LEAD = 3_600;
export const MAX_TENOR = 45 * 86_400;
export const PRICE_TICK = 100n;
export const BPS = 10_000n;
/**
 * V2Constants.sol:63 `BUYBACK_COOLDOWN = 5 minutes`: the least time between two FeeSplitter buybacks. Compiled,
 * not configurable — it exists so small buys cannot be stacked into one sandwichable block. The cranker reads
 * `lastBuybackAt()` and does not even PROBE before `lastBuybackAt + BUYBACK_COOLDOWN`, because a probe inside
 * the window only ever answers `CooldownActive`.
 */
export const BUYBACK_COOLDOWN = 300;
/** 1 unit = 0.01 share = 1e16 underlying base units. */
export const UNIT = 10n ** 16n;
export const UNITS_PER_SHARE = 100n;
/** Millionths, the unit of `mintFeePpm` (INTERFACE_VERSION 7, c05). */
export const PPM = 1_000_000n;
/** The period a market's `mintFeePpm` is quoted over: rent is `ppm` millionths of the collateral per 7 days. */
export const MINT_FEE_PERIOD_S = 7 * 86_400;
/** V2Constants.MINT_FEE_CEIL_PPM: the highest rate a market can ever be registered with. */
export const MINT_FEE_CEIL_PPM = 5_000;
/** AutoRoller.ROLL_OPEN_GRACE: how long after a session opens `roll` still wants a spot observed in session that day. */
export const ROLL_OPEN_GRACE_S = 1_800;

/** SettlementOracle.SettlementStatus, in enum order. */
export const SETTLEMENT_STATUS = ['None', 'Pending', 'Finalized', 'Held'] as const;
export type SettlementStatusName = (typeof SETTLEMENT_STATUS)[number];

/** OrderBook OrderKind, in enum order. */
export const ORDER_KIND = ['Bid', 'AskResale', 'AskWrite'] as const;
export type OrderKindName = (typeof ORDER_KIND)[number];

/* ---- planning margins ---- */
/** Ladders start at expiries at least MIN_SERIES_LEAD plus this away, so a createSeries sent now
 *  is not refused BadExpiry by the time it is mined. */
export const LADDER_LEAD_MARGIN_S = 300;
/** A wake-up fires this long after the target second, so the head block's timestamp has reached it. */
export const WAKE_MARGIN_MS = 1_500;
/** Never re-arm a wake-up sooner than this (no hot loop on a lagging head). */
export const MIN_WAKE_DELAY_MS = 500;

/** SettlementOracle.MAX_SOURCES: the pin budget of an expiry whose source count cannot be read. */
export const MAX_ORACLE_SOURCES = 8;
/** After a refused pin (cranker/pin.ts), the (underlying, expiry) is skipped this long before a simulation asks again. */
export const PIN_REFUSED_RECHECK_S = 900;

/* ---- fixed gas limits ---- */
export const GAS = {
  /**
   * One createSeries of an expiry this Clearinghouse already pinned: series struct, calendar check, oracle trySpot,
   * and a `pin` that returns after two reads. Per call in a batch.
   *
   * INTERFACE_VERSION 7 (c05) appends `mintFeePpm` and `mintFeesHeld` to `Series` instead of packing them into an
   * existing slot (so a v6 positional decoder still reads the first eleven fields), which costs a zero-to-non-zero
   * SSTORE on every create: 166,954 -> 186,854 on the contracts' fixture (V2-GAS.md "INTERFACE_VERSION 7"). The
   * budget moves with it, keeping the same ~90k of headroom the v6 number had.
   */
  createSeriesEach: 280_000n,
  /**
   * On top of createSeriesEach, for the first series of an (underlying, expiry) in a batch while the expiry is not
   * pinned by this Clearinghouse: the oracle's pinned copy (4 fresh slots with two sources, SettlementConfigPinned)
   * plus createSeriesPinPerSource per source (1-2 fresh slots, a log, the selector answer). V2-GAS.md: 343,875 for
   * the first series on two sources against 162,168 for the next. The devnet (v2:devnet-cycle, eth_estimateGas):
   * NVDA (Chainlink + pool) 352,638 first, 170,919 next (pin +181,719); TSLA (Chainlink) 269,965 first, 170,907 next
   * (pin +99,058): the pool source adds ~83k. Budgets: 460k for one source, 550k for two, 640k for three. Before v6 a
   * lone first series of a two-source expiry was sent with 250k + 60k: its pin ran out of gas and, failing closed,
   * reverted the create, so that ladder rung never appeared.
   */
  createSeriesPinBase: 120_000n,
  createSeriesPinPerSource: 90_000n,
  /** Multicall3.aggregate3 overhead of a createSeries batch. */
  createSeriesBase: 60_000n,
  /** The gas a pin-refusal probe (an eth_call of one createSeries, cranker/pin.ts) runs with: ample, so a source without revert data is conclusive. */
  createSeriesProbe: 3_000_000n,
  /** SettlementOracle.snapshot: a Uniswap v3 observe + store, plus the bounty (< 400k with finalize). */
  snapshot: 800_000n,
  /** SettlementOracle.finalize: a Chainlink round walk costs up to ~700k (C2-04). */
  finalize: 1_500_000n,
  /** Clearinghouse.settle: 133k alone, but it may finalize internally (a Chainlink walk). */
  settle: 1_500_000n,
  /** OrderBook.prune per order: an AskResale refund is an ERC-1155 transfer (~60k). */
  pruneEach: 80_000n,
  pruneBase: 60_000n,
  /** redeemBatch per holder paid in kind: 76-87k, 113-170k with the REDEEM bounty (V2-GAS.md). */
  redeemInKindEach: 180_000n,
  /** redeemBatch per ITM call long converted to USDG through the PayoutAdapter: ~307k measured, budget 450k (C2-10). */
  redeemConvertEach: 450_000n,
  redeemBase: 60_000n,
  /**
   * AutoRoller.roll. INTERFACE_VERSION 6 (AutoRollerCycleTest.test_gas_rollAndCloseOut): the first roll into an
   * expiry creates its first series and pays the pin, 718,819 (535k before pinning); close-out 437,284; the next
   * period's roll 647,720. One call can close out and roll: a close-out whose settle walks Chainlink (+~830k: settle
   * finalizing 170k with a 96-read walk of 661k) and a first-of-expiry roll on three sources come to ~1.95M on the
   * mock fixture, more with live tokens: 2.0M (the limit before v6) left under 3 % of that. Starved, the close-out's
   * try/catch settle fails quietly and the roll no-ops until the settle step has settled the series, or the new
   * series' pin fails closed and the roll reverts.
   *
   * INTERFACE_VERSION 7 adds, per roll that places: the appended-slot write of the new series (+19,900), the rent
   * `mint` charges (+3,473), and the `seriesExists` + `mintFee` reads and one or two extra `isRegularSession` calls
   * that size it net of rent and hold it inside the open grace (+10-13k) — about 35k on a roll that creates its
   * expiry's first series (V2-GAS.md "INTERFACE_VERSION 7"). The budget moves by 100k, which keeps the worst case
   * (a close-out whose settle walks Chainlink plus a first-of-expiry roll on three sources) under 80 % of the limit.
   */
  roll: 2_600_000n,
  /**
   * AutoRoller.cancelStale (c16): getOrders(1), the series and market reads, one oracle trySpot, OrderBook.cancel of
   * one AskWrite and the CANCEL_STALE bounty. 182,061 measured with the bounty, 135,193 without, 30,292 for the early
   * `false` of a writer with no position (V2-GAS.md AutoRoller); contracts docs name 350,000 as the keeper's budget.
   */
  cancelStale: 350_000n,
  /** Clearinghouse.sweepFees: one transfer. */
  sweepFees: 150_000n,
  /**
   * FeeSplitter.claimOrderBookFees: OrderBook.claimOwed into the splitter — one storage clear and one ERC-20
   * transfer, plus the splitter's own accounting.
   *
   * ESTIMATE, NOT MEASURED. callhouse-contracts docs/V2-GAS.md has one flywheel-adjacent row (sweepFees
   * 68,283) and nothing at all for the splitter or the executor, so every number in this block is sized by
   * hand against the route named in its comment and carries the same kind of headroom the measured entries do.
   * Sized against: `owed` clear + one USDG transfer + the splitter's pending-USDG read.
   */
  claimOrderBookFees: 200_000n,
  /**
   * FeeSplitter.distribute(asset). The heaviest path is a Stock Token asset: an oracle spot read, the floor
   * arithmetic, `forceApprove` to the router and back to zero, PayoutRouter.swapToUsdg over a Uniswap v3 pool,
   * then the USDG split (treasury transfer plus the buyback accrual).
   *
   * ESTIMATE, NOT MEASURED, and the number that matters most in this table. `distribute` wraps the conversion
   * in `try IPayoutAdapter(router_).swapToUsdg(...) { } catch { emit DistributionSkipped(asset,
   * SKIP_BELOW_FLOOR); return 0; }` (FeeSplitter.sol:131-139). eth_estimateGas binary-searches the smallest
   * limit at which the OUTER call succeeds — which is the limit at which the swap runs out of gas, the catch
   * fires, and the call "succeeds" having converted nothing. A distribute sent on an estimate would never
   * revert and never work. That is the same failure this file's header was written for.
   */
  distribute: 900_000n,
  /**
   * FeeSplitter.buyback(minTokenOut) -> V4BuybackExecutor.execute: the splitter's two `forceApprove`s and its
   * supply reads, then the executor's v3 USDG->WETH swap, the WETH withdraw, the Uniswap v4 unlock and swap
   * through the pinned hook (which charges a fee and a creator tax), and the STONKHOUSE burn with its
   * totalSupply delta check (V4BuybackExecutor.sol:396-447).
   *
   * ESTIMATE, NOT MEASURED. The v4 unlock/callback round trip is the largest unknown here; the budget is sized
   * so a cold pool and a cold hook still fit.
   */
  buyback: 1_200_000n,
} as const;
