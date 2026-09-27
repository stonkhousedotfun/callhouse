/**
 * src/v2/clearinghouse.ts handlers through the registered functions, on an in-memory table fake that applies the
 * column defaults Postgres would (ponder.schema.ts). Covers the ERC-1155 wallet/escrow/open-interest reducer, the
 * collateral ledger (mint, close, redeem, deposit, withdraw), account flags, protocol settings, fee sweeps, token URIs,
 * rent accrual checks, market pauses, and SeriesCreated's configured-calendar branch. The calendar-pointer fallback
 * is clearinghouse.calendar.handler.test.ts's subject; minter/default-fee/default-oracle are x8CoreHandlers'.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry, env } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) },
    env: {
      USDG: "0x000000000000000000000000000000000000d001",
      V2_CLEARINGHOUSE: "0x000000000000000000000000000000000000c011" as string | undefined,
      V2_ORDER_BOOK: "0x000000000000000000000000000000000000c012" as string | undefined,
      V2_EXPIRY_CALENDAR: "0x000000000000000000000000000000000000ca1e" as string | undefined,
    },
  };
});

vi.mock("../../lib/registry", () => ({ v2Ponder: registry }));
vi.mock("../../lib/env", () => ({
  get USDG() { return env.USDG; },
  get V2_CLEARINGHOUSE() { return env.V2_CLEARINGHOUSE; },
  get V2_ORDER_BOOK() { return env.V2_ORDER_BOOK; },
  get V2_EXPIRY_CALENDAR() { return env.V2_EXPIRY_CALENDAR; },
}));
vi.mock("ponder:schema", () => ({ default: new Proxy({}, {
  get: (_target, table) => new Proxy({ __name: table }, {
    get: (target, column) => (column === "__name" ? target.__name : `${String(table)}.${String(column)}`),
  }),
}) }));
type Condition = { op: "and"; parts: Condition[] } | { op: "gte" | "lte"; column: string; value: number };
vi.mock("ponder", () => ({
  and: (...parts: Condition[]) => ({ op: "and", parts }),
  gte: (column: string, value: number) => ({ op: "gte", column, value }),
  lte: (column: string, value: number) => ({ op: "lte", column, value }),
}));
const matches = (row: any, c: Condition): boolean => {
  if (c.op === "and") return c.parts.every((part) => matches(row, part));
  const value = row[c.column.slice(c.column.indexOf(".") + 1)];
  return c.op === "gte" ? value >= c.value : value <= c.value;
};

/** Postgres column defaults for the tables these handlers insert partially (ponder.schema.ts). */
const DEFAULTS: Record<string, object> = {
  v2Account: { inKind: false, toLedger: false, thirdPartyRedeem: true, operators: "{}", delegates: "{}", approvals: "{}" },
  v2Series: { mintFeesHeld: 0n, mintFeesAccrued: 0n, status: "open", openInterestUnits: 0n, volumeUnits: 0n, volumeUsdg: 0n },
  v2Market: { seriesCreated: 0, seriesOpen: 0, openInterestUnits: 0n },
  v2ProtocolState: { createPaused: false, defaultExerciseFeeBps: 0, defaultMintFeePpm: 0 },
};

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const keyOf = (row: any) =>
    String(row.id ?? row.longId ?? row.account ?? row.underlying ?? row.minter ?? row.tokenId ?? row.ts ?? row.dayIndex);
  return {
    rows,
    find: async (t: { __name: string }, key: any) => table(t.__name).get(keyOf(key)) ?? null,
    insert: (t: { __name: string }) => ({ values: (input: any) => {
      const row = { ...DEFAULTS[t.__name], ...input };
      const id = keyOf(row);
      const previous = table(t.__name).get(id);
      if (previous === undefined) table(t.__name).set(id, row);
      return {
        then: (resolve: (value: unknown) => void, reject: (e: unknown) => void) =>
          previous === undefined ? resolve(row) : reject(new Error(`duplicate key ${t.__name} ${id}`)),
        onConflictDoUpdate: async (values: any) => {
          table(t.__name).set(id, previous === undefined ? row : { ...previous, ...values });
        },
      };
    } }),
    update: (t: { __name: string }, key: any) => ({ set: async (values: any) => {
      table(t.__name).set(keyOf(key), { ...table(t.__name).get(keyOf(key)), ...values });
    } }),
    sql: { select: () => ({ from: (t: { __name: string }) => ({
      where: async (condition: Condition) => [...table(t.__name).values()].filter((row) => matches(row, condition)),
    }) }) },
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const BOOK = "0x000000000000000000000000000000000000c012";
const STOCK = "0x00000000000000000000000000000000000000Aa";
const USDG = "0x000000000000000000000000000000000000d001";
const ALICE = "0x00000000000000000000000000000000000000A1";
const BOB = "0x00000000000000000000000000000000000000B2";
const ORACLE = "0x0000000000000000000000000000000000000022";
const TX = `0x${"9".repeat(64)}`;
let logIndex = 0;
const event = (args: object, block = 100n) => ({
  args,
  block: { timestamp: 10_000n + block, number: block },
  transaction: { hash: TX },
  log: { logIndex: logIndex++, address: env.V2_CLEARINGHOUSE },
});

type Db = ReturnType<typeof memoryDb>;
function context(db: Db, reads: Record<string, (input: any) => unknown> = {}) {
  return { db, client: { readContract: vi.fn(async (input: any) => {
    const read = reads[input.functionName];
    if (read === undefined) throw new Error(`unexpected read ${input.functionName}`);
    return read(input);
  }) } };
}
const fire = (ctx: ReturnType<typeof context>, name: string, args: object, block?: bigint) =>
  handlers.get(`Clearinghouse:${name}`)!({ event: event(args, block), context: ctx });
const row = (db: Db, table: string, id: string) => db.rows.get(table)?.get(id);

const CONFIG = { enabled: true, mintPaused: false, strikeTick: 1_000_000n, exerciseFeeBps: 25, mintFeePpm: 80, oracle: ORACLE };
/** A market with a call series (longId 2) and a put series (longId 4) on the same underlying. */
async function seeded(reads: Record<string, (input: any) => unknown> = {}) {
  const db = memoryDb();
  const ctx = context(db, {
    symbol: () => " nvda ",
    mintCutoff: (input) => 5_000 + Number(input.args[0]),
    collateralAsset: (input) => ((input.args[0] as bigint) === 4n ? USDG : STOCK),
    ...reads,
  });
  await fire(ctx, "MarketRegistered", { underlying: STOCK, config: CONFIG }, 1n);
  for (const [longId, isPut] of [[2n, false], [4n, true]] as const) {
    await fire(ctx, "SeriesCreated", {
      longId, underlying: STOCK, isPut, strike: 200_000_000n, expiry: 1_775_160_000, oracle: ORACLE,
      exerciseFeeBps: 25, mintFeePpm: 80,
    }, 2n);
  }
  return { db, ctx };
}

beforeAll(async () => {
  await import("./clearinghouse");
});
beforeEach(() => {
  env.V2_CLEARINGHOUSE = "0x000000000000000000000000000000000000c011";
  env.V2_ORDER_BOOK = BOOK;
  env.V2_EXPIRY_CALENDAR = "0x000000000000000000000000000000000000ca1e";
});

describe("markets and series", () => {
  it("registers a market under its lower-cased address with the upper-cased ERC-20 symbol as ticker", async () => {
    const { db, ctx } = await seeded();
    expect(ctx.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "symbol", cache: "immutable" }));
    expect(row(db, "v2Market", STOCK.toLowerCase())).toMatchObject({
      ticker: "NVDA", enabled: true, status: "live", oracle: ORACLE, seriesCreated: 2, seriesOpen: 2, lastBlock: 2n,
    });
  });

  it("pauses and reconfigures only a registered market", async () => {
    const { db, ctx } = await seeded();
    await fire(ctx, "MintPausedSet", { underlying: STOCK, paused: true }, 5n);
    expect(row(db, "v2Market", STOCK.toLowerCase())).toMatchObject({ mintPaused: true, lastBlock: 5n, lastTimestamp: 10_005n });
    await fire(ctx, "MarketConfigSet", { underlying: STOCK, config: { ...CONFIG, enabled: false } }, 6n);
    expect(row(db, "v2Market", STOCK.toLowerCase())).toMatchObject({ status: "paused", mintPaused: false });
    await expect(fire(ctx, "MintPausedSet", { underlying: BOB, paused: true }))
      .rejects.toThrow(`MintPausedSet before MarketRegistered: ${BOB.toLowerCase()}`);
    await expect(fire(ctx, "MarketConfigSet", { underlying: BOB, config: CONFIG })).rejects.toThrow("before MarketRegistered");
    await expect(fire(ctx, "SeriesCreated", { longId: 8n, underlying: BOB, isPut: false, strike: 1n, expiry: 1, oracle: ORACLE,
      exerciseFeeBps: 0, mintFeePpm: 0 })).rejects.toThrow("SeriesCreated before MarketRegistered");
  });

  it("with a configured calendar, classifies weekly from indexed holidays in the expiry's week, never by eth_call", async () => {
    // Thursday 2026-04-02 20:00 UTC is the weekly close only because Good Friday (day 20546) is a holiday.
    const thursday = Date.UTC(2026, 3, 2, 20) / 1000;
    const friday = Date.UTC(2026, 3, 3) / 86_400_000;
    const { db, ctx } = await seeded();
    db.rows.set("v2CalendarHoliday", new Map([
      [String(friday), { dayIndex: friday, isHoliday: true }],
      [String(friday + 30), { dayIndex: friday + 30, isHoliday: true }], // outside the queried week
    ]));
    await fire(ctx, "SeriesCreated", { longId: 6n, underlying: STOCK, isPut: false, strike: 1n, expiry: thursday, oracle: ORACLE,
      exerciseFeeBps: 25, mintFeePpm: 80 }, 7n);
    expect(row(db, "v2Series", "6")).toMatchObject({ tenor: "weekly", expiry: BigInt(thursday), mintCutoff: 5_006n, ticker: "NVDA" });
    db.rows.get("v2CalendarHoliday")!.get(String(friday)).isHoliday = false;
    await fire(ctx, "SeriesCreated", { longId: 8n, underlying: STOCK, isPut: false, strike: 1n, expiry: thursday, oracle: ORACLE,
      exerciseFeeBps: 25, mintFeePpm: 80 }, 8n);
    expect(row(db, "v2Series", "8").tenor).toBe("daily");
    // A whitelisted special expiry is "special" unless it is the weekly.
    db.rows.set("v2SpecialExpiry", new Map([[String(thursday), { ts: BigInt(thursday), allowed: true }]]));
    await fire(ctx, "SeriesCreated", { longId: 10n, underlying: STOCK, isPut: false, strike: 1n, expiry: thursday, oracle: ORACLE,
      exerciseFeeBps: 25, mintFeePpm: 80 }, 9n);
    expect(row(db, "v2Series", "10").tenor).toBe("special");
    const names = ctx.client.readContract.mock.calls.map((call) => call[0].functionName);
    expect(names).not.toContain("calendar");
    expect(names).not.toContain("isWeekly");
    expect(row(db, "v2Market", STOCK.toLowerCase())).toMatchObject({ seriesCreated: 5, seriesOpen: 5 });
  });

  it("refuses to read series terms without a configured clearinghouse", async () => {
    const { ctx } = await seeded();
    env.V2_CLEARINGHOUSE = undefined;
    await expect(fire(ctx, "SeriesCreated", { longId: 12n, underlying: STOCK, isPut: false, strike: 1n, expiry: 1, oracle: ORACLE,
      exerciseFeeBps: 0, mintFeePpm: 0 })).rejects.toThrow("V2_CLEARINGHOUSE is required for v2 handlers");
  });
});

describe("ERC-1155 transfers", () => {
  it("tracks wallet balances, skips the book's escrow, logs only long transfers, and moves open interest on long mint/burn", async () => {
    const { db, ctx } = await seeded();
    await fire(ctx, "TransferBatch", { operator: ALICE, from: ZERO, to: ALICE, ids: [2n, 3n], values: [10n, 10n] }, 20n);
    await fire(ctx, "TransferSingle", { operator: ALICE, from: ALICE, to: BOOK, id: 2n, value: 4n }, 21n);
    await fire(ctx, "TransferSingle", { operator: BOB, from: BOOK, to: BOB, id: 2n, value: 3n }, 22n);
    await fire(ctx, "TransferSingle", { operator: BOB, from: BOB, to: ZERO, id: 2n, value: 1n }, 23n);
    await fire(ctx, "TransferSingle", { operator: ALICE, from: ALICE, to: ALICE, id: 3n, value: 5n }, 24n);

    expect(row(db, "v2Balance", `2-${ALICE.toLowerCase()}`)).toMatchObject({ units: 6n, side: "long", longId: 2n });
    expect(row(db, "v2Balance", `3-${ALICE.toLowerCase()}`)).toMatchObject({ units: 10n, side: "short", longId: 2n });
    expect(row(db, "v2Balance", `2-${BOB.toLowerCase()}`)).toMatchObject({ units: 2n });
    expect(db.rows.get("v2Balance")!.has(`2-${BOOK}`)).toBe(false);
    // Only the long leg of the batch plus the four single long moves; the short self-transfer is not logged.
    const transfers = [...db.rows.get("v2Transfer")!.values()];
    expect(transfers.map((t) => [t.tokenId, t.from, t.to, t.units])).toEqual([
      [2n, ZERO, ALICE.toLowerCase(), 10n],
      [2n, ALICE.toLowerCase(), BOOK, 4n],
      [2n, BOOK, BOB.toLowerCase(), 3n],
      [2n, BOB.toLowerCase(), ZERO, 1n],
    ]);
    expect(transfers[0].id).toMatch(/-0$/);
    expect(row(db, "v2Series", "2").openInterestUnits).toBe(9n);
    expect(row(db, "v2Market", STOCK.toLowerCase()).openInterestUnits).toBe(9n);
    expect(row(db, "v2Account", BOB.toLowerCase())).toMatchObject({ firstSeen: 10_022n, lastSeen: 10_023n });
    expect(row(db, "v2PnlInput", "global")).toMatchObject({ block: 24n });
  });

  it("fails the replay on a balance underflow, a batch length mismatch, or a mint for an unindexed series or market", async () => {
    const { db, ctx } = await seeded();
    await expect(fire(ctx, "TransferSingle", { operator: ALICE, from: ALICE, to: BOB, id: 2n, value: 1n }))
      .rejects.toThrow(`balance 2-${ALICE.toLowerCase()} underflow`);
    await expect(fire(ctx, "TransferBatch", { operator: ALICE, from: ZERO, to: ALICE, ids: [2n], values: [] }))
      .rejects.toThrow("ids/values length mismatch");
    await expect(fire(ctx, "TransferSingle", { operator: ALICE, from: ZERO, to: ALICE, id: 20n, value: 1n }))
      .rejects.toThrow("ERC-1155 mint/burn for unknown series 20");
    db.rows.get("v2Market")!.clear();
    await expect(fire(ctx, "TransferSingle", { operator: ALICE, from: ZERO, to: ALICE, id: 2n, value: 1n }))
      .rejects.toThrow(`series 2 has unregistered market ${STOCK.toLowerCase()}`);
  });

  it("refuses to classify escrow without a configured order book", async () => {
    const { ctx } = await seeded();
    env.V2_ORDER_BOOK = undefined;
    await expect(fire(ctx, "TransferSingle", { operator: ALICE, from: ZERO, to: ALICE, id: 2n, value: 1n }))
      .rejects.toThrow("V2_ORDER_BOOK is required for v2 handlers");
  });
});

describe("collateral ledger", () => {
  it("debits collateral plus rent on mint, credits it back on close, and holds the rent on the series", async () => {
    const { db, ctx } = await seeded();
    await fire(ctx, "Deposited", { account: ALICE, asset: STOCK, amount: 5n * 10n ** 18n, from: BOB }, 30n);
    await fire(ctx, "Minted", { longId: 2n, writer: ALICE, longTo: BOB, units: 3n, collateral: 3n * 10n ** 18n, fee: 10n ** 16n }, 31n);
    const ledger = `${ALICE.toLowerCase()}-${STOCK.toLowerCase()}`;
    expect(row(db, "v2Ledger", ledger).free).toBe(2n * 10n ** 18n - 10n ** 16n);
    expect(row(db, "v2Series", "2").mintFeesHeld).toBe(10n ** 16n);
    expect([...db.rows.get("v2Mint")!.values()][0]).toMatchObject({ writer: ALICE.toLowerCase(), longTo: BOB.toLowerCase(), units: 3n });
    expect([...db.rows.get("v2CashFlow")!.values()][0]).toMatchObject({ kind: "deposit", account: ALICE.toLowerCase(), actor: BOB.toLowerCase() });

    await fire(ctx, "Closed", { longId: 2n, account: ALICE, units: 1n, collateralFreed: 10n ** 18n, feeRefund: 4n * 10n ** 15n }, 32n);
    expect(row(db, "v2Ledger", ledger).free).toBe(3n * 10n ** 18n - 6n * 10n ** 15n);
    expect(row(db, "v2Series", "2").mintFeesHeld).toBe(6n * 10n ** 15n);
    await expect(fire(ctx, "Closed", { longId: 2n, account: ALICE, units: 1n, collateralFreed: 0n, feeRefund: 10n ** 16n }))
      .rejects.toThrow("series 2 held rent underflow");
  });

  it("refuses a mint that overdraws the ledger or names an unknown series", async () => {
    const { ctx } = await seeded();
    await expect(fire(ctx, "Minted", { longId: 4n, writer: ALICE, longTo: ALICE, units: 1n, collateral: 1n, fee: 0n }))
      .rejects.toThrow("underflow");
    await fire(ctx, "Deposited", { account: ALICE, asset: STOCK, amount: 10n, from: ALICE });
    await expect(fire(ctx, "Minted", { longId: 40n, writer: ALICE, longTo: ALICE, units: 1n, collateral: 1n, fee: 0n }))
      .rejects.toThrow("Minted for unknown series 40");
    await expect(fire(ctx, "Closed", { longId: 40n, account: ALICE, units: 1n, collateralFreed: 1n, feeRefund: 0n }))
      .rejects.toThrow("Closed for unknown series 40");
  });

  it("records withdrawals, and redemptions that credit the ledger only when paid to it", async () => {
    const { db, ctx } = await seeded();
    await fire(ctx, "Deposited", { account: ALICE, asset: USDG, amount: 1_000_000n, from: ALICE }, 40n);
    await fire(ctx, "Withdrawn", { account: ALICE, asset: USDG, amount: 400_000n, to: BOB }, 41n);
    await fire(ctx, "Redeemed", { tokenId: 5n, holder: ALICE, to: ALICE, units: 2n, asset: USDG, amount: 250_000n,
      amountInKind: 0n, toLedger: true }, 42n);
    await fire(ctx, "Redeemed", { tokenId: 4n, holder: ALICE, to: BOB, units: 1n, asset: USDG, amount: 999n,
      amountInKind: 0n, toLedger: false }, 43n);
    expect(row(db, "v2Ledger", `${ALICE.toLowerCase()}-${USDG}`).free).toBe(850_000n);
    expect([...db.rows.get("v2CashFlow")!.values()].map((f) => [f.kind, f.amount, f.actor]))
      .toEqual([["deposit", 1_000_000n, ALICE.toLowerCase()], ["withdrawal", 400_000n, BOB.toLowerCase()]]);
    expect([...db.rows.get("v2Redemption")!.values()].map((r) => [r.longId, r.side, r.to, r.toLedger])).toEqual([
      [4n, "short", ALICE.toLowerCase(), true], [4n, "long", BOB.toLowerCase(), false],
    ]);
    await expect(fire(ctx, "Withdrawn", { account: ALICE, asset: USDG, amount: 850_001n, to: ALICE })).rejects.toThrow("underflow");
  });
});

describe("settlement and rent accrual", () => {
  it("settles a series once and never drives the market's open count below zero", async () => {
    const { db, ctx } = await seeded();
    const settle = { settlementPrice: 210_000_000n, longPayoutPerUnit: 10_000_000n, feePerUnit: 25_000n, shortPayoutPerUnit: 1n };
    await fire(ctx, "SeriesSettled", { longId: 2n, ...settle }, 50n);
    expect(row(db, "v2Series", "2")).toMatchObject({ status: "settled", settlementPrice: 210_000_000n, settledBlock: 50n, settledTx: TX });
    row(db, "v2Market", STOCK.toLowerCase()).seriesOpen = 0;
    await fire(ctx, "SeriesSettled", { longId: 4n, ...settle }, 51n);
    expect(row(db, "v2Market", STOCK.toLowerCase()).seriesOpen).toBe(0);
    await expect(fire(ctx, "SeriesSettled", { longId: 40n, ...settle })).rejects.toThrow("SeriesSettled for unknown series 40");
    // A settled series whose market row is gone still settles.
    db.rows.get("v2Market")!.clear();
    await fire(ctx, "SeriesSettled", { longId: 2n, ...settle }, 52n);
    expect(row(db, "v2Series", "2").settledBlock).toBe(52n);
  });

  it("accrues exactly the held rent in the collateral asset after settlement, and refuses anything else", async () => {
    const { db, ctx } = await seeded();
    Object.assign(row(db, "v2Series", "2"), { status: "settled", mintFeesHeld: 500n });
    Object.assign(row(db, "v2Series", "4"), { status: "settled", mintFeesHeld: 70n });
    await expect(fire(ctx, "MintFeesAccrued", { longId: 2n, asset: USDG, amount: 500n }))
      .rejects.toThrow("does not match settled held rent for 2"); // a call's rent is in the stock
    await expect(fire(ctx, "MintFeesAccrued", { longId: 2n, asset: STOCK, amount: 499n })).rejects.toThrow("does not match");
    await fire(ctx, "MintFeesAccrued", { longId: 2n, asset: STOCK, amount: 500n }, 60n);
    await fire(ctx, "MintFeesAccrued", { longId: 4n, asset: USDG, amount: 70n }, 61n);
    expect(row(db, "v2Series", "2")).toMatchObject({ mintFeesHeld: 0n, mintFeesAccrued: 500n });
    expect(row(db, "v2Series", "4")).toMatchObject({ mintFeesHeld: 0n, mintFeesAccrued: 70n });
    expect(db.rows.get("v2MintFeeAccrual")!.size).toBe(2);
    await expect(fire(ctx, "MintFeesAccrued", { longId: 40n, asset: USDG, amount: 1n })).rejects.toThrow("unknown series 40");
    Object.assign(row(db, "v2Series", "4"), { status: "open", mintFeesHeld: 5n });
    await expect(fire(ctx, "MintFeesAccrued", { longId: 4n, asset: USDG, amount: 5n })).rejects.toThrow("does not match");
  });
});

describe("account flags and protocol settings", () => {
  it("keeps operators and approvals as sorted flag maps and stores payout preferences", async () => {
    const { db, ctx } = await seeded();
    await fire(ctx, "OperatorSet", { account: ALICE, operator: BOB, approved: true }, 70n);
    await fire(ctx, "OperatorSet", { account: ALICE, operator: ORACLE, approved: true }, 71n);
    await fire(ctx, "OperatorSet", { account: ALICE, operator: BOB, approved: false }, 72n);
    await fire(ctx, "ApprovalForAll", { account: ALICE, operator: BOOK, approved: true }, 73n);
    await fire(ctx, "PayoutPrefsSet", { account: ALICE, inKind: true, toLedger: true }, 74n);
    await fire(ctx, "ThirdPartyRedeemSet", { account: ALICE, allowed: false }, 75n);
    expect(row(db, "v2Account", ALICE.toLowerCase())).toMatchObject({
      operators: JSON.stringify({ [ORACLE]: true, [BOB.toLowerCase()]: false }),
      approvals: JSON.stringify({ [BOOK]: true }),
      inKind: true, toLedger: true, thirdPartyRedeem: false, firstSeen: 10_070n, lastSeen: 10_075n,
    });
  });

  it("creates the global protocol row on first use and records each setting", async () => {
    const { db, ctx } = await seeded();
    await fire(ctx, "CreatePausedSet", { paused: true }, 80n);
    await fire(ctx, "FeeRecipientSet", { recipient: BOB }, 81n);
    await fire(ctx, "PayoutAdapterSet", { adapter: ALICE, maxSlippageBps: 75 }, 82n);
    expect(row(db, "v2ProtocolState", "global")).toMatchObject({
      createPaused: true, feeRecipient: BOB.toLowerCase(), payoutAdapter: ALICE.toLowerCase(), maxSlippageBps: 75,
      updatedAt: 10_082n,
    });
  });

  it("appends fee sweeps and keeps the latest URI per token", async () => {
    const { db, ctx } = await seeded();
    await fire(ctx, "FeesSwept", { asset: USDG, to: BOB, amount: 12_345n }, 90n);
    expect([...db.rows.get("v2FeeSweep")!.values()]).toEqual([expect.objectContaining({
      asset: USDG, recipient: BOB.toLowerCase(), amount: 12_345n, block: 90n,
    })]);
    await fire(ctx, "URI", { id: 2n, value: "ipfs://a" }, 91n);
    await fire(ctx, "URI", { id: 2n, value: "ipfs://b" }, 92n);
    expect(row(db, "v2TokenUri", "2")).toMatchObject({ tokenId: 2n, uri: "ipfs://b", blockNumber: 92n, updatedAt: 10_092n });
  });
});
