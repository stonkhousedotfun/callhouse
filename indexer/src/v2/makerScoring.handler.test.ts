import { describe, expect, it, vi } from "vitest";

import * as schema from "../../ponder.schema";
import { makerEpochId } from "../../lib/v2/makerRegistry";
import { MAKER_BENCHMARK_POLICY, makerWeekStartUtc } from "../../lib/v2/makerScoring";

const runtime = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.START_BLOCK ??= "1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  process.env.V2_ORDER_BOOK ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_SETTLEMENT_ORACLE ??= "0x000000000000000000000000000000000000c013";
  process.env.V2_AUTO_ROLLER ??= "0x000000000000000000000000000000000000c014";
  process.env.V2_MAKER_REGISTRY ??= "0x000000000000000000000000000000000000c015";
  process.env.V2_START_BLOCK ??= "1";
  return {
    calls: 0,
    quote: null as null | { fair: bigint; asOf: number; spot: bigint },
  };
});

vi.mock("../../lib/registry", () => ({ v2Ponder: { on: vi.fn() } }));
vi.mock("ponder:schema", async () => {
  const actual = await vi.importActual<typeof schema>("../../ponder.schema");
  return { default: actual, ...actual };
});
vi.mock("../../lib/v2/pricing", () => ({ fetchFairQuote: async () => {
  runtime.calls += 1;
  return runtime.quote;
} }));

type Row = Record<string, unknown>;

function memoryDb(seed: [object, Row[]][]) {
  const tables = new Map<object, Row[]>(seed);
  const rows = (table: object) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const matches = (row: Row, key: Row) => Object.entries(key).every(([column, value]) => row[column] === value);
  const query = (table: object) => {
    const chain = {
      where: () => chain,
      limit: () => chain,
      then: <T>(resolve: (value: Row[]) => T, reject?: (reason: unknown) => unknown) =>
        Promise.resolve([...rows(table)]).then(resolve, reject),
    };
    return chain;
  };
  return {
    rows,
    db: {
      sql: { select: () => ({ from: (table: object) => query(table) }) },
      find: async (table: object, key: Row) => rows(table).find((row) => matches(row, key)) ?? null,
      insert: (table: object) => ({ values: (value: Row) => ({
        then: <T>(resolve: (result: Row) => T, reject?: (reason: unknown) => unknown) =>
          Promise.resolve().then(() => {
            rows(table).push({ ...value });
            return value;
          }).then(resolve, reject),
      }) }),
      update: (table: object, key: Row) => ({ set: async (patch: Row) => {
        const current = rows(table).find((row) => matches(row, key));
        if (!current) throw new Error("missing indexed row");
        Object.assign(current, patch);
        return current;
      } }),
    },
  };
}

const now = 1_800_000_000n;
const epoch = makerWeekStartUtc(now);
const underlying = "0x0000000000000000000000000000000000000011" as const;
const maker = "0x0000000000000000000000000000000000000021" as const;
const independentMaker = "0x0000000000000000000000000000000000000031" as const;
const independentTaker = "0x0000000000000000000000000000000000000032" as const;

const series = {
  longId: 2n, ticker: "TEST", underlying, isPut: false, strike: 200_000_000n,
  expiry: now + 86_400n, mintCutoff: now + 80_000n, mintFeePpm: 0,
  status: "open", lastPrice: 10_000n,
};
const market = { underlying, enabled: true, mintPaused: false };
const order = (orderId: bigint, kind: "Bid" | "AskResale", price: bigint) => ({
  orderId, maker, longId: 2n, kind, price, units: 100n, filled: 0n, validUntil: 0n,
  status: "open", placedAt: now - 60n, placedBlock: 90n,
});
const independentFill = {
  id: "chain-reference", orderId: 9n, longId: 2n, maker: independentMaker,
  taker: independentTaker, units: 100n, price: 10_000n, premium: 10_000n,
  makerRebate: 0n, ts: now - 60n, block: 99n,
};

describe("maker-scoring block replay", () => {
  it("uses the same chain-derived benchmark when external pricing changes", async () => {
    const { scoreMakerBlock } = await import("./makerScoring");
    const replay = async (quote: NonNullable<typeof runtime.quote>) => {
      runtime.quote = quote;
      const state = memoryDb([
        [schema.v2Series, [{ ...series }]],
        [schema.v2Order, [order(1n, "Bid", 9_950n), order(2n, "AskResale", 10_050n)]],
        [schema.v2Market, [{ ...market }]],
        [schema.v2OrderBookState, [{ id: "book", tradingPaused: false }]],
        [schema.v2Fill, [{ ...independentFill }]],
      ]);
      await scoreMakerBlock({ event: { block: { number: 100n, timestamp: now } },
        context: { db: state.db } } as never);
      return state.rows(schema.v2MakerEpoch);
    };

    runtime.calls = 0;
    const first = await replay({ fair: 10_000n, asOf: Number(now), spot: 200_000_000n });
    const second = await replay({ fair: 30_000n, asOf: Number(now), spot: 300_000_000n });

    expect(second).toEqual(first);
    expect(runtime.calls).toBe(0);
    expect(first).toEqual([expect.objectContaining({ maker, samples: 1, twoSidedSamples: 1,
      uptimePpm: 1_000_000n, depthWithin100bps: 200n })]);
    // The same tick also records the band statistic, and at this fair the 0.02 USDG floor makes the
    // band wide enough to hold the whole quote, so it is at least the 100 bps figure.
    expect(first[0]?.depthInBand).toBeGreaterThanOrEqual(first[0]?.depthWithin100bps ?? 0n);
  });

  it("records definite downtime when every quote is withdrawn", async () => {
    const { scoreMakerBlock } = await import("./makerScoring");
    const previous = {
      id: makerEpochId(maker, epoch), maker, epoch, tierBps: 0,
      // X8-312: a stored row carries the policy it was scored under, and advanceMakerEpoch
      // refuses to average into a row of another policy. Drop this field and the handler throws.
      benchmarkPolicy: MAKER_BENCHMARK_POLICY,
      samples: 1, absentSamples: 0, validSamples: 1, missingReferenceSamples: 0,
      twoSidedSamples: 1, uptimePpm: 1_000_000n, avgSpreadBps: 100n,
      // Both depth columns, because the stored row has both: the 100 bps statistic and the band one
      // (X3-201). A seed missing depthInBand is a row the schema cannot produce, and leaving it out
      // here would only teach the handler to tolerate a column that is NOT NULL in ponder.schema.ts.
      depthWithin100bps: 200n, depthInBand: 320n, fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n,
      scorePpm: 1_000_000n,
    };
    const state = memoryDb([
      [schema.v2Series, [{ ...series, lastPrice: null }]],
      [schema.v2Order, []],
      [schema.v2Market, [{ ...market }]],
      [schema.v2OrderBookState, [{ id: "book", tradingPaused: false }]],
      [schema.v2MakerEpoch, [previous]],
      [schema.v2Fill, []],
    ]);

    runtime.calls = 0;
    runtime.quote = null;
    await scoreMakerBlock({ event: { block: { number: 100n, timestamp: now } },
      context: { db: state.db } } as never);

    expect(state.rows(schema.v2MakerEpoch)).toEqual([expect.objectContaining({
      benchmarkPolicy: MAKER_BENCHMARK_POLICY,
      samples: 2, absentSamples: 1, validSamples: 1, missingReferenceSamples: 0,
      twoSidedSamples: 1, uptimePpm: 500_000n, depthWithin100bps: 100n, depthInBand: 160n,
    })]);
    expect(runtime.calls).toBe(0);
  });
});
