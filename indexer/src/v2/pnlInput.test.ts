import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

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
vi.mock("../../lib/v2/pricing", () => ({ fetchFairQuote: async () => null }));

import { markPnlInput, nextOpenLotExpiry, pnlTickIsNoop } from "./pnlInput";

/*//////////////////////////////////////////////////////////////
       EVERY WRITE TO A TABLE THE CLOCK READS CARRIES A MARK
//////////////////////////////////////////////////////////////*/

/** The tables `V2PnlClock:block` reads (src/v2/pnl.ts). A write to one of them that is not marked is a write the
 * clock may skip past, silently: the PnL rows it feeds would never be computed. */
const CLOCK_INPUTS = ["v2Transfer", "v2Fill", "v2Take", "v2Mint", "v2Close", "v2Redemption", "v2CashFlow",
  "v2Account", "v2Series"];
const WRITE = new RegExp(`\\.(?:insert|update|delete)\\(schema\\.(?:${CLOCK_INPUTS.join("|")})\\b`);
const BOUNDARY = /ponder\.on\(|\bfunction\b/;

/** Writes that change no column the clock reads, each with the reason. Matched on the whole statement text, so an
 * edit that makes one of them write a column the clock reads stops matching and must carry a mark. */
const UNMARKED = [
  // clearinghouse.ts account(): lastSeen only, and a new row whose operators/approvals/delegates are the empty "{}".
  "db.update(schema.v2Account, { account: id }).set({ lastSeen: ts });",
  "db.insert(schema.v2Account).values({ account: id, firstSeen: ts, lastSeen: ts });",
];

/** The clock's own writes happen inside a full tick, after its reads; the next tick's ranges start after them. */
const CLOCK_FILES = new Set(["v2/pnl.ts", "v2/pnlInput.ts"]);

const indent = (line: string) => line.length - line.trimStart().length;

/** Each unmarked write as `file:line`. A write is marked when a `markPnlInput(` call precedes it in the same function
 * and in a block that encloses it: walking back, the mark is reached before a function boundary and before any line
 * less indented than the mark (which would mean the mark sits in a sibling branch). */
export function unmarkedWrites(file: string, source: string): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (!WRITE.test(line) || UNMARKED.some((statement) => line.includes(statement))) return;
    let shallowest = indent(line);
    for (let j = index - 1; j >= 0; j--) {
      const previous = lines[j]!;
      if (previous.trim() === "") continue;
      if (previous.includes("markPnlInput(")) {
        if (indent(previous) <= shallowest) return;
        break;
      }
      if (BOUNDARY.test(previous)) break;
      shallowest = Math.min(shallowest, indent(previous));
    }
    found.push(`${file}:${index + 1}`);
  });
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("markPnlInput beside every write the PnL clock would read", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));

  it("no handler writes a clock input table without marking the block first", () => {
    const unmarked = sources(src)
      .map((path) => relative(src, path))
      .filter((file) => !CLOCK_FILES.has(file))
      .flatMap((file) => unmarkedWrites(file, readFileSync(join(src, file), "utf8")));
    expect(unmarked).toEqual([]);
  });

  it("finds the writes it is guarding: the scan is not vacuous", () => {
    const marked = sources(src).map((path) => readFileSync(path, "utf8"))
      .reduce((sum, text) => sum + text.split("\n").filter((line) => WRITE.test(line)).length, 0);
    // clearinghouse.ts, orderBook.ts, clock.ts, oracle.ts and pnl.ts write these tables in some thirty places.
    expect(marked).toBeGreaterThan(25);
  });

  it("flags an unmarked write, a mark in a sibling branch and a mark in another function", () => {
    const unmarked = [
      "ponder.on(\"X:Y\", async ({ event, context }) => {",
      "  await context.db.insert(schema.v2Fill).values({ id });",
      "});",
    ].join("\n");
    const sibling = [
      "ponder.on(\"X:Y\", async ({ event, context }) => {",
      "  if (current === null) {",
      "    await markPnlInput(context.db, event.block.number);",
      "    await context.db.insert(schema.v2Account).values({ account });",
      "  } else {",
      "    await context.db.update(schema.v2Account, { account }).set({ delegates });",
      "  }",
      "});",
    ].join("\n");
    const otherFunction = [
      "async function a(db: DB) {",
      "  await markPnlInput(db, 1n);",
      "}",
      "async function b(db: DB) {",
      "  await db.update(schema.v2Series, { longId }).set({ status });",
      "}",
    ].join("\n");
    const good = [
      "ponder.on(\"X:Y\", async ({ event, context }) => {",
      "  await markPnlInput(context.db, event.block.number);",
      "  if (current === null) {",
      "    await context.db.insert(schema.v2Account).values({ account });",
      "  } else {",
      "    await context.db.update(schema.v2Account, { account }).set({ delegates });",
      "  }",
      "});",
    ].join("\n");
    expect(unmarkedWrites("u.ts", unmarked)).toEqual(["u.ts:2"]);
    expect(unmarkedWrites("s.ts", sibling)).toEqual(["s.ts:6"]);
    expect(unmarkedWrites("o.ts", otherFunction)).toEqual(["o.ts:5"]);
    expect(unmarkedWrites("g.ts", good)).toEqual([]);
  });
});

/*//////////////////////////////////////////////////////////////
                    THE SKIP DECISION ITSELF
//////////////////////////////////////////////////////////////*/

describe("pnlTickIsNoop", () => {
  it("never skips without a cursor or an input row", () => {
    expect(pnlTickIsNoop(null, 100n, 100n, 5n)).toBe(false);
    expect(pnlTickIsNoop({ block: -1n, nextLotExpiry: null }, null, 99n, 5n)).toBe(false);
  });

  it("skips only when the last mark is strictly before the cursor", () => {
    const input = (block: bigint) => ({ block, nextLotExpiry: null });
    expect(pnlTickIsNoop(input(129n), 130n, 130n, 5n)).toBe(true);
    // A write at the cursor's own block may have come after that tick (another block source at the same block).
    expect(pnlTickIsNoop(input(130n), 130n, 130n, 5n)).toBe(false);
    expect(pnlTickIsNoop(input(145n), 130n, 130n, 5n)).toBe(false);
  });

  it("does not skip once an open lot's series has expired (expire's at >= expiry)", () => {
    const input = { block: 1n, nextLotExpiry: 1_000n };
    expect(pnlTickIsNoop(input, 130n, 130n, 999n)).toBe(true);
    expect(pnlTickIsNoop(input, 130n, 130n, 1_000n)).toBe(false);
    expect(pnlTickIsNoop(input, 130n, 130n, 1_001n)).toBe(false);
  });
});

describe("nextOpenLotExpiry", () => {
  it("is the earliest expiry among lots with units left, ignoring spent lots and unknown series", () => {
    const expiries = [{ longId: 1n, expiry: 500n }, { longId: 2n, expiry: 300n }, { longId: 3n, expiry: 100n }];
    expect(nextOpenLotExpiry([
      { longId: 1n, remaining: 5n }, { longId: 2n, remaining: 1n }, { longId: 3n, remaining: 0n },
      { longId: 9n, remaining: 4n },
    ], expiries)).toBe(300n);
    expect(nextOpenLotExpiry([{ longId: 3n, remaining: 0n }], expiries)).toBeNull();
    expect(nextOpenLotExpiry([], expiries)).toBeNull();
  });
});

/*//////////////////////////////////////////////////////////////
     THE SKIP CHANGES NO VALUE: SKIPPING RUN == ALWAYS-FULL RUN
//////////////////////////////////////////////////////////////*/

type Row = Record<string, unknown>;

/** The tables the clock selects by block range, and the range they are cut to: (window.from, window.through]. */
const RANGED = new Set<object>([schema.v2Transfer, schema.v2Fill, schema.v2Take, schema.v2Mint, schema.v2Close,
  schema.v2Redemption, schema.v2CashFlow]);
const PRIMARY_KEY = new Map<object, string>([[schema.v2Account, "account"], [schema.v2Series, "longId"],
  [schema.v2SelfTradeMaker, "maker"], [schema.v2SelfTradeUnseen, "reason"]]);

/** The Ponder methods the clock calls, over in-memory rows. Ranged tables honour the tick's block window (the only
 * predicate that decides what a tick sees); every other select returns the whole table. `alwaysFull` hides the
 * v2PnlInput row from the clock while a tick runs (the marks still write it), so every tick takes the full path: the
 * reference run. */
function memoryDb(alwaysFull: boolean) {
  const tables = new Map<object, Row[]>();
  const rows = (table: object) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const window = { from: 0n, through: 0n, inTick: false };
  let selects = 0;
  const matches = (row: Row, key: Row) => Object.entries(key).every(([column, value]) => row[column] === value);
  const query = (table: object) => {
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: <T>(resolve: (value: Row[]) => T, reject?: (reason: unknown) => unknown) => {
        const all = rows(table).map((row) => ({ ...row }));
        const seen = RANGED.has(table)
          ? all.filter((row) => (row.block as bigint) > window.from && (row.block as bigint) <= window.through)
          : all;
        return Promise.resolve(seen).then(resolve, reject);
      },
    };
    return chain;
  };
  const db = {
    sql: { select: () => {
      selects += 1;
      return { from: (table: object) => query(table) };
    } },
    find: async (table: object, key: Row) => {
      if (alwaysFull && window.inTick && table === schema.v2PnlInput) return null;
      const row = rows(table).find((candidate) => matches(candidate, key));
      return row === undefined ? null : { ...row };
    },
    insert: (table: object) => ({ values: (value: Row) => {
      const pk = PRIMARY_KEY.get(table) ?? "id";
      const write = (onConflict: "throw" | "nothing" | Row) => {
        const existing = rows(table).find((row) => row[pk] === value[pk]);
        if (existing) {
          if (onConflict === "throw") throw new Error(`duplicate row ${String(value[pk])}`);
          if (onConflict !== "nothing") Object.assign(existing, onConflict);
          return { ...existing };
        }
        const inserted = { ...(table === schema.v2PositionPnl ? { spotAtEntry: null } : {}), ...value };
        rows(table).push(inserted);
        return { ...inserted };
      };
      return {
        then: <T>(resolve: (value: Row) => T, reject?: (reason: unknown) => unknown) =>
          Promise.resolve().then(() => write("throw")).then(resolve, reject),
        onConflictDoUpdate: (patch: Row) => Promise.resolve().then(() => write(patch)),
        onConflictDoNothing: () => Promise.resolve().then(() => write("nothing")),
      };
    } }),
    update: (table: object, key: Row) => ({ set: async (patch: Row) => {
      const current = rows(table).find((row) => matches(row, key));
      if (!current) throw new Error("missing indexed row");
      Object.assign(current, patch);
      return { ...current };
    } }),
  };
  return { db, rows, tables, window, selects: () => selects };
}

/** Every table but the marker, in a comparable form. */
function snapshot(state: ReturnType<typeof memoryDb>): string {
  const out: Record<string, unknown> = {};
  for (const [name, table] of Object.entries(schema)) {
    if (table === schema.v2PnlInput || !state.tables.has(table)) continue;
    const rows = state.tables.get(table)!;
    if (rows.length === 0) continue;
    out[name] = rows.map((row) => JSON.stringify(row, (_, value) => typeof value === "bigint" ? `${value}n` : value))
      .sort();
  }
  return JSON.stringify(out);
}

describe("V2PnlClock skip: every value equals the always-full run, tick by tick", () => {
  it("skips only the quiet ticks and ends every tick with the same rows as a run that never skips", async () => {
    await import("./pnl");
    const handler = handlers.get("V2PnlClock:block");
    expect(handler).toBeDefined();

    const T0 = 1_800_000_000n;
    const ts = (block: bigint) => T0 + (block - 100n) * 10n;
    const writer = "0x0000000000000000000000000000000000000021";
    const holder = "0x0000000000000000000000000000000000000031";
    const operator = "0x0000000000000000000000000000000000000041";
    const funder = "0x0000000000000000000000000000000000000051";
    const receiver = "0x0000000000000000000000000000000000000061";
    const tx = `0x${"c".repeat(64)}`;
    const account = (id: string) => ({ account: id, operators: "{}", approvals: "{}", delegates: "{}",
      firstSeen: T0, lastSeen: T0, wins: 0, losses: 0, streak: 0, bestStreak: 0, realisedUsdg: 0n });

    // What the handlers would write, block by block, each beside its mark as src/v2/*.ts does.
    const chain: [bigint, (state: ReturnType<typeof memoryDb>) => Promise<void>][] = [
      [100n, async (state) => {
        await markPnlInput(state.db as never, 100n);
        state.rows(schema.v2Series).push({ longId: 7n, ticker: "TEST",
          underlying: "0x0000000000000000000000000000000000000011",
          oracle: "0x0000000000000000000000000000000000000012",
          strike: 200_000_000n, expiry: ts(335n), isPut: false, settlementPrice: null });
        state.rows(schema.v2Account).push(account(writer), account(holder));
        // The long delivery the Clearinghouse emits before Minted (lib/v2/reconcile.ts matches the two).
        state.rows(schema.v2Transfer).push({ id: "delivery-1", tokenId: 7n, longId: 7n,
          from: "0x0000000000000000000000000000000000000000", to: holder, units: 5n, ts: ts(100n), block: 100n,
          logIndex: 0, tx });
        state.rows(schema.v2Mint).push({ id: "mint-1", longId: 7n, writer, longTo: holder, units: 5n,
          collateral: 5n * 10n ** 16n, fee: 0n, ts: ts(100n), block: 100n, logIndex: 1, tx });
      }],
      [145n, async (state) => {
        await markPnlInput(state.db as never, 145n);
        Object.assign(state.rows(schema.v2Account).find((row) => row.account === holder)!,
          { operators: JSON.stringify({ [operator]: true }) });
      }],
      [250n, async (state) => {
        await markPnlInput(state.db as never, 250n);
        state.rows(schema.v2CashFlow).push({ id: "cash-1", kind: "deposit", account: holder, actor: funder,
          asset: "0x0000000000000000000000000000000000000071", amount: 1n, ts: ts(250n), block: 250n,
          logIndex: 0, tx });
      }],
      [370n, async (state) => {
        await markPnlInput(state.db as never, 370n);
        state.rows(schema.v2Transfer).push({ id: "transfer-1", tokenId: 7n, longId: 7n, from: holder,
          to: receiver, units: 1n, ts: ts(370n), block: 370n, logIndex: 0, tx });
      }],
    ];

    const skipping = memoryDb(false);
    const full = memoryDb(true);
    const quiet: bigint[] = [];
    for (let block = 100n; block <= 400n; block += 30n) {
      for (const state of [skipping, full]) {
        for (const [at, write] of chain) {
          if (at > block - 30n && at <= block) await write(state);
        }
        const cursor = state.rows(schema.v2PnlCursor)[0]?.block as bigint | undefined;
        state.window.from = cursor ?? 99n;
        state.window.through = block;
      }
      const before = skipping.selects();
      for (const state of [skipping, full]) {
        state.window.inTick = true;
        await handler!({ event: { block: { number: block, timestamp: ts(block) } },
          context: { db: state.db, client: { readContract: async () => [true, 200_000_000n] } } });
        state.window.inTick = false;
      }
      if (skipping.selects() === before) quiet.push(block);
      expect(snapshot(skipping), `rows after the tick at ${block}`).toBe(snapshot(full));
    }

    // 130: the block-100 writes are at the cursor's block, so one more full tick. 160: the operator at 145.
    // 250/280: the cash flow (and the strict < after it). 340: the mint's lot expired at ts(335). 370/400: the transfer.
    expect(quiet).toEqual([190n, 220n, 310n]);
    // The quiet ticks still move the cursor, exactly as the full run does.
    expect(skipping.rows(schema.v2PnlCursor)).toEqual([{ id: "global", block: 400n }]);
    // And the events really landed: links to the operator, the funder and the transfer's receiver (a wallet transfer
    // is linkage evidence too, lib/v2/selfTrade.ts), and the lot expired to 0.
    const links = skipping.rows(schema.v2SelfTradeLink).map((row) => row.id).sort();
    expect(links).toEqual([`${holder}:${operator}`, `${holder}:${funder}`, `${holder}:${receiver}`].sort());
    expect(skipping.rows(schema.v2SelfTradeLot).find((row) => row.id === "mint:mint-1")?.unitsRemaining).toBe(0n);
    expect(full.selects()).toBeGreaterThan(skipping.selects());
  });
});
