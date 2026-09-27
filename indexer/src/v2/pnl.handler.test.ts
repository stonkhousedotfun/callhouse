/**
 * The V2PnlClock tick (src/v2/pnl.ts) replayed over a consistent three-block tape on PGlite with the real schema, so
 * every SQL predicate the tick uses (block ranges, FIFO lots with units remaining, closed positions per holder) runs
 * for real. The tape: a primary fill (mint + delivery + Taken), an unmatched direct mint, a resale through the book,
 * a close, a wallet-to-wallet gift, then settlement with a USDG long redemption, an in-kind long redemption that
 * closes a winning position, and a writer's short redemption. pnlPremium.handler.test.ts covers the primary premium
 * projection and fill references.
 */
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../ponder.schema";

type Handler = (input: { event: unknown; context: unknown }) => Promise<void>;
const handlers = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.START_BLOCK ??= "1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  process.env.V2_ORDER_BOOK ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_SETTLEMENT_ORACLE ??= "0x000000000000000000000000000000000000c013";
  process.env.V2_AUTO_ROLLER ??= "0x000000000000000000000000000000000000c014";
  process.env.V2_MAKER_REGISTRY ??= "0x000000000000000000000000000000000000c015";
  process.env.V2_START_BLOCK ??= "100";
  return new Map<string, Handler>();
});

vi.mock("../../lib/registry", () => ({
  v2Ponder: { on: (name: string, handler: Handler) => handlers.set(name, handler) },
}));
vi.mock("ponder:schema", async () => {
  const actual = await vi.importActual<typeof schema>("../../ponder.schema");
  return { default: actual, ...actual };
});

type Table = Parameters<typeof getTableConfig>[0];
let pg: PGlite;
let sql: ReturnType<typeof drizzle<typeof schema>>;
let db: any;
let USDG: string;
let BOOK: string;

/** Every v2 table with its real columns and literal defaults (enum columns as text). */
async function createTables(client: PGlite) {
  for (const [name, table] of Object.entries(schema)) {
    if (!name.startsWith("v2") || typeof table !== "object" || table === null) continue;
    let config: ReturnType<typeof getTableConfig>;
    try { config = getTableConfig(table as Table); } catch { continue; }
    if (!config.columns?.length) continue;
    const columns = config.columns.map((c) => {
      const type = c.getSQLType().startsWith("v2_") ? "text" : c.getSQLType();
      const literal = ["string", "number", "bigint", "boolean"].includes(typeof c.default);
      const value = typeof c.default === "string" ? `'${c.default.replaceAll("'", "''")}'` : String(c.default);
      return `"${c.name}" ${type}${c.primary ? " PRIMARY KEY" : ""}${literal ? ` DEFAULT ${value}` : ""}`;
    });
    const composite = config.primaryKeys[0]?.columns.map((c) => `"${c.name}"`);
    if (composite?.length) columns.push(`PRIMARY KEY (${composite.join(", ")})`);
    await client.exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
  }
}

/** Ponder's store API over drizzle: find/insert/update by primary key, plus the raw `sql` query builder. */
function ponderDb() {
  const keyColumns = (table: any) => {
    const config = getTableConfig(table);
    const single = config.columns.filter((c) => c.primary);
    return single.length > 0 ? single : config.primaryKeys[0]!.columns;
  };
  const where = (table: any, key: Record<string, unknown>) =>
    and(...Object.entries(key).map(([k, v]) => eq(table[k], v)));
  return {
    sql,
    find: async (table: any, key: Record<string, unknown>) =>
      (await sql.select().from(table).where(where(table, key)))[0] ?? null,
    insert: (table: any) => ({ values: (row: any) => ({
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        sql.insert(table).values(row).returning().then((rows: any) => rows[0]).then(resolve, reject),
      onConflictDoUpdate: async (set: any) => {
        const target = keyColumns(table).map((c) => table[Object.keys(table).find((k) => table[k] === c) ?? c.name]);
        await sql.insert(table).values(row).onConflictDoUpdate({ target, set });
      },
      onConflictDoNothing: async () => { await sql.insert(table).values(row).onConflictDoNothing(); },
    }) }),
    update: (table: any, key: Record<string, unknown>) => ({ set: async (values: any) =>
      (await sql.update(table).set(values).where(where(table, key)).returning())[0] }),
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const STOCK = "0x0000000000000000000000000000000000000011";
const ORACLE = "0x0000000000000000000000000000000000000012";
const W = "0x0000000000000000000000000000000000000021"; // writer
const B = "0x0000000000000000000000000000000000000031"; // first buyer
const C = "0x0000000000000000000000000000000000000041"; // resale buyer
const D = "0x0000000000000000000000000000000000000051"; // gift recipient
const E = "0x0000000000000000000000000000000000000061"; // direct mint recipient
const T0 = 1_800_000_000n;
const EXPIRY = T0 + 30n * 86_400n;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const at = (block: bigint) => ({ block, ts: T0 + (block - 100n) * 60n });

const transfer = (id: string, block: bigint, t: number, logIndex: number, from: string, to: string, units: bigint, tokenId = 2n) =>
  ({ id, tokenId, longId: 2n, from, to, units, ...at(block), tx: tx(t), logIndex });
const mint = (id: string, block: bigint, t: number, logIndex: number, longTo: string, units: bigint) =>
  ({ id, longId: 2n, writer: W, longTo, units, collateral: units * 10n ** 16n, fee: 0n, ...at(block), tx: tx(t), logIndex });
const fill = (id: string, block: bigint, t: number, logIndex: number, f: {
  maker: string; taker: string; buyer: string; seller: string; units: bigint; price: bigint; premium: bigint;
  sellerFee: bigint; makerRebate: bigint; primary: boolean;
}) => ({ id, orderId: BigInt(logIndex), longId: 2n, recipient: f.taker, takerIsBuyer: true, ...f,
  ...at(block), tx: tx(t), logIndex });
const take = (id: string, block: bigint, t: number, logIndex: number, taker: string, units: bigint, premium: bigint, takerFee: bigint) =>
  ({ id, taker, longId: 2n, buying: true, units, premium, takerFee, ...at(block), tx: tx(t), logIndex });
const redemption = (id: string, block: bigint, t: number, logIndex: number, r: {
  tokenId: bigint; holder: string; units: bigint; asset: string; amount: bigint;
}) => ({ id, longId: 2n, side: (r.tokenId & 1n) === 0n ? "long" : "short", to: r.holder, amountInKind: 0n, toLedger: false,
  ...r, ...at(block), tx: tx(t), logIndex });

const tick = (block: bigint) => handlers.get("V2PnlClock:block")!({
  event: { block: { number: block, timestamp: at(block).ts } },
  context: { db, client: { readContract: async () => [true, 210_000_000n, T0] } },
});
/** What the log handlers' markPnlInput does when they write a row the tick reads (src/v2/pnlInput.ts). */
const markInput = (block: bigint) => sql.insert(schema.v2PnlInput).values({ id: "global", block })
  .onConflictDoUpdate({ target: schema.v2PnlInput.id, set: { block } });
const find = (table: any, key: Record<string, unknown>) => db.find(table, key);
const all = (table: any) => sql.select().from(table);

beforeAll(async () => {
  pg = new PGlite();
  await createTables(pg);
  sql = drizzle({ client: pg, schema });
  db = ponderDb();
  ({ USDG, V2_ORDER_BOOK: BOOK } = await import("../../lib/env") as any);
  BOOK = BOOK.toLowerCase();
  await import("./pnl");
});
afterAll(async () => { await pg?.close(); });

describe("V2PnlClock over a full position lifecycle", () => {
  it("block 100: a primary fill costs the buyer premium plus taker fee; a direct mint is a zero-cost transfer-in lot", async () => {
    await sql.insert(schema.v2Series).values({ longId: 2n, underlying: STOCK, ticker: "TEST", isPut: false,
      strike: 200_000_000n, expiry: EXPIRY, tenor: "weekly", mintCutoff: EXPIRY - 1_800n, oracle: ORACLE,
      exerciseFeeBps: 25, mintFeePpm: 0, createdAt: T0, createdBlock: 1n, createdTx: tx(99) } as any);
    await sql.insert(schema.v2Account).values([C].map((account) => ({ account, firstSeen: T0, lastSeen: T0 })) as any);
    await sql.insert(schema.v2Transfer).values([
      transfer("tr1a", 100n, 1, 1, ZERO, B, 4n), transfer("tr1b", 100n, 2, 5, ZERO, E, 2n),
    ] as any);
    await sql.insert(schema.v2Mint).values([mint("m1", 100n, 1, 2, B, 4n), mint("m2", 100n, 2, 6, E, 2n)] as any);
    await sql.insert(schema.v2Fill).values([fill("f1", 100n, 1, 3, {
      maker: W, taker: B, buyer: B, seller: W, units: 4n, price: 100_000_000n, premium: 4_000_000n,
      sellerFee: 200_000n, makerRebate: 20_000n, primary: true,
    })] as any);
    await sql.insert(schema.v2Take).values([take("k1", 100n, 1, 4, B, 4n, 4_000_000n, 100_000n)] as any);

    await tick(100n);

    const lots = await all(schema.v2Lot);
    expect(lots.map((l) => [l.holder, l.units, l.costUsdg, l.source]).sort()).toEqual([
      [B, 4n, 4_100_000n, "fill"], [E, 2n, 0n, "mint"],
    ].sort());
    expect(await find(schema.v2PositionPnl, { id: `2-${B}` })).toMatchObject({
      unitsBought: 4n, costUsdg: 4_100_000n, spotAtEntry: 210_000_000n, closedAt: null,
    });
    expect(await find(schema.v2PositionPnl, { id: `2-${E}` })).toMatchObject({ transferIn: true, unitsBought: 0n });
    const stats = (await all(schema.v2WriterStats)).find((row) => row.window === "all")!;
    // Premium net of seller fee plus the maker rebate; collateral marked at strike for both mints (6 units).
    expect(stats).toMatchObject({ writer: W, premiumUsdg: 3_820_000n, collateralUsdg: 12_000_000n, assignedUsdg: 0n });
    expect(await find(schema.v2PnlCursor, { id: "global" })).toMatchObject({ block: 100n });
  });

  it("block 101: a resale realises proceeds against FIFO cost; a close and a gift consume lots without proceeds", async () => {
    await sql.insert(schema.v2Transfer).values([
      transfer("tr2a", 101n, 3, 1, B, BOOK, 1n), // listing escrow: not a sale
      transfer("tr2b", 101n, 3, 2, BOOK, C, 1n), // delivery for the resale
      transfer("tr2c", 101n, 4, 5, B, ZERO, 1n), // close burn
      transfer("tr2d", 101n, 5, 7, B, D, 1n), // gift
    ] as any);
    await sql.insert(schema.v2Fill).values([fill("f2", 101n, 3, 3, {
      maker: B, taker: C, buyer: C, seller: B, units: 1n, price: 150_000_000n, premium: 1_500_000n,
      sellerFee: 75_000n, makerRebate: 7_500n, primary: false,
    })] as any);
    await sql.insert(schema.v2Take).values([take("k2", 101n, 3, 4, C, 1n, 1_500_000n, 50_000n)] as any);
    await sql.insert(schema.v2Close).values([{ id: "cl1", longId: 2n, account: B, units: 1n, collateralFreed: 10n ** 16n,
      feeRefund: 0n, ...at(101n), tx: tx(4), logIndex: 6 }] as any);

    await markInput(101n);
    await tick(101n);

    // Resale: 1_500_000 - 75_000 fee + 7_500 rebate (seller is maker) against one lot unit of 1_025_000.
    expect((await find(schema.v2Fill, { id: "f2" })).realisedDeltaUsdg).toBe(407_500n);
    expect((await find(schema.v2Fill, { id: "f2" })).fairAtFill).toBe(100_000_000n); // f1's VWAP per share
    expect((await find(schema.v2Close, { id: "cl1" })).realisedDeltaUsdg).toBe(-1_025_000n);
    expect(await find(schema.v2Lot, { id: `2-${B}-0` })).toMatchObject({ unitsRemaining: 1n, costRemainingUsdg: 1_025_000n });
    expect(await find(schema.v2Lot, { id: `2-${C}-0` })).toMatchObject({ units: 1n, costUsdg: 1_550_000n, source: "fill" });
    expect(await find(schema.v2Lot, { id: `2-${D}-0` })).toMatchObject({ units: 1n, costUsdg: 0n, source: "transfer" });
    expect(await find(schema.v2PositionPnl, { id: `2-${B}` })).toMatchObject({
      unitsSold: 2n, proceedsUsdg: 1_432_500n, unitsTransferredOut: 1n, transferredOut: true,
      realisedUsdg: 1_432_500n - 2n * 1_025_000n, closedAt: null,
    });
    expect(await find(schema.v2PositionPnl, { id: `2-${D}` })).toMatchObject({ transferIn: true });
  });

  it("block 102: redemptions close positions, rank the holder, and charge the writer the assigned value", async () => {
    await sql.update(schema.v2Series).set({ status: "settled", settlementPrice: 250_000_000n }).where(eq(schema.v2Series.longId, 2n));
    await sql.insert(schema.v2Transfer).values([
      transfer("tr3a", 102n, 6, 1, B, ZERO, 1n), transfer("tr3b", 102n, 7, 3, C, ZERO, 1n),
    ] as any);
    await sql.insert(schema.v2Redemption).values([
      redemption("rd1", 102n, 6, 2, { tokenId: 2n, holder: B, units: 1n, asset: USDG, amount: 500_000n }),
      // In kind: 0.008 Stock Token at the 250 USDG settlement is worth 2 USDG.
      redemption("rd2", 102n, 7, 4, { tokenId: 2n, holder: C, units: 1n, asset: STOCK, amount: 8n * 10n ** 15n }),
      redemption("rd3", 102n, 8, 5, { tokenId: 3n, holder: W, units: 4n, asset: USDG, amount: 0n }),
    ] as any);

    await markInput(102n);
    await tick(102n);

    expect((await find(schema.v2Redemption, { id: "rd1" })).realisedDeltaUsdg).toBe(500_000n - 1_025_000n);
    expect((await find(schema.v2Redemption, { id: "rd2" })).realisedDeltaUsdg).toBe(2_000_000n - 1_550_000n);
    expect((await find(schema.v2Redemption, { id: "rd3" })).realisedDeltaUsdg).toBeNull(); // short legs are writer stats

    const b = await find(schema.v2PositionPnl, { id: `2-${B}` });
    expect(b).toMatchObject({ closedAt: at(102n).ts, closedTx: tx(6), unitsRedeemed: 1n, payoutUsdgValue: 500_000n });
    const c = await find(schema.v2PositionPnl, { id: `2-${C}` });
    expect(c).toMatchObject({ closedAt: at(102n).ts, closedTx: tx(7), realisedUsdg: 450_000n, multiplePpm: 1_290_322n,
      belowMinCost: false, offMarket: false });

    const boards = await all(schema.v2Leaderboard);
    const cAll = boards.find((row) => row.holder === C && row.window === "all")!;
    expect(cAll).toMatchObject({ wins: 1, losses: 0, streak: 1, bestMultiplePpm: 1_290_322n, absoluteRealisedUsdg: 450_000n,
      bestWinId: `2-${C}` });
    // B gifted a unit away, so its close is excluded from ranking: neither a win nor a loss.
    expect(boards.find((row) => row.holder === B && row.window === "all")).toMatchObject({ wins: 0, losses: 0 });
    expect(boards.filter((row) => row.holder === C).map((row) => row.window).sort()).toEqual(["all", "month", "week"]);
    expect(await find(schema.v2Account, { account: C })).toMatchObject({
      wins: 1, losses: 0, streak: 1, bestStreak: 1, realisedUsdg: 450_000n,
    });

    const stats = (await all(schema.v2WriterStats)).find((row) => row.window === "all")!;
    // Four short units assigned at the 250 settlement: 4 * 250 / 100 = 10 USDG, none paid back.
    expect(stats).toMatchObject({ assignedUsdg: 10_000_000n, realisedYieldUsdg: 3_820_000n - 10_000_000n });
    // D (gift) and E (direct mint) still hold lots on this series, so the next PnL-relevant time is its expiry.
    expect(await find(schema.v2PnlInput, { id: "global" })).toMatchObject({ nextLotExpiry: EXPIRY });
    expect(await find(schema.v2PnlCursor, { id: "global" })).toMatchObject({ block: 102n });
  });

  it("an idle block before the next lot expiry only advances the cursor, and a stale block does nothing", async () => {
    // Block 102's own mark is at the cursor, so block 103 still runs in full (a write at `from` may follow its tick).
    await sql.insert(schema.v2Transfer).values([transfer("tr4a", 103n, 9, 1, D, E, 1n)] as any);
    await tick(103n);
    expect(await find(schema.v2Lot, { id: `2-${E}-1` })).toMatchObject({ units: 1n, source: "transfer" });
    const before = (await all(schema.v2Lot)).length;
    // Nothing marked since: block 104's rows (written without a mark) are not read, only the cursor moves.
    await sql.insert(schema.v2Transfer).values([transfer("tr5a", 104n, 10, 1, E, D, 1n)] as any);
    await tick(104n);
    expect(await find(schema.v2PnlCursor, { id: "global" })).toMatchObject({ block: 104n });
    expect((await all(schema.v2Lot)).length).toBe(before);
    await tick(104n);
    await tick(50n);
    expect(await find(schema.v2PnlCursor, { id: "global" })).toMatchObject({ block: 104n });
  });

  it("refuses a long or short redemption on a series with no settlement price", async () => {
    await sql.update(schema.v2Series).set({ settlementPrice: null }).where(eq(schema.v2Series.longId, 2n));
    await markInput(105n);
    await sql.insert(schema.v2Redemption).values([
      redemption("rd5", 105n, 11, 1, { tokenId: 3n, holder: W, units: 1n, asset: USDG, amount: 0n }),
    ] as any);
    await expect(tick(105n)).rejects.toThrow("short redemption rd5: unsettled series");
  });
  it("self-trade measurement: a minimum-price primary to a linked wallet counts toward the writer once resold", async () => {
    const F = "0x0000000000000000000000000000000000000071"; // W's operator: linked
    const G = "0x0000000000000000000000000000000000000081"; // unlinked
    await sql.update(schema.v2Series).set({ settlementPrice: 250_000_000n }).where(eq(schema.v2Series.longId, 2n));
    await sql.insert(schema.v2Series).values({ longId: 6n, underlying: STOCK, ticker: "TEST", isPut: false,
      strike: 200_000_000n, expiry: EXPIRY, tenor: "weekly", mintCutoff: EXPIRY - 1_800n, oracle: ORACLE,
      exerciseFeeBps: 25, mintFeePpm: 0, createdAt: T0, createdBlock: 1n, createdTx: tx(99) } as any);
    await sql.insert(schema.v2Account).values({ account: W, firstSeen: T0, lastSeen: T0, operators: JSON.stringify({ [F]: true }) } as any);
    const six = <T extends { longId: bigint; tokenId?: bigint }>(row: T) => ({ ...row, longId: 6n, ...("tokenId" in row ? { tokenId: 6n } : {}) });
    const primary = (id: string, t: number, buyer: string) => [
      six(transfer(`${id}-tr`, 106n, t, 1, ZERO, buyer, 1n)),
      six(mint(`${id}-m`, 106n, t, 2, buyer, 1n)),
      six(fill(id, 106n, t, 3, { maker: W, taker: buyer, buyer, seller: W, units: 1n, price: 100n, premium: 1n,
        sellerFee: 0n, makerRebate: 0n, primary: true })),
      six(take(`${id}-k`, 106n, t, 4, buyer, 1n, 1n, 0n)),
    ] as const;
    for (const [tr, m, f, k] of [primary("f6", 20, F), primary("f7", 21, G)]) {
      await sql.insert(schema.v2Transfer).values(tr as any);
      await sql.insert(schema.v2Mint).values(m as any);
      await sql.insert(schema.v2Fill).values(f as any);
      await sql.insert(schema.v2Take).values(k as any);
    }
    await markInput(106n);
    await tick(106n);
    expect(await all(schema.v2SelfTradeUnseen)).toEqual([expect.objectContaining({ reason: "no-link-evidence", units: 1n, fills: 1 })]);
    expect(await all(schema.v2SelfTradeMaker)).toEqual([]);

    await sql.insert(schema.v2Transfer).values([
      six(transfer("tr8a", 107n, 22, 1, F, BOOK, 1n)), six(transfer("tr8b", 107n, 22, 2, BOOK, G, 1n)),
    ] as any);
    await sql.insert(schema.v2Fill).values(six(fill("f8", 107n, 22, 3, { maker: F, taker: G, buyer: G, seller: F, units: 1n,
      price: 20_000n, premium: 200n, sellerFee: 0n, makerRebate: 0n, primary: false })) as any);
    await sql.insert(schema.v2Take).values(six(take("k8", 107n, 22, 4, G, 1n, 200n, 0n)) as any);
    await markInput(107n);
    await tick(107n);
    expect(await all(schema.v2SelfTradeMaker)).toEqual([expect.objectContaining({ maker: W, units: 1n, updatedBlock: 107n })]);
    // The unseen total is carried, not recounted, on a tick that refuses nothing new.
    expect(await all(schema.v2SelfTradeUnseen)).toEqual([expect.objectContaining({ reason: "no-link-evidence", units: 1n, fills: 1 })]);
    expect((await find(schema.v2Fill, { id: "f8" })).realisedDeltaUsdg).toBe(200n - 1n);
  });
});
