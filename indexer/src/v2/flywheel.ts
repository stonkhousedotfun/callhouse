import schema from "ponder:schema";
import { parseEventLogs, type Address, type Hex } from "viem";

import { erc20Abi } from "../../abis/erc20";
import { stockTokenAbi } from "../../abis/stockToken";
import { feeSplitterAbi } from "../../abis/v2/feeSplitter";
import { orderBookAbi } from "../../abis/v2/orderBook";
import { payoutAdapterAbi } from "../../abis/v2/payoutAdapter";
import { USDG, V2_FLYWHEEL_TOKEN_ADDRESS } from "../../lib/env";
import {
  v2BuybackExecutorPonder,
  v2FeeSplitterPonder,
  v2PayoutRouterPonder,
} from "../../lib/registry";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;
const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

const provenance = (event: {
  block: { timestamp: bigint; number: bigint };
  log: { logIndex: number; address: Address };
  transaction: { hash: Hex };
}) => ({
  id: `${event.transaction.hash}-${event.log.logIndex}`,
  ts: event.block.timestamp,
  block: event.block.number,
  logIndex: event.log.logIndex,
  tx: event.transaction.hash,
});

v2PayoutRouterPonder.on("PayoutRouter:RouteSet", async ({ event, context }) => {
  const asset = lower(event.args.asset);
  // The event deliberately omits tickSpacing and v3Pool. Decode the five-field v8 router tuple;
  // the old adapter shares this selector but returns `(address pool,uint24 fee)`.
  const route = await context.client.readContract({
    abi: payoutAdapterAbi,
    address: event.log.address,
    functionName: "routes",
    args: [asset],
  });
  const values = {
    active: Number(route.venue) !== 0,
    venue: Number(route.venue),
    poolId: lower(event.args.poolId),
    fee: Number(route.fee),
    tickSpacing: Number(route.tickSpacing),
    v3Pool: lower(route.v3Pool),
    feeBps: Number(route.feeBps),
    changedAt: event.block.timestamp,
    changedBlock: event.block.number,
    changedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2PayoutRoute).values({ asset, ...values }).onConflictDoUpdate(values);
});

v2PayoutRouterPonder.on("PayoutRouter:RouteCleared", async ({ event, context }) => {
  const asset = lower(event.args.asset);
  const values = {
    active: false,
    venue: 0,
    poolId: ZERO_BYTES32,
    fee: 0,
    tickSpacing: 0,
    v3Pool: ZERO_ADDRESS,
    feeBps: 0,
    changedAt: event.block.timestamp,
    changedBlock: event.block.number,
    changedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2PayoutRoute).values({ asset, ...values }).onConflictDoUpdate(values);
});

v2FeeSplitterPonder.on("FeeSplitter:Distributed", async ({ event, context }) => {
  const { asset, assetIn, usdgIn, treasuryOut, buybackAdded } = event.args;
  const meta = provenance(event);
  await context.db.insert(schema.v2FlywheelDistribution).values({
    ...meta, asset: lower(asset), assetIn, usdgIn, treasuryOut, buybackAdded,
  });
  // A normal contract read is pinned to the end of this block, so a later transaction in the
  // same block can already have rotated treasury. The USDG Transfer immediately preceding this
  // event is the durable record of who actually received this distribution.
  let treasury: Address;
  if (treasuryOut === 0n) {
    treasury = await context.client.readContract({
      abi: feeSplitterAbi,
      address: event.log.address,
      functionName: "treasury",
    });
  } else {
    const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash });
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs.filter((log) => lower(log.address) === lower(USDG)
        && log.logIndex < event.log.logIndex),
      strict: true,
    }).filter((log) => lower(log.args.from) === lower(event.log.address)
      && log.args.value === treasuryOut)
      .sort((a, b) => b.logIndex - a.logIndex);
    const transfer = transfers[0];
    if (transfer === undefined) {
      throw new Error(`FeeSplitter:Distributed missing preceding USDG Transfer in ${event.transaction.hash}`);
    }
    treasury = transfer.args.to;
  }
  await context.db.insert(schema.v2TreasuryExit).values({
    ...meta,
    source: "feeSplitter",
    sourceAddress: lower(event.log.address),
    eventKind: "distributed",
    assetKind: "erc20",
    asset: lower(USDG),
    tokenId: null,
    recipient: lower(treasury),
    amount: treasuryOut,
  });
});

v2FeeSplitterPonder.on("FeeSplitter:DistributionSkipped", async ({ event, context }) => {
  await context.db.insert(schema.v2FlywheelDistributionSkip).values({
    ...provenance(event), asset: lower(event.args.asset), reason: lower(event.args.reason),
  });
});

v2FeeSplitterPonder.on("FeeSplitter:BoughtBack", async ({ event, context }) => {
  await context.db.insert(schema.v2FlywheelBuyback).values({
    ...provenance(event), usdgIn: event.args.usdgIn, tokenOut: event.args.tokenOut,
  });
});

v2FeeSplitterPonder.on("FeeSplitter:Burned", async ({ event, context }) => {
  if (V2_FLYWHEEL_TOKEN_ADDRESS === undefined) {
    throw new Error("V2_FLYWHEEL_TOKEN_ADDRESS is required for FeeSplitter:Burned");
  }
  const totalSupplyAtBlock = await context.client.readContract({
    abi: stockTokenAbi,
    address: V2_FLYWHEEL_TOKEN_ADDRESS,
    functionName: "totalSupply",
  });
  await context.db.insert(schema.v2FlywheelBurn).values({
    ...provenance(event), token: lower(V2_FLYWHEEL_TOKEN_ADDRESS),
    amount: event.args.amount, totalSupplyAtBlock,
  });
});

v2FeeSplitterPonder.on("FeeSplitter:BuybackSkipped", async ({ event, context }) => {
  await context.db.insert(schema.v2FlywheelBuybackSkip).values({
    ...provenance(event), reason: lower(event.args.reason),
  });
});

/**
 * A fee sweep that could not collect what the book owes (T-510). FeeSplitter._drainOrderBook emits
 * this at three sites with three different meanings, and the payload — (orderBook, amount) — cannot
 * tell them apart on its own. Until now the event was decodable and deliberately unhandled, so a
 * stranded sweep was invisible off chain.
 *
 * THE THREE CASES, and how each is identified:
 *   amount == 0                      OWED_UNREADABLE  the `owed()` staticcall itself reverted, so
 *                                                     the size is UNKNOWN — never "nothing stranded".
 *                                                     Unambiguous: FeeSplitter returns before any
 *                                                     emit when `owed` is genuinely zero.
 *   amount != 0, OwedClaimed present CLAIM_SHORT      claimOwed COMMITTED but underpaid; `amount` is
 *                                                     the shortfall and some value did move.
 *   amount != 0, OwedClaimed absent  CLAIM_REVERTED   claimOwed reverted inside the splitter's
 *                                                     try/catch; `amount` is the full owed and
 *                                                     nothing moved.
 *
 * WHY OwedClaimed SEPARATES THE LAST TWO. OrderBook.claimOwed emits OwedClaimed BEFORE its transfer,
 * so a revert rolls the emit back with everything else: present means committed, absent means
 * reverted. Same receipt-window technique as the Distributed handler above.
 *
 * MATCH ON THE LOG'S EMITTING ADDRESS, NOT ON THE EVENT ARG. OwedClaimed's `account` is msg.sender,
 * which is the FeeSplitter on every one of them; the book is `log.address`. Matching the arg would
 * correlate every OwedClaimed to every book in a multi-book drain and silently report a
 * CLAIM_REVERTED as a CLAIM_SHORT — value reported as partially collected when none was.
 */
v2FeeSplitterPonder.on("FeeSplitter:OrderBookFeesStranded", async ({ event, context }) => {
  const orderBook = lower(event.args.orderBook);
  const amount = event.args.amount;
  let kind: "OWED_UNREADABLE" | "CLAIM_SHORT" | "CLAIM_REVERTED";
  if (amount === 0n) {
    kind = "OWED_UNREADABLE";
  } else {
    const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash });
    // WINDOW, not "anywhere earlier in the transaction". _drainOrderBook has one call site —
    // setOrderBook (FeeSplitter.sol:288), guarded by `previous != orderBook_` — so one repoint
    // drains a given book once. A transaction that repoints repeatedly (A->B->A->B) can drain the
    // same book twice, and then the FIRST drain's OwedClaimed still sits earlier in the receipt: a
    // naive "any earlier claim" test would read the second drain's revert as a CLAIM_SHORT. So the
    // window starts after this book's previous stranded event, if there is one.
    const priorStranded = parseEventLogs({
      abi: feeSplitterAbi,
      eventName: "OrderBookFeesStranded",
      logs: receipt.logs.filter((log) => lower(log.address) === lower(event.log.address)
        && log.logIndex < event.log.logIndex),
      strict: true,
    }).filter((log) => lower(log.args.orderBook) === orderBook)
      .reduce((best, log) => (best === null || log.logIndex > best ? log.logIndex : best), null as number | null);
    const claimed = parseEventLogs({
      abi: orderBookAbi,
      eventName: "OwedClaimed",
      logs: receipt.logs.filter((log) => lower(log.address) === orderBook
        && log.logIndex < event.log.logIndex
        && (priorStranded === null || log.logIndex > priorStranded)),
      strict: true,
    }).filter((log) => lower(log.args.account) === lower(event.log.address));
    kind = claimed.length > 0 ? "CLAIM_SHORT" : "CLAIM_REVERTED";
  }
  await context.db.insert(schema.v2FlywheelStrandedFees).values({
    ...provenance(event), orderBook, kind, amount,
  });
});

v2BuybackExecutorPonder.on("BuybackExecutor:Bought", async ({ event, context }) => {
  const { usdgIn, usdgSpent, wethOut, tokenOut, minWethOut, declaredFeeBps, measuredFeeBps } = event.args;
  await context.db.insert(schema.v2FlywheelExecution).values({
    ...provenance(event), usdgIn, usdgSpent, wethOut, tokenOut, minWethOut, declaredFeeBps, measuredFeeBps,
  });
});

v2BuybackExecutorPonder.on("BuybackExecutor:Burned", async ({ event, context }) => {
  await context.db.insert(schema.v2FlywheelExecutorBurn).values({
    ...provenance(event), amount: event.args.amount,
  });
});
