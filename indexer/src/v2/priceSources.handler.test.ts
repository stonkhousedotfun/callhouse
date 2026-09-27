import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The price sources' admin events land in v2ContractSetting / v2ContractSettingChange /
 * v2ContractAuthority, keyed by underlying (and expiry for pins), and a multi-key event writes one
 * change row per key without colliding on the shared log.
 *
 * This file ALSO carries the behavioral tests for two v9 handlers outside the price sources -- FeeSplitter
 * UnroutedAssetRecovered (src/v2/flywheel.ts) and the House EpochRolled paid fee (src/v2/houseVault.ts) -- because
 * their home files (flywheel.handler.test.ts, houseVault.handler.test.ts) were left untouched
 * then. They belong in those files; moving them is a small cleanup.
 */
type Handler = (input: { event: any; context: any }) => Promise<void>;
const handlers = vi.hoisted(() => {
  // houseVault.ts reads the indexer env at import (lib/env, lib/v2/houseVaultSource), as in houseVault.handler.test.ts.
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  for (const name of ["V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY"]) {
    process.env[name] ??= "0x000000000000000000000000000000000000c012";
  }
  process.env.V2_START_BLOCK ??= "1";
  process.env.V2_HOUSE_VAULT_FACTORY ??= "0x000000000000000000000000000000000000f001";
  process.env.V2_HOUSE_START_BLOCK ??= "100";
  return new Map<string, Handler>();
});

vi.mock("../../lib/registry", () => {
  const recorder = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
  return Object.fromEntries([
    "v2Ponder", "v2CalendarPonder", "v2EarnVaultPonder", "v2FeeSplitterPonder", "v2HouseVaultPonder",
    "v2HouseVaultEventsPonder", "v2HouseVaultKindedFactoryPonder",
    "v2MakerVaultPonder", "v2PayoutRouterPonder", "v2RewardsDistributorPonder", "v2RewardsPonder",
    "v2ChainlinkSourcePonder", "v2UniV3SourcePonder", "v2DataStreamsSourcePonder", "v2BuybackExecutorPonder",
  ].map((name) => [name, recorder]));
});

vi.mock("ponder:schema", () => ({
  default: {
    v2ContractSetting: "v2ContractSetting",
    v2ContractSettingChange: "v2ContractSettingChange",
    v2ContractAuthority: "v2ContractAuthority",
    // The tables the flywheel and House EpochRolled handlers below touch.
    v2TreasuryExit: "v2TreasuryExit",
    v2HouseVault: "v2HouseVault", v2HouseEpoch: "v2HouseEpoch", v2HouseNav: "v2HouseNav",
    v2HouseQueueSettlement: "v2HouseQueueSettlement", v2HousePerformanceFee: "v2HousePerformanceFee",
  },
}));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  // `id` keys every table here except v2HouseVault, which is keyed by `vault`.
  const keyOf = (row: any) => String(row.id ?? row.vault);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(keyOf(key)) ?? null,
    update: (name: string, key: any) => ({ set: async (values: any) => {
      const current = table(name).get(keyOf(key));
      if (current !== undefined) table(name).set(keyOf(key), { ...current, ...values });
    } }),
    insert: (name: string) => ({ values: (row: any) => {
      const existing = table(name).get(keyOf(row));
      if (existing === undefined) table(name).set(keyOf(row), row);
      return {
        then: (resolve: (value: any) => void, reject: (error: Error) => void) => existing === undefined
          ? resolve(row)
          : reject(new Error(`duplicate primary key ${name}:${row.id}`)),
        onConflictDoUpdate: async (values: any) => {
          table(name).set(keyOf(row), existing === undefined ? row : { ...existing, ...values });
        },
      };
    } }),
  };
}

const source = "0x00000000000000000000000000000000000000f1";
const nvda = "0x00000000000000000000000000000000000000a1";
const oracle = "0x0e4F266b73e95dc6d4cA10674DCd5eF353e2BDCD";
const tx = `0x${"b".repeat(64)}`;
const event = (args: object, logIndex = 3) => ({
  args,
  block: { timestamp: 1_790_000_000n, number: 69_600_000n },
  transaction: { hash: tx },
  log: { logIndex, address: source },
});

async function run(name: string, args: object, db = memoryDb()) {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`no handler ${name}`);
  await handler({ event: event(args), context: { db } });
  return db;
}

const settingsOf = (db: ReturnType<typeof memoryDb>) => db.rows.get("v2ContractSetting") ?? new Map();
const changesOf = (db: ReturnType<typeof memoryDb>) => db.rows.get("v2ContractSettingChange") ?? new Map();

beforeAll(async () => {
  await import("./adminConfig");
  await import("./flywheel");
  await import("./houseVault");
});

describe("price-source admin handlers", () => {
  it("registers every handled price-source event and none of the deferred data events", () => {
    const handled = [
      "ChainlinkFeedSource:AuthorityUpdated", "ChainlinkFeedSource:OracleSet",
      "ChainlinkFeedSource:FeedSet", "ChainlinkFeedSource:FeedPinned",
      "ChainlinkFeedSource:BandSet", "ChainlinkFeedSource:BandPinned",
      "UniV3TwapSource:AuthorityUpdated", "UniV3TwapSource:OracleSet",
      "UniV3TwapSource:PoolSet", "UniV3TwapSource:PoolPinned",
      "DataStreamsSource:AuthorityUpdated", "DataStreamsSource:OracleSet", "DataStreamsSource:FeedSet",
      "DataStreamsSource:FeedPinned", "DataStreamsSource:MultiplierRegimeChanged",
      "HouseVault:OracleSet",
    ];
    for (const name of handled) expect(handlers.has(name), name).toBe(true);
    for (const name of [
      "UniV3TwapSource:Recorded", "DataStreamsSource:Recorded",
      "DataStreamsSource:ObservationStored", "DataStreamsSource:ReportSkipped",
    ]) expect(handlers.has(name), name).toBe(false);
  });

  it("FeedSet writes three keyed settings and three distinct change rows from one log", async () => {
    const db = await run("ChainlinkFeedSource:FeedSet", {
      underlying: nvda, feed: "0x00000000000000000000000000000000000000fe", maxStale: 93_600, maxRoundJumpBps: 2_000,
    });
    const current = settingsOf(db);
    expect(current.get(`ChainlinkFeedSource:feed:${nvda}`)).toMatchObject({
      source: "ChainlinkFeedSource", valueKind: "address", valueAddress: "0x00000000000000000000000000000000000000fe",
    });
    expect(current.get(`ChainlinkFeedSource:maxStale:${nvda}`)).toMatchObject({ valueKind: "uint", valueUint: 93_600n });
    expect(current.get(`ChainlinkFeedSource:maxRoundJumpBps:${nvda}`)).toMatchObject({ valueUint: 2_000n });
    expect([...changesOf(db).keys()].sort()).toEqual([
      `${tx}-3:feed:${nvda}`, `${tx}-3:maxRoundJumpBps:${nvda}`, `${tx}-3:maxStale:${nvda}`,
    ]);
  });

  it("BandSet writes the live band's two bounds under band:<underlying>, one change row each", async () => {
    const db = await run("ChainlinkFeedSource:BandSet", { underlying: nvda, minPrice: 150_000_000n, maxPrice: 250_000_000n });
    const current = settingsOf(db);
    expect(current.get(`ChainlinkFeedSource:band:${nvda}:minPrice`)).toMatchObject({
      source: "ChainlinkFeedSource", valueKind: "uint", valueUint: 150_000_000n,
    });
    expect(current.get(`ChainlinkFeedSource:band:${nvda}:maxPrice`)).toMatchObject({ valueKind: "uint", valueUint: 250_000_000n });
    expect([...changesOf(db).keys()].sort()).toEqual([`${tx}-3:band:${nvda}:maxPrice`, `${tx}-3:band:${nvda}:minPrice`]);
  });

  it("BandPinned is keyed by underlying and expiry, apart from the live band", async () => {
    const db = memoryDb();
    await handlers.get("ChainlinkFeedSource:BandSet")!({
      event: event({ underlying: nvda, minPrice: 1n, maxPrice: 2n }, 4), context: { db },
    });
    await handlers.get("ChainlinkFeedSource:BandPinned")!({
      event: event({ underlying: nvda, expiry: 1_790_985_600, minPrice: 150_000_000n, maxPrice: 250_000_000n }, 5), context: { db },
    });
    const current = settingsOf(db);
    expect(current.get(`ChainlinkFeedSource:bandPinned:${nvda}:1790985600:minPrice`)).toMatchObject({ valueUint: 150_000_000n });
    expect(current.get(`ChainlinkFeedSource:bandPinned:${nvda}:1790985600:maxPrice`)).toMatchObject({ valueUint: 250_000_000n });
    // The pin does not overwrite the live band.
    expect(current.get(`ChainlinkFeedSource:band:${nvda}:minPrice`)).toMatchObject({ valueUint: 1n });
    expect(current.get(`ChainlinkFeedSource:band:${nvda}:maxPrice`)).toMatchObject({ valueUint: 2n });
  });

  it("the memory db refuses a duplicate change id (positive control for the collision the suffix avoids)", async () => {
    const db = memoryDb();
    await db.insert("v2ContractSettingChange").values({ id: `${tx}-3` });
    await expect(db.insert("v2ContractSettingChange").values({ id: `${tx}-3` })).rejects.toThrow(/duplicate primary key/);
  });

  it("single-key settings keep the existing change id shape", async () => {
    const db = await run("UniV3TwapSource:OracleSet", { oracle, allowed: true });
    expect(settingsOf(db).get(`UniV3TwapSource:oracle:${oracle}`)).toMatchObject({ valueKind: "bool", valueBool: true });
    expect([...changesOf(db).keys()]).toEqual([`${tx}-3`]);
  });

  it("pins are keyed by underlying and expiry", async () => {
    const db = await run("UniV3TwapSource:PoolPinned", {
      underlying: nvda, expiry: 1_790_985_600, pool: "0x00000000000000000000000000000000000000cc", minLiquidity: 5n,
    });
    expect(settingsOf(db).get(`UniV3TwapSource:pin:${nvda}:1790985600:pool`))
      .toMatchObject({ valueAddress: "0x00000000000000000000000000000000000000cc" });
    expect(settingsOf(db).get(`UniV3TwapSource:pin:${nvda}:1790985600:minLiquidity`)).toMatchObject({ valueUint: 5n });
  });

  it("PoolSet, Data Streams feed ids and the multiplier regime land in typed columns", async () => {
    const db = memoryDb();
    await run("UniV3TwapSource:PoolSet", {
      underlying: nvda, pool: "0x00000000000000000000000000000000000000cc", usdgIsToken0: false, minLiquidity: 7n, window: 1_800,
    }, db);
    const feedId = `0x${"0a".repeat(32)}`;
    await handlers.get("DataStreamsSource:FeedSet")!({ event: event({ underlying: nvda, feedId }, 4), context: { db } });
    await handlers.get("DataStreamsSource:FeedPinned")!({
      event: event({ underlying: nvda, expiry: 1_790_985_600, feedId, version: 3n }, 5), context: { db },
    });
    await handlers.get("DataStreamsSource:MultiplierRegimeChanged")!({
      event: event({ underlying: nvda, multiplier: 10n ** 18n, epoch: 2 }, 6), context: { db },
    });
    const current = settingsOf(db);
    expect(current.get(`UniV3TwapSource:usdgIsToken0:${nvda}`)).toMatchObject({ valueKind: "bool", valueBool: false });
    expect(current.get(`UniV3TwapSource:window:${nvda}`)).toMatchObject({ valueUint: 1_800n });
    expect(current.get(`DataStreamsSource:feedId:${nvda}`)).toMatchObject({ valueKind: "text", valueText: feedId });
    expect(current.get(`DataStreamsSource:pin:${nvda}:1790985600:version`)).toMatchObject({ valueUint: 3n });
    expect(current.get(`DataStreamsSource:multiplier:${nvda}`)).toMatchObject({ valueUint: 10n ** 18n });
    expect(current.get(`DataStreamsSource:multiplierEpoch:${nvda}`)).toMatchObject({ valueUint: 2n });
  });

  it("HouseVault:OracleSet is keyed by the clone that emitted it", async () => {
    const db = await run("HouseVault:OracleSet", { previous: oracle, oracle: "0x00000000000000000000000000000000000000dd" });
    expect(settingsOf(db).get(`HouseVault:oracle:${source}`)).toMatchObject({
      valueKind: "address", valueAddress: "0x00000000000000000000000000000000000000dd",
    });
  });

  it("AuthorityUpdated records the source's authority under its own name", async () => {
    const db = await run("DataStreamsSource:AuthorityUpdated", { authority: "0xb663C1EAEeD4664515Cc864667263f3e75238da3" });
    expect(db.rows.get("v2ContractAuthority")?.get("datastreamssource")).toMatchObject({
      source: "DataStreamsSource", contract: source, authority: "0xb663C1EAEeD4664515Cc864667263f3e75238da3",
    });
  });
});

describe("flywheel: UnroutedAssetRecovered", () => {
  it("writes one v2TreasuryExit row with the asset, the treasury from the event and the amount", async () => {
    const stock = "0x00000000000000000000000000000000000000AB";
    const treasury = "0x00000000000000000000000000000000000000Cd";
    // No `client` in the context: the handler must take the recipient from the event, never a read or a receipt.
    const db = await run("FeeSplitter:UnroutedAssetRecovered", { asset: stock, treasury, amount: 4_200_000_000_000_000_000n });
    const exits = [...(db.rows.get("v2TreasuryExit")?.values() ?? [])];
    expect(exits).toEqual([{
      id: `${tx}-3`, ts: 1_790_000_000n, block: 69_600_000n, logIndex: 3, tx,
      source: "feeSplitter", sourceAddress: source, eventKind: "unroutedAssetRecovered", assetKind: "erc20",
      asset: stock.toLowerCase(), tokenId: null, recipient: treasury.toLowerCase(), amount: 4_200_000_000_000_000_000n,
    }]);
  });
});

describe("houseVault: EpochRolled fee paid", () => {
  const BLOCK = 69_600_000n;
  const rolled = (performanceFee: bigint) => ({
    epochId: 7n, epochEnd: 1_790_000_000, price: 200_000_000n, nav: 10_000_000_000n, supply: 10n ** 22n,
    sharesMinted: 0n, sharesBurned: 0n, performanceFee,
  });
  /** A client whose performanceFeeOwed answers per block: `owed(block)` returns the value or throws. */
  const client = (owed: (block: bigint) => bigint) => {
    const calls: { functionName: string; blockNumber?: bigint }[] = [];
    return {
      calls,
      readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
        calls.push({ functionName, blockNumber });
        if (functionName === "epochEnd") return 1_790_086_400n;
        if (functionName === "performanceFeeOwed") return owed(blockNumber ?? BLOCK);
        throw new Error(`unexpected read ${functionName}`);
      },
    };
  };
  const roll = async (performanceFee: bigint, reader: ReturnType<typeof client>) => {
    const db = memoryDb();
    await handlers.get("HouseVault:EpochRolled")!({ event: event(rolled(performanceFee)), context: { db, client: reader } });
    return [...(db.rows.get("v2HousePerformanceFee")?.values() ?? [])];
  };

  it("v9: paid = charged + owedBefore - owedAfter, read at the block before the roll and at the roll's block", async () => {
    // Charged 100, 30 carried in, 50 still owed after: 80 reached the splitter at this boundary.
    const reader = client((block) => (block === BLOCK - 1n ? 30n : 50n));
    const fees = await roll(100n, reader);
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ amount: 100n, owedBefore: 30n, owedAfter: 50n, paid: 80n, epochId: 7n });
    expect(reader.calls.filter((call) => call.functionName === "performanceFeeOwed").map((call) => call.blockNumber).sort())
      .toEqual([BLOCK - 1n, BLOCK]);
  });

  it("v9: a boundary that pays off the carried fee and charges none reports the carried amount as paid", async () => {
    const fees = await roll(0n, client((block) => (block === BLOCK - 1n ? 25n : 0n)));
    expect(fees[0]).toMatchObject({ amount: 0n, owedBefore: 25n, owedAfter: 0n, paid: 25n });
  });

  it("v8 (no performanceFeeOwed view): owed and paid are null, never 0, and the charged amount is kept", async () => {
    const fees = await roll(100n, client(() => { throw new Error("execution reverted"); }));
    expect(fees[0]).toMatchObject({ amount: 100n, owedBefore: null, owedAfter: null, paid: null });
  });

  it("one failed read leaves paid null (unknown) and keeps the read that succeeded", async () => {
    const fees = await roll(100n, client((block) => {
      if (block === BLOCK) throw new Error("RPC 503");
      return 30n;
    }));
    expect(fees[0]).toMatchObject({ amount: 100n, owedBefore: 30n, owedAfter: null, paid: null });
  });
});
