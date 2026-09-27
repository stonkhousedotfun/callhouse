/**
 * /v2/rewards routes (src/api/v2/rewards.ts registerRewardRoutes) on a Hono app with an in-memory table fake and a
 * stubbed readRewardBalances: program and cursor validation, fail-closed 503 when any configured distributor's live
 * balance is missing, per-distributor decimals, funding/defunding/claimed sums, and paging. routes.test.ts drives the
 * same routes against PGlite with one USDG distributor.
 */
import { Hono } from "hono";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  distributors: [] as { program: string; address: `0x${string}` }[],
  balances: new Map<string, { balance: bigint; decimals: number }>(),
  tables: new Map<unknown, any[]>(),
  balanceReads: [] as string[][],
}));

vi.mock("../../../lib/env", () => ({
  get V2_REWARDS_DISTRIBUTORS() { return state.distributors; },
}));
vi.mock("ponder:schema", async () => {
  const real = await import("../../../ponder.schema");
  return { ...real, default: real };
});
vi.mock("./chain", () => ({
  readRewardBalances: async (distributors: string[]) => {
    state.balanceReads.push(distributors);
    return new Map(distributors.flatMap((d) => {
      const live = state.balances.get(d.toLowerCase());
      return live === undefined ? [] : [[d.toLowerCase(), live] as const];
    }));
  },
}));
/** select().from(table) resolves to that table's seeded rows; limit/offset page them as SQL would. */
vi.mock("ponder:api", () => ({
  db: {
    select: () => ({ from: (table: unknown) => {
      let rows = [...(state.tables.get(table) ?? [])];
      let skip = 0;
      let take = Infinity;
      const query: any = {
        where: () => query,
        orderBy: () => query,
        limit: (n: number) => { take = n; return query; },
        offset: (n: number) => { skip = n; return query; },
        then: (resolve: (value: any[]) => void, reject: (e: unknown) => void) =>
          Promise.resolve(rows.slice(skip, skip + take)).then(resolve, reject),
      };
      return query;
    } }),
  },
}));

const schema = await import("../../../ponder.schema");
const { registerRewardRoutes } = await import("./rewards");

// Checksummed, as lib/env.ts hands them over (parseRewardDistributors) and as the routes publish them.
const MAKER_A = getAddress("0x00000000000000000000000000000000000000a1");
const MAKER_B = getAddress("0x00000000000000000000000000000000000000b2");
const LENDER = getAddress("0x00000000000000000000000000000000000000c3");
const ACCOUNT = "0x0000000000000000000000000000000000000011";
const ROOT = `0x${"a".repeat(64)}`;
const TX = `0x${"1".repeat(64)}`;

function app() {
  const hono = new Hono();
  registerRewardRoutes(hono);
  return hono;
}
async function get(path: string) {
  const response = await app().request(`http://localhost${path}`);
  return { status: response.status, body: await response.json() as any };
}
function reset() {
  state.distributors = [
    { program: "maker", address: MAKER_A },
    { program: "maker", address: MAKER_B },
    { program: "lender", address: LENDER },
  ];
  state.balances = new Map([
    [MAKER_A.toLowerCase(), { balance: 75_000_000n, decimals: 6 }],
    [MAKER_B.toLowerCase(), { balance: 2n * 10n ** 18n, decimals: 18 }],
    [LENDER.toLowerCase(), { balance: 1n, decimals: 6 }],
  ]);
  state.tables = new Map();
  state.balanceReads = [];
}

describe("GET /rewards/epochs", () => {
  it("refuses a missing or unconfigured program, and an out-of-range cursor", async () => {
    reset();
    for (const path of ["/rewards/epochs", "/rewards/epochs?program=taker"]) {
      expect(await get(path)).toEqual({ status: 400, body: { error: { code: "bad_program", message: "Program is missing or unknown." } } });
    }
    expect((await get("/rewards/epochs?program=maker&cursor=10001")).body.error.code).toBe("bad_cursor");
    expect((await get("/rewards/epochs?program=maker&cursor=123456")).body.error.code).toBe("bad_cursor");
    expect(state.balanceReads).toEqual([]);
  });

  it("answers 503 when any of the program's distributors has no live balance, rather than guessing a scale", async () => {
    reset();
    state.balances.delete(MAKER_B.toLowerCase());
    const { status, body } = await get("/rewards/epochs?program=maker");
    expect(status).toBe(503);
    expect(body.error.code).toBe("rewards_unavailable");
    expect(state.balanceReads).toEqual([[MAKER_A, MAKER_B]]); // only the requested program's instances
  });

  it("sums funding, defunding and claims per distributor in that distributor's own decimals, and pages", async () => {
    reset();
    state.tables.set(schema.v2RewardsEpoch, [
      { distributor: MAKER_B.toLowerCase(), epoch: 11n, root: ROOT, total: 3n * 10n ** 18n },
      { distributor: MAKER_A.toLowerCase(), epoch: 11n, root: ROOT, total: 20_000_000n },
      { distributor: MAKER_A.toLowerCase(), epoch: 10n, root: ROOT, total: 5_000_000n },
    ]);
    state.tables.set(schema.v2RewardsClaim, [
      { distributor: MAKER_A.toLowerCase(), epoch: 11n, amount: 1_500_000n },
      { distributor: MAKER_A.toLowerCase(), epoch: 11n, amount: 500_000n },
      { distributor: MAKER_B.toLowerCase(), epoch: 11n, amount: 10n ** 18n },
    ]);
    state.tables.set(schema.v2ContractFunding, [
      { contract: MAKER_A.toLowerCase(), amount: 30_000_000n },
      { contract: MAKER_A.toLowerCase(), amount: 50_000_000n },
    ]);
    state.tables.set(schema.v2TreasuryExit, [{ sourceAddress: MAKER_A.toLowerCase(), amount: 5_000_000n }]);

    const first = await get("/rewards/epochs?program=maker&limit=2");
    expect(first.status).toBe(200);
    expect(first.body.program).toBe("maker");
    expect(first.body.distributors).toEqual([
      { distributor: MAKER_A,
        funded: { raw: "80000000", decimals: 6, formatted: "80" },
        defunded: { raw: "5000000", decimals: 6, formatted: "5" },
        balance: { raw: "75000000", decimals: 6, formatted: "75" } },
      { distributor: MAKER_B,
        funded: { raw: "0", decimals: 18, formatted: "0" },
        defunded: { raw: "0", decimals: 18, formatted: "0" },
        balance: { raw: "2000000000000000000", decimals: 18, formatted: "2" } },
    ]);
    expect(first.body.items).toEqual([
      { distributor: MAKER_B, epochId: 11, root: ROOT,
        total: { raw: "3000000000000000000", decimals: 18, formatted: "3" },
        claimed: { raw: "1000000000000000000", decimals: 18, formatted: "1" } },
      { distributor: MAKER_A, epochId: 11, root: ROOT,
        total: { raw: "20000000", decimals: 6, formatted: "20" },
        claimed: { raw: "2000000", decimals: 6, formatted: "2" } },
    ]);
    expect(first.body.nextCursor).toBe("2");

    const second = await get("/rewards/epochs?program=maker&limit=2&cursor=2");
    expect(second.body.items.map((item: any) => [item.distributor, item.epochId, item.claimed.raw]))
      .toEqual([[MAKER_A, 10, "0"]]);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe("GET /rewards/:address/claims", () => {
  it("refuses a malformed address and a bad cursor", async () => {
    reset();
    expect((await get("/rewards/0x1234/claims")).body.error.code).toBe("bad_address");
    expect((await get(`/rewards/${ACCOUNT}/claims?cursor=999999`)).body.error.code).toBe("bad_cursor");
  });

  it("answers an empty page without touching the chain when no distributor is configured", async () => {
    reset();
    state.distributors = [];
    const { status, body } = await get(`/rewards/${ACCOUNT}/claims`);
    expect(status).toBe(200);
    expect(body).toEqual({ address: ACCOUNT, items: [], nextCursor: null });
    expect(state.balanceReads).toEqual([]);
  });

  it("answers 503 when any configured distributor's live balance is missing", async () => {
    reset();
    state.balances.delete(LENDER.toLowerCase());
    const { status, body } = await get(`/rewards/${ACCOUNT}/claims`);
    expect(status).toBe(503);
    expect(body.error.code).toBe("rewards_unavailable");
  });

  it("lists the account's indexed claims across programs with each distributor's decimals, paged", async () => {
    reset();
    state.tables.set(schema.v2RewardsClaim, [
      { distributor: MAKER_A.toLowerCase(), epoch: 9n, leafIndex: 0n, account: ACCOUNT, amount: 1_250_000n, tx: TX },
      { distributor: MAKER_B.toLowerCase(), epoch: 9n, leafIndex: 3n, account: ACCOUNT, amount: 5n * 10n ** 17n, tx: TX },
      { distributor: LENDER.toLowerCase(), epoch: 12n, leafIndex: 1n, account: ACCOUNT, amount: 7n, tx: TX },
      // Someone else's claim is not listed.
      { distributor: MAKER_A.toLowerCase(), epoch: 9n, leafIndex: 1n, account: MAKER_B, amount: 99n, tx: TX },
    ]);
    const first = await get(`/rewards/${ACCOUNT}/claims?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toEqual([
      { program: "lender", distributor: LENDER, epochId: 12, index: 1, claimed: true, tx: TX,
        amount: { raw: "7", decimals: 6, formatted: "0.000007" } },
      { program: "maker", distributor: MAKER_A, epochId: 9, index: 0, claimed: true, tx: TX,
        amount: { raw: "1250000", decimals: 6, formatted: "1.25" } },
    ]);
    expect(first.body.nextCursor).toBe("2");
    const second = await get(`/rewards/${ACCOUNT}/claims?limit=2&cursor=2`);
    expect(second.body.items).toEqual([
      { program: "maker", distributor: MAKER_B, epochId: 9, index: 3, claimed: true, tx: TX,
        amount: { raw: "500000000000000000", decimals: 18, formatted: "0.5" } },
    ]);
    expect(second.body.nextCursor).toBeNull();
  });
});
