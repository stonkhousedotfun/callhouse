/**
 * Protocol constants the cranker plans with (callhouse-contracts src/v2/interfaces/V2Constants.sol)
 * and the FIXED gas limits it sends with.
 *
 * WHY FIXED GAS. snapshot, finalize, settle, redeemBatch and roll reach their inner work through
 * try/catch or raw calls that swallow an inner out-of-gas. eth_estimateGas binary-searches the
 * smallest limit at which the OUTER call succeeds, and that is a limit at which the inner call ran
 * out of gas and did nothing: a pool snapshot that records no price, a batch that redeems nobody
 * (the devnet found it). Every limit below is the measured worst case (callhouse-contracts
 * gas table) with headroom; unused gas is not charged.
 *
 * StarvedCall.sol closed that hole at the contract for the calls listed under STARVED_CALL_SLACK below:
 * a guarded call its sender starved now RE-THROWS, so the outer call reverts instead of succeeding having done
 * nothing. A limit too small for one of them is therefore a revert, not a silent no-op, and the limits that reach one
 * are sized from its ceiling.
 */

/* ---- V2Constants.sol ---- */
export const SETTLEMENT_WINDOW = 1_800;
export const FINALIZE_DELAY = 120;
export const SNAPSHOT_GRACE = 600;
export const MIN_SERIES_LEAD = 3_600;
export const MAX_TENOR = 45 * 86_400;
export const PRICE_TICK = 100n;
export const BPS = 10_000n;
// No BUYBACK_COOLDOWN here any more. A change made the buyback cooldown ADMIN-settable
// (FeeSplitter.setBuybackCooldown), so the flywheel step reads FeeSplitter.buybackCooldown() live (cranker/flywheel.ts).
/**
 * How long a cranker buyback may wait for inclusion. FeeSplitter.buybackWithDeadline(minTokenOut, deadline)
 * reverts `DeadlinePassed` once `block.timestamp > deadline`, and the cranker sets `deadline` to the head timestamp it
 * reads just before the probe plus this. A KEEPER choice, not a V2Constants value: it only has to cover the probe, the
 * send's own simulation and inclusion. Short on purpose: `minTokenOut` is a quote of the route at that head, and the
 * deadline is what stops the same floor being filled against a later pool. A buy that misses it moves no USDG (the
 * check runs before any state is read, FeeSplitter.sol buybackWithDeadline) and the next pass quotes afresh.
 */
export const BUYBACK_DEADLINE_S = 120;
/**
 * Most pieces the flywheel SENDS for one Stock Token in one pass (`distributeAmount`, each at GAS.distribute),
 * after `distribute` of the whole balance returned 0. A KEEPER choice; the splitter has no limit on how often it is asked.
 */
export const FLYWHEEL_MAX_PIECES = 8;
/**
 * Most `distributeAmount` SIMULATIONS (eth_calls, never a send) the flywheel makes for one Stock Token in one
 * pass while it looks for the largest piece the splitter fills. With FLYWHEEL_PIECE_STRIDE this reaches pieces as small
 * as balance / 2^121, so the cap binds only on a balance of more than 2^121 base units. A KEEPER choice.
 */
export const FLYWHEEL_PIECE_PROBES = 16;
/**
 * How many halvings the search skips at a time on its way down (a factor of 256), before it bisects back up
 * to the largest piece that fills. Safe while it is well under the width of the band of pieces the splitter fills but
 * values under FLYWHEEL_MIN_PIECE_USDG: 1 USDG down to its DUST skip at one base unit is about 2^20, so a stride of 8
 * cannot step over every piece that fills. A KEEPER choice.
 */
export const FLYWHEEL_PIECE_STRIDE = 8;
/**
 * The least USDG (6-decimal base units) a piece must simulate to before the flywheel sends it: 1 USDG. A
 * KEEPER choice, not a contract number: the splitter takes any piece whose floor is not 0. It keeps the pieces far above
 * the splitter's own DUST skip (a floor that rounds to 0), where the floor's rounding down to a whole base unit is a
 * large part of the price, and a search that finds no piece worth this sends nothing rather than selling crumbs.
 */
export const FLYWHEEL_MIN_PIECE_USDG = 1_000_000n;
/** 1 unit = 0.01 share = 1e16 underlying base units. */
export const UNIT = 10n ** 16n;
export const UNITS_PER_SHARE = 100n;
/** Millionths, the unit of `mintFeePpm` (INTERFACE_VERSION 7). */
export const PPM = 1_000_000n;
/** The period a market's `mintFeePpm` is quoted over: rent is `ppm` millionths of the collateral per 7 days. */
export const MINT_FEE_PERIOD_S = 7 * 86_400;
/** V2Constants.MINT_FEE_CEIL_PPM: the highest rate a market can ever be registered with. */
export const MINT_FEE_CEIL_PPM = 5_000;
/** AutoRoller.ROLL_OPEN_GRACE: how long after a session opens `roll` still wants a spot observed in session that day. */
export const ROLL_OPEN_GRACE_S = 1_800;
/**
 * AutoRoller.MAX_REPRICE_DROP_BPS (`public constant`, AutoRoller.sol:162): the most one `reprice` may
 * lower an ask, bps of the ask it replaces. Below `ask x (BPS - this) / BPS` reprice reverts RepriceDropExceeded.
 */
export const MAX_REPRICE_DROP_BPS = 2_500n;
/**
 * The drop in ONE reprice, bps of the ask it replaces, at or above
 * which the monitor pages v2_mon_reprice_floorward at ERROR: the step a leaked PRICER key walking an ask to the writer's
 * floor sends (0.8 of the contract's per-call cap). One value for both sides: ops/v2/monitor.mjs REPRICE_PAGE_DROP_BPS
 * is pinned equal to this by ops/v2/monitor.test.mjs, which reads this file.
 */
export const REPRICE_PAGE_DROP_BPS = 2_000n;
/**
 * The largest drop the pricer makes in one reprice, bps. Strictly below REPRICE_PAGE_DROP_BPS, so an honest
 * step-down never pages as a leaked key would; deliberately STRICTER than the contract, which accepts up to
 * MAX_REPRICE_DROP_BPS per call. A 50 % fall is reached in about four steps instead of three. Pinned below the page
 * threshold by keeper/src/v2/pricer/planner.test.ts and by ops/v2/monitor.test.mjs.
 */
export const PRICER_MAX_STEP_DROP_BPS = 1_900n;
/** AutoRoller.DAILY_MIN_LEAD: a daily roll's expiry is ExpiryCalendar.nextExpiry(now + this, false) (AutoRoller._plan). */
export const DAILY_MIN_LEAD_S = 7_200;
/**
 * AutoRoller.WITNESS_MAX_AGE (`private constant`, 30 minutes, in AutoRoller.sol): the
 * oldest witness reading `cancelStale` acts on (`_tryWitness`). Private, so it cannot be read on chain: mirrored here.
 */
export const STALE_WITNESS_MAX_AGE_S = 1_800;

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

/* ---- the gas-capped calls (MIRRORED: every one is `private` or `internal` in the contracts) ---- */
/**
 * Each call below is sent with `{gas: CAP}` inside a try/catch. Its failure is taken as the callee's own (a
 * source not ok, a floor miss, a book that cannot pay) only when the calling frame held at least `starvedCeiling(CAP)`
 * just before the call (StarvedCall.belowCeiling, callhouse-contracts src/v2/lib/StarvedCall.sol).
 * Below that, a failure that leaves the frame 1/8 (1/4 for the oracle's source calls) of the gas it read RE-THROWS and
 * reverts the whole transaction. A call that succeeds is unaffected at any limit; so is one that fails early with most
 * of its gas unused. What the keeper must size for is a GENUINE failure that runs most of the way first: a swap that
 * executes and then misses its floor.
 */
/** StarvedCall.CALL_SLACK (StarvedCall.sol:70): gas between the `gasleft()` read and the CALL's EIP-150 split. */
export const STARVED_CALL_SLACK = 10_000n;
/** SettlementOracle.SOURCE_GAS (SettlementOracle.sol:292): each source's `windowPrice`, `latest` and `record` (:947, :1029, :1084). */
export const SOURCE_GAS = 2_000_000n;
/** FeeSplitter.SWAP_GAS (FeeSplitter.sol:69): the conversion swap in `distribute` / `distributeAmount` (:240). */
export const SWAP_GAS = 1_500_000n;
/** Clearinghouse.CONVERSION_GAS (Clearinghouse.sol:113): an ITM call long's USDG conversion in `redeem` / `redeemBatch` (:1161). */
export const CONVERSION_GAS = 1_500_000n;
/**
 * EarnVault.VENUE_PULL_GAS (private constant in EarnVault.sol).
 * `_tryPull` forwards this much to the venue withdraw. A failure is the venue's own only when the caller
 * still held `starvedCeiling` of it (StarvedCall.sol:76-78); under that the failure re-throws and the skim or the
 * queue reverts. Compared by value in ops/v2/contract-mirrors (its fixture is regenerated from the contracts).
 */
export const VENUE_PULL_GAS = 5_000_000n;
/**
 * HouseVault.BOOK_PULL_GAS (private constant in HouseVault.sol).
 * `rollEpoch` sends its book-owed pull (`orderBook.claimOwed`) with this much. A failure is the book's own
 * only when the roll still held `starvedCeiling` of it (`revertIfStarvedBelow`); under that it re-throws and the
 * boundary reverts. Compared by value against the mirrors fixture (ops/v2/contract-mirrors.list.mjs house-book-pull-gas).
 */
export const BOOK_PULL_GAS = 500_000n;
/**
 * The least gas a frame must hold just before a `{gas: cap}` call for no failure of that call to re-throw:
 * `cap + cap / 63 + CALL_SLACK` (StarvedCall.belowCeiling). EIP-150 hands the callee min(cap, 63/64 of what is left).
 */
export const starvedCeiling = (cap: bigint): bigint => cap + cap / 63n + STARVED_CALL_SLACK;
/**
 * The gas a distribute spends before its swap: 21k intrinsic, the paused / treasury / balance / route reads, the
 * buyback counter's write-down (one read, a USDG balance, and at most one write and a log), an
 * UNCAPPED `oracle.trySpot` (FeeSplitter.sol:213; two sources' `latest` and the halt-flag reads), the route fee read,
 * a USDG balance read and the router's `forceApprove`. ESTIMATE, NOT MEASURED: createSeries, which also reads trySpot,
 * measures 194,069 in total, so 300k is generous for everything before the swap.
 */
export const DISTRIBUTE_BEFORE_SWAP_GAS = 300_000n;
/** What a distribute still needs after a swap that failed having burned its whole SWAP_GAS: the approval reset and DistributionSkipped. */
export const DISTRIBUTE_AFTER_SWAP_GAS = 50_000n;
/**
 * The gas one holder's redemption spends before its conversion: the burn, fee and open-interest writes, the prefs read,
 * `_floorPrice`'s trySpot (capped at SPOT_READ_GAS, 240k) and the route fee read. ESTIMATE from the contracts' gas table: an ITM call
 * long paid in kind with the REDEEM bounty measures 169,860 in total, and the spot read is capped.
 */
export const REDEEM_BEFORE_CONVERSION_GAS = 250_000n;

/* ---- fixed gas limits ---- */
export const GAS = {
  /**
   * One createSeries of an expiry this Clearinghouse already pinned: series struct, calendar check, oracle trySpot,
   * and a `pin` that returns after two reads. Per call in a batch.
   *
   * INTERFACE_VERSION 7 appends `mintFeePpm` and `mintFeesHeld` to `Series` instead of packing them into an
   * existing slot (so a v6 positional decoder still reads the first eleven fields), which costs a zero-to-non-zero
   * SSTORE on every create: 166,954 -> 186,854 on the contracts' fixture. The
   * budget moves with it, keeping the same ~90k of headroom the v6 number had.
   */
  createSeriesEach: 280_000n,
  /**
   * On top of createSeriesEach, for the first series of an (underlying, expiry) in a batch while the expiry is not
   * pinned by this Clearinghouse: the oracle's pinned copy (4 fresh slots with two sources, SettlementConfigPinned)
   * plus createSeriesPinPerSource per source (1-2 fresh slots, a log, the selector answer). The gas table: 343,875 for
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
  /**
   * SettlementOracle.snapshot: a Uniswap v3 observe + store, plus the bounty. It values the open interest
   * at spot before paying it: 264,257 on the mock fixture (191,062 before), 563,566 with the finalize that follows.
   */
  snapshot: 800_000n,
  /**
   * SettlementOracle.finalize: a Chainlink round walk costs up to ~700k. Inside
   * [expiry, expiry + SNAPSHOT_GRACE] finalize first runs snapshot's record loop, so a finalize with no snapshot before
   * it records the pool itself (386,705 on the mock fixture, +87,396 over one after a snapshot) and then walks Chainlink.
   *
   * snapshot and finalize both: each source call is capped at SOURCE_GAS and a failure under
   * starvedCeiling(SOURCE_GAS) that used 3/4 of its gas re-throws. A correct source never fails that way at these
   * limits; a source that burns what it is handed makes the simulation revert with no reason, and the step resends at
   * oracleStarvedGas (steps.ts sendPastStarvedSources) rather than giving up on the expiry.
   */
  finalize: 1_500_000n,
  /**
   * Clearinghouse.settle: 133k alone, but it may finalize internally (a Chainlink walk, and inside the grace the pool
   * record). A finalize starved inside it is swallowed by Clearinghouse._finalPrice's catch (Clearinghouse.sol:1268),
   * so settle reads "not final yet" and the finalize step, which resends past a starved source, finalizes it.
   */
  settle: 1_500_000n,
  /** OrderBook.prune per order: an AskResale refund is an ERC-1155 transfer (~60k). */
  pruneEach: 80_000n,
  pruneBase: 60_000n,
  /** redeemBatch per holder paid in kind: 76-87k, 113-170k with the REDEEM bounty. */
  redeemInKindEach: 180_000n,
  /** redeemBatch per ITM call long converted to USDG through the PayoutAdapter: ~307k measured, budget 450k. */
  redeemConvertEach: 450_000n,
  /**
   * ONCE per redeemBatch (and per rollEpoch) that may convert, on top of the per-holder budgets. Since
   * a later change, a conversion that fails under less than starvedCeiling(CONVERSION_GAS) (1,533,809) re-throws when it used
   * 7/8 of what it was handed, and redeemBatch swallows that holder's revert (Clearinghouse.sol:837): the holder is
   * skipped, not paid in kind. A genuine floor miss runs the whole swap before it fails (~200k of the ~307k a converting
   * holder measures), so with only its own 450k left the batch's LAST converting holder was at the edge of that band.
   * With this on top, a holder whose predecessors kept to their budgets reaches its conversion holding at least
   * 63/64 x (redeemConvertEach + this) - REDEEM_BEFORE_CONVERSION_GAS = 1,767,968, above the ceiling, so its failure is
   * always the route's own and pays in kind. A predecessor whose route burned all of CONVERSION_GAS can use most of it;
   * the next converting holder may then be skipped, the batch simulates short, and the step splits it (splitChunk) until
   * each holder runs alone at the tx gas cap.
   */
  redeemConvertReserve: 1_600_000n,
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
   * expiry's first series. The budget moves by 100k, which keeps the worst case
   * (a close-out whose settle walks Chainlink plus a first-of-expiry roll on three sources) under 80 % of the limit.
   *
   * A close-out settle that finalizes inside [expiry, expiry + SNAPSHOT_GRACE] before any snapshot
   * also records the pool (+87,396 on the mock fixture). With it the worst case is ~2.07M on the mock fixture, 79.5 %
   * of this limit, and a live pool's observe costs more than the mock's: the thinnest margin in this table. Not
   * re-measured on a fork. Starved, it fails one of the two ways described above; both leave the roll to a later tick.
   */
  roll: 2_600_000n,
  /**
   * AutoRoller.cancelStale: getOrders(1), the series and market reads, one oracle trySpot, OrderBook.cancel of
   * one AskWrite and the CANCEL_STALE bounty. 182,061 measured with the bounty, 135,193 without, 30,292 for the early
   * `false` of a writer with no position (AutoRoller); contracts docs name 350,000 as the keeper's budget.
   */
  cancelStale: 350_000n,
  /** Clearinghouse.sweepFees: one transfer. */
  sweepFees: 150_000n,
  /**
   * FeeSplitter.claimOrderBookFees: OrderBook.claimOwed into the splitter — one storage clear and one ERC-20
   * transfer, plus the splitter's own accounting.
   *
   * ESTIMATE, NOT MEASURED. The contracts' gas table has one flywheel-adjacent row (sweepFees
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
   * in `try IPayoutAdapter(router_).swapToUsdg{gas: SWAP_GAS}(...) { } catch { ...; emit DistributionSkipped(asset,
   * SKIP_BELOW_FLOOR); return 0; }` (FeeSplitter `_distribute`, :240-254). Earlier eth_estimateGas found the
   * limit at which the swap ran out of gas and the catch fired: a distribute sent on an estimate never reverted and
   * never worked. Now that starved swap re-throws instead, but ONLY below starvedCeiling(SWAP_GAS)
   * (1,533,809 held at the swap), and it re-throws a GENUINE floor miss too when the swap ran most of the way first (the
   * router swaps with no price limit, PayoutRouter.sol:193/:229). At the old 900k a large piece that misses its floor
   * reverted instead of returning 0, which ended the flywheel's piece search (flywheel.ts) before it looked
   * at a smaller piece. 2.0M >= DISTRIBUTE_BEFORE_SWAP_GAS + 1,533,809 + DISTRIBUTE_AFTER_SWAP_GAS
   * (1,883,809), so the swap is always handed its whole SWAP_GAS and any failure of it is a SKIP_BELOW_FLOOR.
   */
  distribute: 2_000_000n,
  /**
   * FeeSplitter.buybackWithDeadline(minTokenOut, deadline) -> V4BuybackExecutor.execute (the deadline is one
   * comparison before the body the frozen `buyback` used to run): the splitter's two `forceApprove`s and its
   * supply reads, then the executor's v3 USDG->WETH swap, the WETH withdraw, the Uniswap v4 unlock and swap
   * through the pinned hook (which charges a fee and a creator tax), and the STONKHOUSE burn with its
   * totalSupply delta check (V4BuybackExecutor `execute`).
   *
   * ESTIMATE, NOT MEASURED. The v4 unlock/callback round trip is the largest unknown here; the budget is sized
   * so a cold pool and a cold hook still fit.
   */
  buyback: 1_200_000n,
  /**
   * OrderBook.take buying ONE unit of an AskWrite into the keeper's EOA, on an expiry this Clearinghouse has not pinned
   * (firstmint.ts): the book's plan, Clearinghouse.mint under DELIVERY_GAS (500,000) with the expiry's `pin`, the
   * USDG pull and payouts. Measured 537,900 on a 4663 fork with the v9 rehearsal state loaded (NVDA, two sources).
   * The margin is for the 63/64 rule: the mint must still be offered its full DELIVERY_GAS.
   */
  firstMintTake: 1_200_000n,
  /** USDG.approve(OrderBook, FIRST_MINT_DAILY_CAP) from the keeper, before its first first-mint take. */
  usdgApprove: 100_000n,
} as const;

/* ---- first mint (firstmint.ts) ---- */
/** Most USDG (6-decimal base units) the firstmint step may spend in one UTC day, premium plus taker fee: 5 USDG. */
export const FIRST_MINT_DAILY_CAP = 5_000_000n;
/** Most one first mint may cost, premium plus the taker fee at its ceiling: 0.50 USDG. A dearer ask is not taken. */
export const FIRST_MINT_MAX_COST = 500_000n;
/** V2Constants.TAKER_FEE_CAP_CEIL_BPS: the compiled ceiling of the taker fee, 10 % of the premium. */
export const TAKER_FEE_CAP_CEIL_BPS = 1_000n;
/** A first-mint take's deadline from the head, and the least life an ask must have left to be named in one. */
export const FIRST_MINT_DEADLINE_S = 120;
/** No first mint this close to the mint cutoff (`expiry - SETTLEMENT_WINDOW`): one mined past it reverts PastCutoff. */
export const FIRST_MINT_CUTOFF_MARGIN_S = 300;
/** An expiry still unpinned, with no ask the step may take, this close to its mint cutoff pages once. */
export const FIRST_MINT_NO_ASK_ALERT_S = 6 * 3_600;
/** Most ask ids named in one take (the cheapest of one series; the book fills the first it can). */
export const FIRST_MINT_MAX_ORDER_IDS = 8;
/** Newest order ids read per series when looking for an ask. */
export const FIRST_MINT_ORDER_SCAN = 200n;
/** Most first mints per tick (each is one take, plus one approve the first time). */
export const FIRST_MINT_MAX_PER_TICK = 4;
