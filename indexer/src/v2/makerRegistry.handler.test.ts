/** MakerRegistry:TierSet through the registered handler (src/v2/makerRegistry.ts): one row per maker per epoch. */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MAKER_BENCHMARK_POLICY } from "../../lib/v2/makerScoring";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (name: string, handler: Handler) => handlers.set(name, handler) } };
});

vi.mock("../../lib/registry", () => ({ v2Ponder: registry }));
vi.mock("ponder:schema", () => ({ default: { v2MakerEpoch: "v2MakerEpoch" } }));

function memoryDb() {
  const rows = new Map<string, any>();
  return {
    rows,
    find: async (_table: string, key: { id: string }) => rows.get(key.id) ?? null,
    insert: (_table: string) => ({ values: async (row: any) => { rows.set(row.id, row); } }),
    update: (_table: string, key: { id: string }) => ({ set: async (values: any) => {
      rows.set(key.id, { ...rows.get(key.id), ...values });
    } }),
  };
}

const MAKER = "0x00000000000000000000000000000000000000Ab";
// Wednesday 2026-03-11 12:00 UTC; its epoch is Monday 2026-03-09 00:00 UTC.
const WEDNESDAY = BigInt(Date.parse("2026-03-11T12:00:00Z") / 1000);
const MONDAY = BigInt(Date.parse("2026-03-09T00:00:00Z") / 1000);
const NEXT_WEEK = WEDNESDAY + 7n * 86_400n;

const tierSet = (db: ReturnType<typeof memoryDb>, rebateBps: number, timestamp: bigint) =>
  handlers.get("MakerRegistry:TierSet")!({
    event: { args: { maker: MAKER, rebateBps }, block: { timestamp, number: 1n } },
    context: { db },
  });

beforeAll(async () => {
  await import("./makerRegistry");
});

describe("MakerRegistry:TierSet", () => {
  it("creates the epoch row keyed and stored by lower-cased maker, under this build's benchmark policy", async () => {
    const db = memoryDb();
    await tierSet(db, 40, WEDNESDAY);
    expect([...db.rows.values()]).toEqual([{
      id: `${MAKER.toLowerCase()}-${MONDAY}`,
      maker: MAKER.toLowerCase(),
      epoch: MONDAY,
      tierBps: 40,
      benchmarkPolicy: MAKER_BENCHMARK_POLICY,
    }]);
  });

  it("replaces the tier within an epoch (an explicit zero included) and opens a new row next epoch", async () => {
    const db = memoryDb();
    await tierSet(db, 40, WEDNESDAY);
    await tierSet(db, 60, WEDNESDAY + 3_600n);
    expect(db.rows.get(`${MAKER.toLowerCase()}-${MONDAY}`)).toMatchObject({ tierBps: 60, benchmarkPolicy: MAKER_BENCHMARK_POLICY });
    await tierSet(db, 0, WEDNESDAY + 7_200n);
    expect(db.rows.get(`${MAKER.toLowerCase()}-${MONDAY}`).tierBps).toBe(0);
    await tierSet(db, 25, NEXT_WEEK);
    expect(db.rows.size).toBe(2);
    expect(db.rows.get(`${MAKER.toLowerCase()}-${MONDAY + 7n * 86_400n}`)).toMatchObject({ tierBps: 25 });
  });
});
