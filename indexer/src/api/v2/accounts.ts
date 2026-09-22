import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, desc, eq, gt, inArray, or, sql } from "ponder";

import { USDG } from "../../../lib/env";
import { matchTakeFees } from "../../../lib/v2/reconcile";
import { readFree } from "./chain";
import { loadBook, loadQuote } from "./bookData";
import { address, error, limit, money, parseAddress, seriesWire, signedMoney, type SeriesRow } from "./shared";

const UNIT = 10n ** 16n;
type HistoryCursor = { block: bigint; logIndex: number; id: string };

function parseHistoryCursor(raw: string | undefined): HistoryCursor | null {
  if (raw === undefined || raw.length > 512) return null;
  try {
    const parts: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== "string" ||
      !/^\d{1,19}$/.test(parts[0]) || typeof parts[1] !== "number" ||
      !Number.isInteger(parts[1]) || parts[1] < 0 || parts[1] > 2_147_483_647 ||
      typeof parts[2] !== "string" || parts[2].length === 0 || parts[2].length > 256) return null;
    const block = BigInt(parts[0]);
    return block <= 9_223_372_036_854_775_807n ? { block, logIndex: parts[1], id: parts[2] } : null;
  } catch { return null; }
}

function historyCursor(row: HistoryCursor): string {
  return Buffer.from(JSON.stringify([row.block.toString(), row.logIndex, row.id])).toString("base64url");
}

function symbolFor(asset: string, markets: Map<string, string>) {
  return asset.toLowerCase() === USDG.toLowerCase() ? "USDG" : markets.get(asset.toLowerCase()) ?? "Stock Token";
}

export function registerAccountRoutes(app: Hono) {
  app.get("/accounts/:address/positions", async (c) => {
    const holder = parseAddress(c.req.param("address"));
    if (holder === null) return error(c, "bad_address", "Account must be an EVM address.");
    const key = holder.toLowerCase() as typeof holder;
    const [balances, lots, orders, ledger, strategies, account, marketsRows] = await Promise.all([
      db.select().from(schema.v2Balance).where(and(eq(schema.v2Balance.holder, key), gt(schema.v2Balance.units, 0n))),
      db.select().from(schema.v2Lot).where(and(eq(schema.v2Lot.holder, key), gt(schema.v2Lot.unitsRemaining, 0n))),
      // The clock marks lapsed orders expired before the on-chain cancel or prune releases
      // their escrow. Both open and expired orders must remain visible for recovery.
      db.select().from(schema.v2Order).where(and(eq(schema.v2Order.maker, key),
        inArray(schema.v2Order.status, ["open", "expired"]))),
      db.select().from(schema.v2Ledger).where(eq(schema.v2Ledger.account, key)),
      db.select().from(schema.v2Strategy).where(eq(schema.v2Strategy.writer, key)),
      db.select().from(schema.v2Account).where(eq(schema.v2Account.account, key)).limit(1),
      db.select().from(schema.v2Market),
    ]);
    const shortLongIds = [...new Set(balances.filter((row) => row.side === "short").map((row) => row.longId))];
    const relevantLongIds = [...new Set([
      ...balances.map((row) => row.longId),
      ...orders.map((row) => row.longId),
      ...strategies.flatMap((row) => row.currentLongId === null ? [] : [row.currentLongId]),
    ])];
    const [premiums, seriesRows] = await Promise.all([
      shortLongIds.length === 0 ? [] : db.select().from(schema.v2WriterSeriesPremium).where(and(
        eq(schema.v2WriterSeriesPremium.writer, key),
        inArray(schema.v2WriterSeriesPremium.longId, shortLongIds))),
      relevantLongIds.length === 0 ? [] : db.select().from(schema.v2Series)
        .where(inArray(schema.v2Series.longId, relevantLongIds)),
    ]);
    const byId = new Map(seriesRows.map((row) => [row.longId.toString(), row]));
    const marketSymbols = new Map(marketsRows.map((row) => [row.underlying.toLowerCase(), row.ticker]));
    const quoteCache = new Map<string, Awaited<ReturnType<typeof loadQuote>> | null>();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const premiumByLongId = new Map(premiums.map((row) => [row.longId.toString(), row.premiumUsdg]));
    async function quoteFor(series: SeriesRow) {
      const id = series.longId.toString();
      if (quoteCache.has(id)) return quoteCache.get(id)!;
      const loaded = await loadBook(series.longId, now);
      const quote = loaded ? await loadQuote(loaded) : null;
      quoteCache.set(id, quote);
      return quote;
    }
    const prefs = { inKind: account[0]?.inKind ?? false, toLedger: account[0]?.toLedger ?? false };
    const longs = [];
    const shorts = [];
    const listedLongs = new Map<string, bigint>();
    for (const order of orders) if (order.kind === "AskResale") {
      const id = order.longId.toString();
      listedLongs.set(id, (listedLongs.get(id) ?? 0n) + order.units - order.filled);
    }
    const heldLongIds = new Set([
      ...balances.filter((row) => row.side === "long").map((row) => row.longId.toString()),
      ...listedLongs.keys(),
    ]);
    for (const id of heldLongIds) {
      const series = byId.get(id);
      if (!series) continue;
      const walletUnits = balances.find((row) => row.longId === series.longId && row.side === "long")?.units ?? 0n;
      const units = walletUnits + (listedLongs.get(id) ?? 0n);
      if (units > 0n) {
        const ownLots = lots.filter((lot) => lot.longId === series.longId);
        const remainingUnits = ownLots.reduce((sum, lot) => sum + lot.unitsRemaining, 0n);
        const remainingCost = ownLots.reduce((sum, lot) => sum + lot.costRemainingUsdg, 0n);
        const avgCost = remainingUnits === 0n ? 0n : remainingCost * 100n / remainingUnits;
        const quote = await quoteFor(series);
        const mark = series.status === "open" ? quote?.fair ?? quote?.bestBid ?? null : null;
        const markSource = mark === null ? null : quote?.fair !== null && quote?.fair !== undefined ? "fair" as const : "best-bid" as const;
        const unrealised = mark === null ? null : signedMoney(BigInt(mark.raw) * units / 100n -
          (remainingUnits === 0n ? 0n : remainingCost * units / remainingUnits));
        const claimable = series.status === "settled" && prefs.inKind && series.longPayoutPerUnit !== null
          ? money(series.longPayoutPerUnit * walletUnits, series.isPut ? 6 : 18) : null;
        longs.push({ series: seriesWire(series), units: units.toString(), avgCost: money(avgCost),
          mark, markSource, unrealised, claimable });
      }
    }
    for (const balance of balances) {
      if (balance.side !== "short") continue;
      const series = byId.get(balance.longId.toString());
      if (!series) continue;
      {
        const premiumReceived = premiumByLongId.get(balance.longId.toString()) ?? 0n;
        const collateral = series.isPut ? series.strike * balance.units / 100n : UNIT * balance.units;
        const claimable = series.status === "settled" && series.shortPayoutPerUnit !== null
          ? money(series.shortPayoutPerUnit * balance.units, series.isPut ? 6 : 18) : null;
        shorts.push({ series: seriesWire(series), units: balance.units.toString(),
          premiumReceived: money(premiumReceived), collateralLocked: money(collateral, series.isPut ? 6 : 18), claimable });
      }
    }
    // Return reclaimable escrow orders even after their off-chain clock status lapses.
    const openOrders = orders.flatMap((row) => { const series = byId.get(row.longId.toString()); return series ? [{
        orderId: row.orderId.toString(), series: seriesWire(series), kind: row.kind, price: money(row.price),
        units: row.units.toString(), filled: row.filled.toString(), validUntil: Number(row.validUntil),
      }] : []; });
    const freeLive = await readFree(holder, ledger.map((row) => address(row.asset)));
    const ledgerWire = ledger.map((row) => ({ asset: address(row.asset), symbol: symbolFor(row.asset, marketSymbols),
      free: money(freeLive.get(row.asset.toLowerCase()) ?? row.free,
        row.asset.toLowerCase() === USDG.toLowerCase() ? 6 : 18) }));
    const strategiesWire = strategies.map((row) => ({ ticker: row.ticker,
      strategy: { active: row.active, weekly: row.weekly, smartPricing: row.smartPricing,
        otmBps: row.otmBps, askBps: row.askBps, minAskBps: row.minAskBps,
        maxAskBps: row.maxAskBps, maxUnits: row.maxUnits.toString() },
      currentSeries: row.currentLongId === null ? null :
        (byId.has(row.currentLongId.toString()) ? seriesWire(byId.get(row.currentLongId.toString())!) : null),
      orderId: row.orderId?.toString() ?? null,
      lastRolledAt: row.lastRolledAt === null ? null : Number(row.lastRolledAt),
      lastStaleCancelAt: row.lastStaleCancelAt === null ? null : Number(row.lastStaleCancelAt),
      staleSpot: row.staleSpot === null ? null : money(row.staleSpot) }));
    return c.json({ longs, shorts, orders: openOrders, ledger: ledgerWire, strategies: strategiesWire, prefs });
  });

  app.get("/accounts/:address/history", async (c) => {
    const holder = parseAddress(c.req.param("address"));
    if (holder === null) return error(c, "bad_address", "Account must be an EVM address.");
    const key = holder.toLowerCase() as typeof holder;
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor === undefined ? null : parseHistoryCursor(rawCursor);
    if (rawCursor !== undefined && cursor === null) return error(c, "bad_cursor", "Invalid history cursor.");
    const size = limit(c.req.query("limit"));
    const before = (block: unknown, logIndex: unknown, id: unknown) => cursor === null ? undefined :
      sql`(${block}, ${logIndex}, ${id}) < (${cursor.block}, ${cursor.logIndex}, ${cursor.id})`;
    const [fills, mints, closes, redemptions, cashFlows] = await Promise.all([
      db.select().from(schema.v2Fill).where(and(
        or(eq(schema.v2Fill.maker, key), eq(schema.v2Fill.taker, key), eq(schema.v2Fill.buyer, key)),
        before(schema.v2Fill.block, schema.v2Fill.logIndex, schema.v2Fill.id),
      )).orderBy(desc(schema.v2Fill.block), desc(schema.v2Fill.logIndex), desc(schema.v2Fill.id)).limit(size + 1),
      db.select().from(schema.v2Mint).where(and(
        or(eq(schema.v2Mint.writer, key), eq(schema.v2Mint.longTo, key)),
        before(schema.v2Mint.block, schema.v2Mint.logIndex, schema.v2Mint.id),
      )).orderBy(desc(schema.v2Mint.block), desc(schema.v2Mint.logIndex), desc(schema.v2Mint.id)).limit(size + 1),
      db.select().from(schema.v2Close).where(and(eq(schema.v2Close.account, key),
        before(schema.v2Close.block, schema.v2Close.logIndex, schema.v2Close.id)))
        .orderBy(desc(schema.v2Close.block), desc(schema.v2Close.logIndex), desc(schema.v2Close.id)).limit(size + 1),
      db.select().from(schema.v2Redemption).where(and(eq(schema.v2Redemption.holder, key),
        before(schema.v2Redemption.block, schema.v2Redemption.logIndex, schema.v2Redemption.id)))
        .orderBy(desc(schema.v2Redemption.block), desc(schema.v2Redemption.logIndex), desc(schema.v2Redemption.id)).limit(size + 1),
      db.select().from(schema.v2CashFlow).where(and(eq(schema.v2CashFlow.account, key),
        before(schema.v2CashFlow.block, schema.v2CashFlow.logIndex, schema.v2CashFlow.id)))
        .orderBy(desc(schema.v2CashFlow.block), desc(schema.v2CashFlow.logIndex), desc(schema.v2CashFlow.id)).limit(size + 1),
    ]);
    const longIds = [...new Set([...fills, ...mints, ...closes, ...redemptions].map((row) => row.longId))];
    const takerTxs = [...new Set(fills.filter((row) => row.taker.toLowerCase() === key).map((row) => row.tx))];
    const [seriesRows, marketsRows, takerFills, takes] = await Promise.all([
      longIds.length === 0 ? [] : db.select().from(schema.v2Series).where(inArray(schema.v2Series.longId, longIds)),
      db.select().from(schema.v2Market),
      takerTxs.length === 0 ? [] : db.select().from(schema.v2Fill).where(and(
        eq(schema.v2Fill.taker, key), inArray(schema.v2Fill.tx, takerTxs))),
      takerTxs.length === 0 ? [] : db.select().from(schema.v2Take).where(and(
        eq(schema.v2Take.taker, key), inArray(schema.v2Take.tx, takerTxs))),
    ]);
    const byId = new Map(seriesRows.map((row) => [row.longId.toString(), row]));
    const symbols = new Map(marketsRows.map((row) => [row.underlying.toLowerCase(), row.ticker]));
    const takerFees = matchTakeFees(takerFills, takes);
    const rows: { block: bigint; logIndex: number; id: string; item: Record<string, unknown> }[] = [];
    const add = (block: bigint, logIndex: number, id: string, item: Record<string, unknown>) =>
      rows.push({ block, logIndex, id, item });
    for (const row of fills) {
      const isRecipient = row.recipient.toLowerCase() === key && row.takerIsBuyer;
      const isTaker = row.taker.toLowerCase() === key;
      const isMaker = row.maker.toLowerCase() === key;
      if (!isMaker && !isTaker && !isRecipient) continue;
      const series = byId.get(row.longId.toString()); if (!series) continue;
      const takerSide = isTaker || isRecipient;
      const side = (isRecipient || (takerSide ? row.takerIsBuyer : !row.takerIsBuyer)) ? "buy" : "sell";
      const takerFee = isTaker ? takerFees.get(row.id) ?? 0n : 0n;
      add(row.block, row.logIndex, row.id, { id: row.id, kind: "fill", ts: Number(row.ts), longId: row.longId.toString(),
        series: seriesWire(series), data: { orderId: row.orderId.toString(), side, role: takerSide ? "taker" : "maker",
          counterparty: address(takerSide ? row.maker : row.taker), units: row.units.toString(), price: money(row.price),
          premium: money(row.premium), fee: money(isTaker ? takerFee : isMaker ? row.sellerFee : 0n),
          rebate: money(isMaker ? row.makerRebate : 0n), primary: row.primary,
          realisedPnl: row.seller.toLowerCase() === key && row.realisedDeltaUsdg !== null
            ? signedMoney(row.realisedDeltaUsdg) : null, tx: row.tx } });
    }
    for (const row of mints) {
      if (row.writer.toLowerCase() !== key && row.longTo.toLowerCase() !== key) continue;
      const series = byId.get(row.longId.toString()); if (!series) continue;
      add(row.block, row.logIndex, row.id, { id: row.id, kind: "mint", ts: Number(row.ts), longId: row.longId.toString(),
        series: seriesWire(series), data: { units: row.units.toString(), collateral: money(row.collateral, series.isPut ? 6 : 18),
          fee: money(row.fee, series.isPut ? 6 : 18), payer: address(row.writer),
          longTo: address(row.longTo), tx: row.tx } });
    }
    for (const row of closes) {
      if (row.account.toLowerCase() !== key) continue;
      const series = byId.get(row.longId.toString()); if (!series) continue;
      add(row.block, row.logIndex, row.id, { id: row.id, kind: "close", ts: Number(row.ts), longId: row.longId.toString(),
        series: seriesWire(series), data: { units: row.units.toString(), collateralFreed: money(row.collateralFreed, series.isPut ? 6 : 18),
          feeRefund: money(row.feeRefund, series.isPut ? 6 : 18),
          realisedPnl: row.realisedDeltaUsdg === null ? null : signedMoney(row.realisedDeltaUsdg), tx: row.tx } });
    }
    for (const row of redemptions) {
      if (row.holder.toLowerCase() !== key) continue;
      const series = byId.get(row.longId.toString()); if (!series) continue;
      add(row.block, row.logIndex, row.id, { id: row.id, kind: "redemption", ts: Number(row.ts), longId: row.longId.toString(),
        series: seriesWire(series), data: { side: row.side, tokenId: row.tokenId.toString(), units: row.units.toString(),
          asset: address(row.asset), amount: money(row.amount, row.asset.toLowerCase() === USDG.toLowerCase() ? 6 : 18),
          amountInKind: money(row.amountInKind, series.isPut ? 6 : 18), toLedger: row.toLedger,
          realisedPnl: row.realisedDeltaUsdg === null ? null : signedMoney(row.realisedDeltaUsdg), tx: row.tx } });
    }
    for (const row of cashFlows) add(row.block, row.logIndex, row.id, { id: row.id, kind: row.kind, ts: Number(row.ts),
      longId: null, series: null, data: { asset: address(row.asset), symbol: symbolFor(row.asset, symbols),
        amount: money(row.amount, row.asset.toLowerCase() === USDG.toLowerCase() ? 6 : 18),
        [row.kind === "deposit" ? "from" : "to"]: address(row.actor), tx: row.tx } });
    rows.sort((a, b) => a.block < b.block ? 1 : a.block > b.block ? -1 :
      b.logIndex - a.logIndex || b.id.localeCompare(a.id));
    const selected = rows.slice(0, size);
    return c.json({ items: selected.map((row) => row.item),
      nextCursor: rows.length > size ? historyCursor(selected[size - 1]!) : null });
  });
}
