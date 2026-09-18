import schema from "ponder:schema";
import { and, gte, lte } from "ponder";
import type { Address } from "viem";

import { erc20Abi } from "../../abis/erc20";
import { clearinghouseAbi } from "../../abis/v2/clearinghouse";
import { expiryCalendarAbi } from "../../abis/v2/expiryCalendar";
import { USDG, V2_CLEARINGHOUSE, V2_EXPIRY_CALENDAR, V2_ORDER_BOOK } from "../../lib/env";
import type { DB, EventMeta } from "../../lib/indexing";
import { v2Ponder as ponder } from "../../lib/registry";
import { isWeeklyExpiry } from "../../lib/v2/calendar";
import { seriesTenor } from "../../lib/v2/periphery";
import {
  addNonnegative,
  balanceId,
  ledgerId,
  marketStatus,
  openInterestDelta,
  positionId,
  setAddressFlag,
  tickerFromSymbol,
  walletDeltas,
  type TokenTransfer,
} from "../../lib/v2/clearinghouse";

const key = (address: Address): Address => address.toLowerCase() as Address;
const logId = (event: EventMeta): string => `${event.transaction.hash}-${event.log.logIndex}`;

function clearinghouse(): Address {
  if (V2_CLEARINGHOUSE === undefined) throw new Error("V2_CLEARINGHOUSE is required for v2 handlers");
  return V2_CLEARINGHOUSE;
}

function orderBook(): Address {
  if (V2_ORDER_BOOK === undefined) throw new Error("V2_ORDER_BOOK is required for v2 handlers");
  return V2_ORDER_BOOK;
}

async function account(db: DB, address: Address, ts: bigint) {
  const id = key(address);
  const existing = await db.find(schema.v2Account, { account: id });
  if (existing !== null) {
    await db.update(schema.v2Account, { account: id }).set({ lastSeen: ts });
    return { ...existing, lastSeen: ts };
  }
  return await db.insert(schema.v2Account).values({ account: id, firstSeen: ts, lastSeen: ts });
}

async function ledgerDelta(db: DB, address: Address, asset: Address, delta: bigint) {
  const id = ledgerId(address, asset);
  const current = await db.find(schema.v2Ledger, { id });
  const free = addNonnegative(current?.free ?? 0n, delta, `ledger ${id}`);
  if (current === null) {
    await db.insert(schema.v2Ledger).values({ id, account: key(address), asset: key(asset), free });
  } else {
    await db.update(schema.v2Ledger, { id }).set({ free });
  }
}

async function protocol(db: DB, ts: bigint) {
  const current = await db.find(schema.v2ProtocolState, { id: "global" });
  if (current !== null) return current;
  return await db.insert(schema.v2ProtocolState).values({ id: "global", updatedAt: ts });
}

async function transfer(db: DB, input: TokenTransfer, event: EventMeta, batchIndex = 0) {
  const ts = event.block.timestamp;
  const { longId, side } = positionId(input.tokenId);
  if (side === "long") {
    await db.insert(schema.v2Transfer).values({
      id: `${event.transaction.hash}-${event.log.logIndex}-${batchIndex}`,
      tokenId: input.tokenId, longId, from: key(input.from), to: key(input.to), units: input.units,
      ts, block: event.block.number, logIndex: event.log.logIndex, tx: event.transaction.hash,
    });
  }
  for (const { holder, delta } of walletDeltas(input, orderBook())) {
    const id = balanceId(input.tokenId, holder);
    const current = await db.find(schema.v2Balance, { id });
    const units = addNonnegative(current?.units ?? 0n, delta, `balance ${id}`);
    if (current === null) {
      await db.insert(schema.v2Balance).values({
        id, tokenId: input.tokenId, holder: key(holder), longId, side, units,
      });
    } else {
      await db.update(schema.v2Balance, { id }).set({ units });
    }
    await account(db, holder, ts);
  }

  const delta = openInterestDelta(input);
  if (delta === 0n) return;
  const series = await db.find(schema.v2Series, { longId });
  if (series === null) throw new Error(`ERC-1155 mint/burn for unknown series ${longId}`);
  const market = await db.find(schema.v2Market, { underlying: series.underlying });
  if (market === null) throw new Error(`series ${longId} has unregistered market ${series.underlying}`);
  await db.update(schema.v2Series, { longId }).set({
    openInterestUnits: addNonnegative(series.openInterestUnits, delta, `series ${longId} OI`),
  });
  await db.update(schema.v2Market, { underlying: series.underlying }).set({
    openInterestUnits: addNonnegative(market.openInterestUnits, delta, `market ${series.underlying} OI`),
  });
}

/** Registration has no ticker argument. The Stock Token's immutable ERC-20 symbol is canonical. */
ponder.on("Clearinghouse:MarketRegistered", async ({ event, context }) => {
  const { underlying, config } = event.args;
  const ticker = tickerFromSymbol(await context.client.readContract({
    abi: erc20Abi, address: underlying, functionName: "symbol", cache: "immutable",
  }));
  const id = key(underlying);
  await context.db.insert(schema.v2Market).values({
    underlying: id,
    ticker,
    enabled: config.enabled,
    mintPaused: config.mintPaused,
    strikeTick: config.strikeTick,
    exerciseFeeBps: config.exerciseFeeBps,
    mintFeePpm: config.mintFeePpm,
    oracle: key(config.oracle),
    status: marketStatus(config.enabled),
    registeredAt: event.block.timestamp,
    registeredBlock: event.block.number,
    registeredTx: event.transaction.hash,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:MarketConfigSet", async ({ event, context }) => {
  const { underlying, config } = event.args;
  const id = key(underlying);
  const current = await context.db.find(schema.v2Market, { underlying: id });
  if (current === null) throw new Error(`MarketConfigSet before MarketRegistered: ${id}`);
  await context.db.update(schema.v2Market, { underlying: id }).set({
    enabled: config.enabled,
    mintPaused: config.mintPaused,
    strikeTick: config.strikeTick,
    exerciseFeeBps: config.exerciseFeeBps,
    mintFeePpm: config.mintFeePpm,
    oracle: key(config.oracle),
    status: marketStatus(config.enabled),
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:MintPausedSet", async ({ event, context }) => {
  const id = key(event.args.underlying);
  const current = await context.db.find(schema.v2Market, { underlying: id });
  if (current === null) throw new Error(`MintPausedSet before MarketRegistered: ${id}`);
  await context.db.update(schema.v2Market, { underlying: id }).set({
    mintPaused: event.args.paused,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:SeriesCreated", async ({ event, context }) => {
  const { longId, underlying, isPut, strike, expiry, oracle, exerciseFeeBps, mintFeePpm } = event.args;
  const id = key(underlying);
  const market = await context.db.find(schema.v2Market, { underlying: id });
  if (market === null) throw new Error(`SeriesCreated before MarketRegistered: ${id}`);
  // The optional calendar source records HolidaySet in log order. Derive the weekly bit from
  // that policy as of this event rather than eth_call at a historical block: a detached devnet
  // has every log but cannot answer historical state after anvil --load-state. The contract
  // already validated the expiry, so only its weekly classification is needed here.
  let weekly: boolean;
  if (V2_EXPIRY_CALENDAR === undefined) {
    const calendar = await context.client.readContract({ abi: clearinghouseAbi, address: clearinghouse(),
      functionName: "calendar", cache: "immutable" });
    weekly = await context.client.readContract({ abi: expiryCalendarAbi, address: calendar,
      functionName: "isWeekly", args: [expiry] });
  } else {
    const day = Math.floor(Number(expiry) / 86_400);
    const holidays = await context.db.sql.select().from(schema.v2CalendarHoliday).where(and(
      gte(schema.v2CalendarHoliday.dayIndex, day),
      lte(schema.v2CalendarHoliday.dayIndex, day + 6),
    ));
    weekly = isWeeklyExpiry(BigInt(expiry), new Map(holidays.map((row) => [row.dayIndex, row.isHoliday])));
  }
  // The series' cutoff depends only on its immutable terms, so a latest-state immutable read
  // works on RPC endpoints without historical eth_call support.
  const mintCutoff = await context.client.readContract({
    abi: clearinghouseAbi, address: clearinghouse(), functionName: "mintCutoff", args: [longId], cache: "immutable",
  });
  const special = await context.db.find(schema.v2SpecialExpiry, { ts: BigInt(expiry) });
  await context.db.insert(schema.v2Series).values({
    longId, underlying: id, ticker: market.ticker, isPut, strike, expiry: BigInt(expiry),
    tenor: seriesTenor(weekly, special?.allowed ?? false), mintCutoff: BigInt(mintCutoff), oracle: key(oracle),
    exerciseFeeBps, mintFeePpm, createdAt: event.block.timestamp, createdBlock: event.block.number,
    createdTx: event.transaction.hash,
  });
  await context.db.update(schema.v2Market, { underlying: id }).set({
    seriesCreated: market.seriesCreated + 1,
    seriesOpen: market.seriesOpen + 1,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:TransferSingle", async ({ event, context }) => {
  await transfer(context.db, {
    from: event.args.from, to: event.args.to, tokenId: event.args.id, units: event.args.value,
  }, event);
});

ponder.on("Clearinghouse:TransferBatch", async ({ event, context }) => {
  const { from, to, ids, values } = event.args;
  if (ids.length !== values.length) throw new Error("ERC-1155 TransferBatch ids/values length mismatch");
  for (let i = 0; i < ids.length; i++) {
    await transfer(context.db, { from, to, tokenId: ids[i]!, units: values[i]! }, event, i);
  }
});

ponder.on("Clearinghouse:Minted", async ({ event, context }) => {
  const { longId, writer, longTo, units, collateral, fee } = event.args;
  const collateralAsset = await context.client.readContract({
    abi: clearinghouseAbi, address: clearinghouse(), functionName: "collateralAsset",
    args: [longId], cache: "immutable",
  });
  await ledgerDelta(context.db, writer, collateralAsset, -(collateral + fee));
  const series = await context.db.find(schema.v2Series, { longId });
  if (series === null) throw new Error(`Minted for unknown series ${longId}`);
  await context.db.update(schema.v2Series, { longId }).set({ mintFeesHeld: series.mintFeesHeld + fee });
  await context.db.insert(schema.v2Mint).values({
    id: logId(event), longId, writer: key(writer), longTo: key(longTo), units, collateral, fee,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });
  await account(context.db, writer, event.block.timestamp);
  await account(context.db, longTo, event.block.timestamp);
});

ponder.on("Clearinghouse:Closed", async ({ event, context }) => {
  const { longId, account: holder, units, collateralFreed, feeRefund } = event.args;
  const collateralAsset = await context.client.readContract({
    abi: clearinghouseAbi, address: clearinghouse(), functionName: "collateralAsset",
    args: [longId], cache: "immutable",
  });
  await ledgerDelta(context.db, holder, collateralAsset, collateralFreed + feeRefund);
  const series = await context.db.find(schema.v2Series, { longId });
  if (series === null) throw new Error(`Closed for unknown series ${longId}`);
  await context.db.update(schema.v2Series, { longId }).set({
    mintFeesHeld: addNonnegative(series.mintFeesHeld, -feeRefund, `series ${longId} held rent`),
  });
  await context.db.insert(schema.v2Close).values({
    id: logId(event), longId, account: key(holder), units, collateralFreed, feeRefund,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });
  await account(context.db, holder, event.block.timestamp);
});

ponder.on("Clearinghouse:SeriesSettled", async ({ event, context }) => {
  const { longId, settlementPrice, longPayoutPerUnit, feePerUnit, shortPayoutPerUnit } = event.args;
  const series = await context.db.find(schema.v2Series, { longId });
  if (series === null) throw new Error(`SeriesSettled for unknown series ${longId}`);
  await context.db.update(schema.v2Series, { longId }).set({
    status: "settled", settlementPrice, longPayoutPerUnit, feePerUnit, shortPayoutPerUnit,
    settledAt: event.block.timestamp, settledTx: event.transaction.hash,
    settledBlock: event.block.number, settledLogIndex: event.log.logIndex,
  });
  const market = await context.db.find(schema.v2Market, { underlying: series.underlying });
  if (market !== null) {
    await context.db.update(schema.v2Market, { underlying: series.underlying }).set({
      seriesOpen: Math.max(0, market.seriesOpen - 1),
      lastBlock: event.block.number, lastTimestamp: event.block.timestamp,
    });
  }
});

ponder.on("Clearinghouse:Redeemed", async ({ event, context }) => {
  const { tokenId, holder, to, units, asset, amount, amountInKind, toLedger } = event.args;
  const { longId, side } = positionId(tokenId);
  await context.db.insert(schema.v2Redemption).values({
    id: logId(event), tokenId, longId, side, holder: key(holder), to: key(to), units,
    asset: key(asset), amount, amountInKind, toLedger,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });
  if (toLedger) await ledgerDelta(context.db, holder, asset, amount);
  await account(context.db, holder, event.block.timestamp);
});

ponder.on("Clearinghouse:Deposited", async ({ event, context }) => {
  const { account: holder, asset, amount, from } = event.args;
  await ledgerDelta(context.db, holder, asset, amount);
  await account(context.db, holder, event.block.timestamp);
  await context.db.insert(schema.v2CashFlow).values({ id: logId(event), kind: "deposit", account: key(holder), actor: key(from),
    asset: key(asset), amount, ts: event.block.timestamp, block: event.block.number,
    logIndex: event.log.logIndex, tx: event.transaction.hash });
});

ponder.on("Clearinghouse:Withdrawn", async ({ event, context }) => {
  const { account: holder, asset, amount, to } = event.args;
  await ledgerDelta(context.db, holder, asset, -amount);
  await account(context.db, holder, event.block.timestamp);
  await context.db.insert(schema.v2CashFlow).values({ id: logId(event), kind: "withdrawal", account: key(holder), actor: key(to),
    asset: key(asset), amount, ts: event.block.timestamp, block: event.block.number,
    logIndex: event.log.logIndex, tx: event.transaction.hash });
});

ponder.on("Clearinghouse:OperatorSet", async ({ event, context }) => {
  const { account: holder, operator, approved } = event.args;
  const current = await account(context.db, holder, event.block.timestamp);
  await context.db.update(schema.v2Account, { account: key(holder) }).set({
    operators: setAddressFlag(current.operators, operator, approved), lastSeen: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:PayoutPrefsSet", async ({ event, context }) => {
  const { account: holder, inKind, toLedger } = event.args;
  await account(context.db, holder, event.block.timestamp);
  await context.db.update(schema.v2Account, { account: key(holder) }).set({
    inKind, toLedger, lastSeen: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:ThirdPartyRedeemSet", async ({ event, context }) => {
  const { account: holder, allowed } = event.args;
  await account(context.db, holder, event.block.timestamp);
  await context.db.update(schema.v2Account, { account: key(holder) }).set({
    thirdPartyRedeem: allowed, lastSeen: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:ApprovalForAll", async ({ event, context }) => {
  const { account: holder, operator, approved } = event.args;
  const current = await account(context.db, holder, event.block.timestamp);
  await context.db.update(schema.v2Account, { account: key(holder) }).set({
    approvals: setAddressFlag(current.approvals, operator, approved), lastSeen: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:CreatePausedSet", async ({ event, context }) => {
  await protocol(context.db, event.block.timestamp);
  await context.db.update(schema.v2ProtocolState, { id: "global" }).set({
    createPaused: event.args.paused, updatedAt: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:FeeRecipientSet", async ({ event, context }) => {
  await protocol(context.db, event.block.timestamp);
  await context.db.update(schema.v2ProtocolState, { id: "global" }).set({
    feeRecipient: key(event.args.recipient), updatedAt: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:PayoutAdapterSet", async ({ event, context }) => {
  await protocol(context.db, event.block.timestamp);
  await context.db.update(schema.v2ProtocolState, { id: "global" }).set({
    payoutAdapter: key(event.args.adapter), maxSlippageBps: event.args.maxSlippageBps,
    updatedAt: event.block.timestamp,
  });
});

ponder.on("Clearinghouse:FeesSwept", async ({ event, context }) => {
  const { asset, to, amount } = event.args;
  await context.db.insert(schema.v2FeeSweep).values({
    id: logId(event), asset: key(asset), recipient: key(to), amount,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });
});

ponder.on("Clearinghouse:URI", async ({ event, context }) => {
  const { id, value } = event.args;
  await context.db.insert(schema.v2TokenUri).values({
    tokenId: id, uri: value, updatedAt: event.block.timestamp,
    blockNumber: event.block.number, txHash: event.transaction.hash,
  }).onConflictDoUpdate({
    uri: value, updatedAt: event.block.timestamp,
    blockNumber: event.block.number, txHash: event.transaction.hash,
  });
});

ponder.on("Clearinghouse:MintFeesAccrued", async ({ event, context }) => {
  const { longId, asset, amount } = event.args;
  const series = await context.db.find(schema.v2Series, { longId });
  if (series === null) throw new Error(`MintFeesAccrued for unknown series ${longId}`);
  if (series.status !== "settled" || series.mintFeesHeld !== amount ||
      key(asset) !== key(series.isPut ? USDG : series.underlying)) {
    throw new Error(`MintFeesAccrued does not match settled held rent for ${longId}`);
  }
  await context.db.update(schema.v2Series, { longId }).set({
    mintFeesHeld: 0n, mintFeesAccrued: series.mintFeesAccrued + amount,
  });
  await context.db.insert(schema.v2MintFeeAccrual).values({
    id: logId(event), longId, asset: key(asset), amount,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex, tx: event.transaction.hash,
  });
});
