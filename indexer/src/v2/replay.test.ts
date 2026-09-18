import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import {
  ZERO_ADDRESS, addNonnegative, balanceId, openInterestDelta, walletDeltas, type TokenTransfer,
} from "../../lib/v2/clearinghouse";
import { orderExpiresAt, seriesStatusAt, type SeriesClockStatus } from "../../lib/v2/clock";
import {
  cancelOrder, fillOrder, orderValidUntil, placeOrder, replacementPredecessor,
  type OrderKind, type OrderView,
} from "../../lib/v2/orderBook";
import { emptySettlement, oracleSeriesStatus, reduceOracle, type SettlementState } from "../../lib/v2/oracle";

const writer = "0x1111111111111111111111111111111111111111" as Address;
const seller = "0x2222222222222222222222222222222222222222" as Address;
const buyer = "0x3333333333333333333333333333333333333333" as Address;
const book = "0x4444444444444444444444444444444444444444" as Address;
const asset = "0x5555555555555555555555555555555555555555" as Address;
const tx = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const finalizedTx = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const longId = 100n;

type ReplayEvent =
  | { type: "MarketRegistered"; ticker: string }
  | { type: "SeriesCreated"; longId: bigint; mintCutoff: bigint; expiry: bigint }
  | { type: "Deposited"; account: Address; amount: bigint }
  | { type: "Minted"; account: Address; collateral: bigint }
  | { type: "TransferSingle"; transfer: TokenTransfer }
  | { type: "OrderPlaced"; orderId: bigint; maker: Address; kind: OrderKind; units: bigint; at: bigint; tx: string; logIndex: number }
  | { type: "OrderFilled"; orderId: bigint; units: bigint }
  | { type: "OrderCancelled"; orderId: bigint; remaining: bigint; pruned: boolean; tx: string; logIndex: number }
  | { type: "Clock"; at: bigint }
  | { type: "SettlementCandidate"; at: bigint; finalizableAt: bigint }
  | { type: "SettlementVetoed"; at: bigint }
  | { type: "SettlementUnvetoed"; at: bigint; finalizableAt: bigint }
  | { type: "SettlementFinalized"; at: bigint; price: bigint; tx: typeof finalizedTx }
  | { type: "SeriesSettled" };

/** Hand-built sequence of the contract lifecycle: mint, resale escrow, replace, expiry,
 * oracle veto/restart/finalize, settlement, then redemption burn. */
const tape: ReplayEvent[] = [
  { type: "MarketRegistered", ticker: "NVDA" },
  { type: "SeriesCreated", longId, mintCutoff: 150n, expiry: 200n },
  { type: "Deposited", account: writer, amount: 100n },
  { type: "Minted", account: writer, collateral: 40n },
  { type: "TransferSingle", transfer: { from: ZERO_ADDRESS, to: seller, tokenId: longId, units: 10n } },
  { type: "TransferSingle", transfer: { from: ZERO_ADDRESS, to: writer, tokenId: longId + 1n, units: 10n } },
  { type: "OrderPlaced", orderId: 1n, maker: seller, kind: "AskResale", units: 6n, at: 30n, tx: "0x01", logIndex: 1 },
  { type: "TransferSingle", transfer: { from: seller, to: book, tokenId: longId, units: 6n } },
  { type: "OrderFilled", orderId: 1n, units: 4n },
  { type: "TransferSingle", transfer: { from: book, to: buyer, tokenId: longId, units: 4n } },
  { type: "OrderCancelled", orderId: 1n, remaining: 2n, pruned: false, tx, logIndex: 10 },
  { type: "TransferSingle", transfer: { from: book, to: seller, tokenId: longId, units: 2n } },
  { type: "OrderPlaced", orderId: 2n, maker: seller, kind: "AskResale", units: 2n, at: 41n, tx, logIndex: 11 },
  { type: "TransferSingle", transfer: { from: seller, to: book, tokenId: longId, units: 2n } },
  { type: "Clock", at: 150n },
  { type: "Clock", at: 200n },
  { type: "OrderCancelled", orderId: 2n, remaining: 2n, pruned: true, tx: "0x02", logIndex: 1 },
  { type: "TransferSingle", transfer: { from: book, to: seller, tokenId: longId, units: 2n } },
  { type: "SettlementCandidate", at: 220n, finalizableAt: 300n },
  { type: "SettlementVetoed", at: 221n },
  { type: "SettlementUnvetoed", at: 250n, finalizableAt: 350n },
  { type: "SettlementFinalized", at: 351n, price: 240_000_000n, tx: finalizedTx },
  { type: "SeriesSettled" },
  { type: "TransferSingle", transfer: { from: buyer, to: ZERO_ADDRESS, tokenId: longId, units: 4n } },
];

type ReplayOrder = OrderView & {
  orderId: bigint; maker: Address; longId: bigint; kind: OrderKind; validUntil: bigint;
  cancelledTx: string | null; cancelledLogIndex: number | null; replacedBy: bigint | null;
};

describe("v2 lifecycle replay across contracts", () => {
  it("lands coherent market, series, order, wallet, ledger and oracle tables", () => {
    const markets = new Map<Address, { ticker: string; openInterestUnits: bigint }>();
    const series = new Map<bigint, { status: SeriesClockStatus; mintCutoff: bigint; expiry: bigint; openInterestUnits: bigint }>();
    const orders = new Map<bigint, ReplayOrder>();
    const balances = new Map<string, bigint>();
    const ledger = new Map<Address, bigint>();
    let settlement: SettlementState = emptySettlement();

    for (const event of tape) {
      switch (event.type) {
        case "MarketRegistered":
          markets.set(asset, { ticker: event.ticker, openInterestUnits: 0n }); break;
        case "SeriesCreated":
          series.set(event.longId, { status: "open", mintCutoff: event.mintCutoff, expiry: event.expiry, openInterestUnits: 0n }); break;
        case "Deposited":
          ledger.set(event.account, addNonnegative(ledger.get(event.account) ?? 0n, event.amount, "ledger")); break;
        case "Minted":
          ledger.set(event.account, addNonnegative(ledger.get(event.account) ?? 0n, -event.collateral, "ledger")); break;
        case "TransferSingle": {
          for (const { holder, delta } of walletDeltas(event.transfer, book)) {
            const id = balanceId(event.transfer.tokenId, holder);
            balances.set(id, addNonnegative(balances.get(id) ?? 0n, delta, id));
          }
          const interest = openInterestDelta(event.transfer);
          const row = series.get(longId)!;
          row.openInterestUnits = addNonnegative(row.openInterestUnits, interest, "series OI");
          const market = markets.get(asset)!;
          market.openInterestUnits = addNonnegative(market.openInterestUnits, interest, "market OI");
          break;
        }
        case "OrderPlaced": {
          const row = series.get(longId)!;
          const previous = replacementPredecessor([...orders.values()], {
            maker: event.maker, longId, tx: event.tx, logIndex: event.logIndex,
          });
          if (previous !== null) orders.get(previous)!.replacedBy = event.orderId;
          orders.set(event.orderId, {
            orderId: event.orderId, maker: event.maker, longId, kind: event.kind,
            validUntil: orderValidUntil(event.kind, 0n, row.mintCutoff, row.expiry),
            cancelledTx: null, cancelledLogIndex: null, replacedBy: null, ...placeOrder(event.units),
          });
          break;
        }
        case "OrderFilled":
          Object.assign(orders.get(event.orderId)!, fillOrder(orders.get(event.orderId)!, event.units)); break;
        case "OrderCancelled": {
          const order = orders.get(event.orderId)!;
          Object.assign(order, cancelOrder(order, event.remaining, event.pruned), {
            cancelledTx: event.tx, cancelledLogIndex: event.logIndex,
          });
          break;
        }
        case "Clock": {
          const row = series.get(longId)!;
          row.status = seriesStatusAt(row.status, row.mintCutoff, row.expiry, event.at);
          for (const order of orders.values()) {
            if (order.status === "open" && orderExpiresAt(order.kind, order.validUntil, row.mintCutoff, row.expiry, event.at)) {
              order.status = "expired";
            }
          }
          break;
        }
        case "SettlementCandidate":
          settlement = reduceOracle(settlement, {
            kind: "SettlementCandidate", price: 240_000_000n, sourceIndex: 0,
            disagreed: false, finalizableAt: event.finalizableAt,
          }, event.at);
          series.get(longId)!.status = oracleSeriesStatus(series.get(longId)!.status, settlement.status);
          break;
        case "SettlementVetoed":
          settlement = reduceOracle(settlement, { kind: "SettlementVetoed" }, event.at);
          series.get(longId)!.status = oracleSeriesStatus(series.get(longId)!.status, settlement.status);
          break;
        case "SettlementUnvetoed":
          settlement = reduceOracle(settlement, { kind: "SettlementUnvetoed", finalizableAt: event.finalizableAt }, event.at);
          series.get(longId)!.status = oracleSeriesStatus(series.get(longId)!.status, settlement.status);
          break;
        case "SettlementFinalized":
          settlement = reduceOracle(settlement, {
            kind: "SettlementFinalized", price: event.price, sourceIndex: 0, corroborated: false, tx: event.tx,
          }, event.at);
          series.get(longId)!.status = oracleSeriesStatus(series.get(longId)!.status, settlement.status);
          break;
        case "SeriesSettled":
          series.get(longId)!.status = "settled"; break;
      }
    }

    expect(markets.get(asset)).toEqual({ ticker: "NVDA", openInterestUnits: 6n });
    expect(series.get(longId)).toEqual({ status: "settled", mintCutoff: 150n, expiry: 200n, openInterestUnits: 6n });
    expect(orders.get(1n)).toMatchObject({ filled: 4n, status: "cancelled", replacedBy: 2n });
    expect(orders.get(2n)).toMatchObject({ filled: 0n, status: "pruned" });
    expect(ledger.get(writer)).toBe(60n);
    expect(balances.get(balanceId(longId, seller))).toBe(6n);
    expect(balances.get(balanceId(longId, buyer))).toBe(0n);
    expect(balances.get(balanceId(longId + 1n, writer))).toBe(10n);
    expect(balances.has(balanceId(longId, book))).toBe(false);
    expect(settlement).toMatchObject({ status: "Finalized", price: 240_000_000n, finalizedAt: 351n, finalizableAt: null });
  });
});
