import { describe, expect, it, vi } from "vitest";

import * as schema from "../../ponder.schema";
import { V2_MAKER_VAULT } from "../../lib/env";
import type { FillableOrder } from "../../lib/v2/book";
import { makerEpochId } from "../../lib/v2/makerRegistry";
import {
  advanceMakerEpoch, emptyMakerEpoch, enrolledMakerKeys, DEPTH_BAND_BPS, MAKER_BENCHMARK_POLICY,
  MAKER_SCORING_POLICY, makerWeekIndex, makerWeekStartFromIndex, makerWeekStartUtc, sampleMakerSeries,
  scoreMakerEpochs, withinBand, type MakerQuality, type MakerSample, type ScoringBand,
} from "../../lib/v2/makerScoring";

// The handler cases below import src/v2/makerScoring.ts, which reads the deployment env at import and
// registers on the ponder runtime. Same seams as makerScoring.handler.test.ts; the lib cases above are unaffected.
// Every ponder source registers into `handlers`, so a case can replay the House vault factory's real
// VaultCreated handler (src/v2/houseVault.ts), the way houseVault.handler.test.ts does.
type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.START_BLOCK ??= "1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  process.env.V2_ORDER_BOOK ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_SETTLEMENT_ORACLE ??= "0x000000000000000000000000000000000000c013";
  process.env.V2_AUTO_ROLLER ??= "0x000000000000000000000000000000000000c014";
  process.env.V2_MAKER_REGISTRY ??= "0x000000000000000000000000000000000000c015";
  process.env.V2_MAKER_VAULT ??= "0x000000000000000000000000000000000000c016";
  process.env.V2_START_BLOCK ??= "1";
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (event: string, handler: Handler) => handlers.set(event, handler) } };
});
vi.mock("../../lib/registry", () => ({
  v2Ponder: registry,
  v2HouseVaultPonder: registry,
  v2HouseVaultEventsPonder: registry,
  v2HouseVaultKindedFactoryPonder: registry,
}));
vi.mock("ponder:schema", async () => {
  const actual = await vi.importActual<typeof schema>("../../ponder.schema");
  return { default: actual, ...actual };
});

const A = "0x0000000000000000000000000000000000000001" as const;
const B = "0x0000000000000000000000000000000000000002" as const;

function order(kind: FillableOrder["kind"], price: bigint, units = 100n): FillableOrder {
  return { orderId: 1n, maker: A, kind, price, units, validUntil: 1000n, placedAt: 0n, placedBlock: 1n };
}

const valid = (quality: MakerQuality): MakerSample => ({ kind: "valid", quality });
const ABSENT: MakerSample = { kind: "absent" };
const MISSING_REFERENCE: MakerSample = { kind: "missingReference" };

describe("maker epoch calendar", () => {
  it("uses Monday UTC and the RewardsDistributor index across New York DST", () => {
    const seconds = (date: string) => BigInt(Date.parse(date) / 1000);
    const september = seconds("2026-09-16T12:00:00Z");
    const monday = seconds("2026-09-14T00:00:00Z");
    expect(makerWeekStartUtc(september)).toBe(monday);
    expect(makerWeekIndex(monday)).toBe(2958n);
    expect(makerWeekStartFromIndex(2958n)).toBe(monday);
    expect(makerWeekStartUtc(seconds("2026-03-08T23:59:59Z"))).toBe(seconds("2026-03-02T00:00:00Z"));
    expect(makerWeekStartUtc(seconds("2026-03-09T00:00:00Z"))).toBe(seconds("2026-03-09T00:00:00Z"));
    expect(makerWeekStartUtc(seconds("2026-11-02T00:00:00Z"))).toBe(seconds("2026-11-02T00:00:00Z"));
  });
});

describe("maker observations and score", () => {
  // A 2 USDG fair, where 1000 bps (0.2 USDG) is far above the 0.02 USDG floor: the band is proportional.
  const FAIR = 2_000_000n;

  it("takes the two-sided test and depthInBand from the epoch band, and depthWithin100bps from 100 bps", () => {
    // 1990000 and 2010000 are 50 bps out: inside both bands. 1850000 is 750 bps out: inside the epoch
    // band only, and BELOW the best bid so the book does not cross. 2300000 is 1500 bps out: outside both.
    const quality = sampleMakerSeries([
      order("Bid", 1_990_000n, 10n), order("AskResale", 2_010_000n, 20n),
      order("Bid", 1_850_000n, 30n), order("AskResale", 2_300_000n, 40n),
    ], FAIR);
    expect(quality).toEqual({ twoSided: true, spreadBps: 100n, depthWithin100bps: 30n, depthInBand: 60n });

    // The 100 bps figure does not move when the band widens; that is the whole point of keeping both.
    const wider: ScoringBand = { bps: 5_000n, minUsdg: 0n };
    const widened = sampleMakerSeries([
      order("Bid", 1_990_000n, 10n), order("AskResale", 2_010_000n, 20n),
      order("Bid", 1_850_000n, 30n), order("AskResale", 2_300_000n, 40n),
    ], FAIR, wider);
    expect(widened.depthWithin100bps).toBe(30n);
    expect(widened.depthInBand).toBe(100n);
  });

  it("uses the absolute floor when a cheap series makes the proportional band narrower than a tick", () => {
    // Fair 0.01 USDG: 1000 bps is 0.001 USDG, narrower than one PRICE_TICK, so the 0.02 USDG floor rules.
    const cheap = sampleMakerSeries([order("Bid", 9_950n, 10n), order("AskResale", 25_000n, 20n)], 10_000n);
    expect(cheap).toEqual({ twoSided: true, spreadBps: 15_050n, depthWithin100bps: 10n, depthInBand: 30n });
    expect(withinBand(25_000n, 10_000n, MAKER_SCORING_POLICY.band)).toBe(true);
    // Without the floor the same quote is outside, and the maker reads as one-sided.
    expect(withinBand(25_000n, 10_000n, { bps: 1_000n, minUsdg: 0n })).toBe(false);
  });

  it("refuses a band it cannot measure against rather than scoring one", () => {
    expect(() => sampleMakerSeries([], 0n)).toThrow(/invalid fair quote/);
    expect(() => sampleMakerSeries([], FAIR, { bps: 10_001n, minUsdg: 0n })).toThrow(/invalid scoring band/);
    expect(() => sampleMakerSeries([], FAIR, { bps: 100n, minUsdg: -1n })).toThrow(/invalid scoring band/);
  });

  it("rolls samples and replaces event-derived fill totals without recounting", () => {
    const one = advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [
      valid({ twoSided: true, spreadBps: 100n, depthWithin100bps: 200n, depthInBand: 260n }),
      valid({ twoSided: false, spreadBps: null, depthWithin100bps: 0n, depthInBand: 0n }),
    ], { fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n }, 10);
    const two = advanceMakerEpoch(one, [valid({ twoSided: true, spreadBps: 50n, depthWithin100bps: 100n, depthInBand: 160n })],
      { fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n }, 10);
    expect(two).toMatchObject({ samples: 3, validSamples: 3, absentSamples: 0, twoSidedSamples: 2, uptimePpm: 666_666n,
      avgSpreadBps: 75n, depthWithin100bps: 100n, depthInBand: 140n, fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n });
  });

  it("continues updating a previously enrolled maker after every resting order is gone", () => {
    const enrolled = enrolledMakerKeys(new Map([[A, 0]]), new Map(), [A]);
    expect([...enrolled]).toEqual([A]);
    const previous = { ...emptyMakerEpoch(A, 2958n), samples: 1, validSamples: 1, twoSidedSamples: 1,
      uptimePpm: 1_000_000n, fills: 1, volumeUsdg: 100n, rebatesUsdg: 2n };
    const next = advanceMakerEpoch(previous, [ABSENT], { fills: 2, volumeUsdg: 300n, rebatesUsdg: 5n }, 0);
    expect(next).toMatchObject({ samples: 2, absentSamples: 1, validSamples: 1, twoSidedSamples: 1,
      uptimePpm: 500_000n, fills: 2, volumeUsdg: 300n, rebatesUsdg: 5n });
  });

  // BREAK CHECK. Both makers end the epoch at the same
  // samples, uptime, depth and score; ONLY the kind counts tell a maker that never quoted from one that
  // quoted and measured zero. Count an absent sample as valid (or the reverse) in advanceMakerEpoch and
  // this goes red on absentSamples / validSamples.
  it("keeps a maker with no quotes apart from a maker whose quotes measured zero", () => {
    const flows = { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    // Both legs sit outside even the floor-widened band, so this is a measured sample of zero, not downtime.
    const measuredZero = valid(sampleMakerSeries([order("Bid", 1_000_000n), order("AskResale", 4_000_000n)], 2_000_000n));
    expect(measuredZero).toEqual(valid({ twoSided: false, spreadBps: null, depthWithin100bps: 0n, depthInBand: 0n }));
    const neverQuoted = advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [ABSENT, ABSENT, ABSENT], flows, 0);
    const quotedZero = advanceMakerEpoch(emptyMakerEpoch(B, 2958n), [measuredZero, measuredZero, measuredZero], flows, 0);
    const [scoredAbsent, scoredZero] = scoreMakerEpochs([neverQuoted, quotedZero]);

    const shared = { samples: 3, twoSidedSamples: 0, uptimePpm: 0n, depthWithin100bps: 0n, depthInBand: 0n, scorePpm: 0n };
    expect(scoredAbsent).toMatchObject(shared);
    expect(scoredZero).toMatchObject(shared);
    expect(scoredAbsent).toMatchObject({ absentSamples: 3, validSamples: 0, missingReferenceSamples: 0 });
    expect(scoredZero).toMatchObject({ absentSamples: 0, validSamples: 3, missingReferenceSamples: 0 });
  });

  it("counts a missing reference without letting it move uptime, depth or samples", () => {
    const flows = { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    const measured = advanceMakerEpoch(emptyMakerEpoch(A, 2958n),
      [valid({ twoSided: true, spreadBps: 40n, depthWithin100bps: 300n, depthInBand: 300n })], flows, 0);
    const next = advanceMakerEpoch(measured, [MISSING_REFERENCE, MISSING_REFERENCE], flows, 0);
    expect(next).toMatchObject({ samples: 1, validSamples: 1, absentSamples: 0, missingReferenceSamples: 2,
      twoSidedSamples: 1, uptimePpm: 1_000_000n, avgSpreadBps: 40n, depthWithin100bps: 300n, depthInBand: 300n });
  });

  it("labels every row with the benchmark policy and refuses to extend a row from another policy", () => {
    expect(MAKER_BENCHMARK_POLICY).toBe(2);
    const flows = { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    expect(emptyMakerEpoch(A, 2958n).benchmarkPolicy).toBe(MAKER_BENCHMARK_POLICY);
    expect(advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [ABSENT], flows, 0).benchmarkPolicy).toBe(MAKER_BENCHMARK_POLICY);
    const policyOne = { ...emptyMakerEpoch(A, 2958n), benchmarkPolicy: 1 };
    expect(() => advanceMakerEpoch(policyOne, [ABSENT], flows, 0)).toThrow(/benchmark policy 1, not 2/);
  });

  it("weights uptime, depth, spread and volume from the published policy, never from this file", () => {
    const w = MAKER_SCORING_POLICY.weights;
    const top = { ...emptyMakerEpoch(A, 2958n), samples: 1, twoSidedSamples: 1, uptimePpm: 1_000_000n,
      depthWithin100bps: 200n, depthInBand: 200n, avgSpreadBps: 50n, volumeUsdg: 200n };
    const low = { ...emptyMakerEpoch(B, 2958n), samples: 1, twoSidedSamples: 1, uptimePpm: 500_000n,
      depthWithin100bps: 100n, depthInBand: 100n, avgSpreadBps: 100n, volumeUsdg: 100n };
    const scores = scoreMakerEpochs([top, low]);
    // Derived from the policy rather than restated: the leader takes every rank, the laggard takes none
    // but keeps half its uptime weight.
    expect(scores[0]?.scorePpm).toBe((w.uptime * 1_000_000n + w.depth * 1_000_000n + w.spread * 1_000_000n + w.volume * 1_000_000n) / 100n);
    expect(scores[1]?.scorePpm).toBe((w.uptime * 500_000n) / 100n);
  });

  /**
   * THE SCORE RANKS ON THE BAND STATISTIC. Two makers identical except for which depth column carries
   * their units: the one with band depth outranks the one whose units sit only in the 100 bps column.
   * Rank depthWithin100bps here instead (wrong fix a, in its scoring half) and this goes red.
   */
  it("ranks depth on depthInBand, the policy statistic, not on the fixed 100 bps column", () => {
    const bandDeep = { ...emptyMakerEpoch(A, 2958n), samples: 1, depthWithin100bps: 0n, depthInBand: 500n };
    const fixedDeep = { ...emptyMakerEpoch(B, 2958n), samples: 1, depthWithin100bps: 500n, depthInBand: 0n };
    const [scoredBand, scoredFixed] = scoreMakerEpochs([bandDeep, fixedDeep]);
    expect(scoredBand?.scorePpm).toBe((MAKER_SCORING_POLICY.weights.depth * 1_000_000n) / 100n);
    expect(scoredFixed?.scorePpm).toBe(0n);
  });

  /**
   * WRONG FIX (a), the sampling half: depthWithin100bps must keep its 100 bps meaning whatever the epoch
   * band is. Point it at the band and this goes red naming the field.
   */
  it("keeps depthWithin100bps on 100 bps while the band moves under it", () => {
    expect(DEPTH_BAND_BPS).toBe(100n);
    const orders = [order("Bid", 1_990_000n, 10n), order("AskResale", 2_150_000n, 30n)];
    const narrow = sampleMakerSeries(orders, FAIR, { bps: 100n, minUsdg: 0n });
    const wide = sampleMakerSeries(orders, FAIR, { bps: 2_000n, minUsdg: 0n });
    expect(narrow.depthWithin100bps).toBe(10n);
    expect(wide.depthWithin100bps).toBe(10n);
    expect(narrow.depthInBand).toBe(10n);
    expect(wide.depthInBand).toBe(40n);
    // And the policy default is not 100 bps, so a producer that quietly used DEPTH_BAND_BPS for the band
    // would be publishing a different measurement under the name `depthInBand`.
    expect(MAKER_SCORING_POLICY.band.bps).not.toBe(DEPTH_BAND_BPS);
  });

  /**
   * WRONG FIX (b): a sample with no chain reference must never be scored as fair = 0 or as downtime.
   * `sampleMakerSeries` refuses a zero fair outright, and the epoch keeps the three kinds apart.
   */
  it("cannot score a missing reference as a zero fair or as downtime", () => {
    expect(() => sampleMakerSeries([order("Bid", 1_990_000n)], 0n)).toThrow(/invalid fair quote/);
    const flows = { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    const missing = advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [MISSING_REFERENCE, MISSING_REFERENCE], flows, 0);
    const downtime = advanceMakerEpoch(emptyMakerEpoch(B, 2958n), [ABSENT, ABSENT], flows, 0);
    expect(missing).toMatchObject({ samples: 0, absentSamples: 0, missingReferenceSamples: 2, uptimePpm: 0n });
    expect(downtime).toMatchObject({ samples: 2, absentSamples: 2, missingReferenceSamples: 0, uptimePpm: 0n });
    // The distinction survives scoring: only the maker that was actually absent has scored samples.
    const [scoredMissing, scoredDowntime] = scoreMakerEpochs([missing, downtime]);
    expect(scoredMissing?.samples).toBe(0);
    expect(scoredDowntime?.samples).toBe(2);
  });

  it("publishes a policy whose weights sum to 100 and whose band is data, not a literal", () => {
    const w = MAKER_SCORING_POLICY.weights;
    expect(w.uptime + w.depth + w.spread + w.volume).toBe(100n);
    expect(MAKER_SCORING_POLICY.band).toEqual({ bps: 1_000n, minUsdg: 20_000n });
    expect(MAKER_SCORING_POLICY.version).toBe(1);
  });

  it("the volume weight is exactly 0n, because resale volume is free to fabricate", () => {
    // A WASH-TRADE FILTER MUST LAND BEFORE THIS WEIGHT IS RAISED ABOVE 0. Resale premium volume can be manufactured by
    // a maker trading with itself through a second address, so a volume-weighted reward is farmable; the v9
    // pre-deploy verification rated that NOT REAL only because the weight is 0 (contracts
    // OrderBook review). Exactly 0n, not a range: any
    // positive weight is the defect.
    expect(MAKER_SCORING_POLICY.weights.volume).toBe(0n);
  });
});

/*//////////////////////////////////////////////////////////////
        PROTOCOL ACCOUNTS EARN NO MAKER ALLOCATION
//////////////////////////////////////////////////////////////*/

type Row = Record<string, unknown>;

/** The handler's reads and writes over plain arrays. `where` is not evaluated: every seeded row is returned. */
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
      insert: (table: object) => ({ values: async (value: Row) => { rows(table).push({ ...value }); return value; } }),
      update: (table: object, key: Row) => ({ set: async (patch: Row) => {
        const current = rows(table).find((row) => matches(row, key));
        if (!current) throw new Error("missing indexed row");
        Object.assign(current, patch);
        return current;
      } }),
    },
  };
}

describe("protocol accounts are excluded from maker scoring", () => {
  it("derives the set from the registry, every indexed House vault, and the latest ProtocolAccountSet", async () => {
    const { protocolMakerKeys } = await import("./makerScoring");
    const vault = "0x00000000000000000000000000000000000000A1";
    const unblocked = "0x00000000000000000000000000000000000000B2";
    const reblocked = "0x00000000000000000000000000000000000000B3";
    const keys = protocolMakerKeys({
      // Checksummed registry input, and an unset registry entry, which must not become a key.
      registry: ["0x000000000000000000000000000000000000C016", undefined],
      houseVaults: [{ vault }],
      protocolAccounts: [
        // Blocked, then unblocked at a later log in the SAME block: the later log wins.
        { vault, account: unblocked, blocked: true, block: 10n, logIndex: 1 },
        { vault, account: unblocked, blocked: false, block: 10n, logIndex: 2 },
        // Unblocked, then blocked in a later block, delivered out of order: still the later event wins.
        { vault, account: reblocked, blocked: true, block: 12n, logIndex: 0 },
        { vault, account: reblocked, blocked: false, block: 11n, logIndex: 5 },
      ],
    });
    expect([...keys].sort()).toEqual([
      "0x000000000000000000000000000000000000c016",
      vault.toLowerCase(),
      reblocked.toLowerCase(),
    ].sort());
  });

  it("a protocol account's quotes and fills earn no allocation while a partner's do", async () => {
    const { scoreMakerBlock } = await import("./makerScoring");
    const now = 1_800_000_000n;
    const epoch = makerWeekStartUtc(now);
    const underlying = "0x0000000000000000000000000000000000000011";
    const houseVault = "0x00000000000000000000000000000000000000a1";
    const blockedAccount = "0x00000000000000000000000000000000000000a2";
    const makerVault = (V2_MAKER_VAULT ?? "").toLowerCase();
    const partner = "0x0000000000000000000000000000000000000021";
    expect(makerVault).toMatch(/^0x[0-9a-f]{40}$/);

    let nextOrder = 1n;
    // Two resting orders each, so every maker is enrolled on order count alone (MIN_RESTING_ORDERS).
    const quotes = (maker: string) => ([["Bid", 9_950n], ["AskResale", 10_050n]] as const).map(([kind, price]) => ({
      orderId: nextOrder++, maker, longId: 2n, kind, price, units: 100n, filled: 0n, validUntil: 0n,
      status: "open", placedAt: now - 60n, placedBlock: 90n,
    }));
    let nextFill = 1;
    const fill = (maker: string, taker = "0x0000000000000000000000000000000000000032") => ({
      id: `fill-${nextFill++}`, orderId: 9n, longId: 2n, maker, taker, units: 100n, price: 10_000n, premium: 10_000n,
      makerRebate: 0n, ts: now - 60n, block: 99n,
    });
    const state = memoryDb([
      [schema.v2Series, [{ longId: 2n, ticker: "TEST", underlying, isPut: false, strike: 200_000_000n,
        expiry: now + 86_400n, mintCutoff: now + 80_000n, mintFeePpm: 0, status: "open", lastPrice: 10_000n }]],
      [schema.v2Order, [...quotes(partner), ...quotes(houseVault), ...quotes(makerVault), ...quotes(blockedAccount)]],
      [schema.v2Market, [{ underlying, enabled: true, mintPaused: false }]],
      [schema.v2OrderBookState, [{ id: "book", tradingPaused: false }]],
      [schema.v2Fill, [fill("0x0000000000000000000000000000000000000031"), fill(partner), fill(houseVault),
        fill(makerVault), fill(blockedAccount)]],
      [schema.v2HouseVault, [{ vault: houseVault }]],
      [schema.v2HouseProtocolAccount, [{ id: "pa-1", vault: houseVault, account: blockedAccount, blocked: true,
        ts: now - 600n, block: 50n, logIndex: 0 }]],
      // A House vault row scored earlier this epoch, before the exclusion: it must lose its score.
      [schema.v2MakerEpoch, [{
        id: makerEpochId(houseVault, epoch), maker: houseVault, epoch, tierBps: 0, benchmarkPolicy: MAKER_BENCHMARK_POLICY,
        samples: 1, absentSamples: 0, validSamples: 1, missingReferenceSamples: 0, twoSidedSamples: 1,
        uptimePpm: 1_000_000n, avgSpreadBps: 100n, depthWithin100bps: 200n, depthInBand: 200n, fills: 1,
        volumeUsdg: 10_000n, rebatesUsdg: 0n, scorePpm: 1_000_000n,
      }]],
    ]);

    await scoreMakerBlock({ event: { block: { number: 100n, timestamp: now } }, context: { db: state.db } } as never);

    const rows = state.rows(schema.v2MakerEpoch);
    const byMaker = new Map(rows.map((row) => [String(row.maker).toLowerCase(), row]));
    // The partner is scored on its quote and its fill.
    expect(byMaker.get(partner)).toMatchObject({ samples: 1, twoSidedSamples: 1, fills: 1, volumeUsdg: 10_000n });
    expect(byMaker.get(partner)?.scorePpm as bigint).toBeGreaterThan(0n);
    // Neither the MakerVault (registry) nor the account a House vault blocked gets a row at all.
    expect(byMaker.has(makerVault)).toBe(false);
    expect(byMaker.has(blockedAccount)).toBe(false);
    // The House vault's earlier row is left in place but carries no score, so no allocation.
    expect(byMaker.get(houseVault)).toMatchObject({ scorePpm: 0n, samples: 1, fills: 1 });
    expect(rows.filter((row) => (row.scorePpm as bigint) > 0n).map((row) => String(row.maker).toLowerCase()))
      .toEqual([partner]);
  });
});

/*
 * An unclaimed reward entry naming a House vault could be claimed for it mid-call, so no House vault
 * may ever hold a maker allocation. The v9 factory makes DAILY vaults and states the kind in its own 5-field
 * VaultCreated (`weekly` false). The case goes through the indexer's real House-vault source: it replays the
 * HouseVaultFactoryKinded:VaultCreated handler (src/v2/houseVault.ts) into the same store scoreMakerBlock reads, and
 * seeds no v2HouseVault row by hand. A vault list built here would prove only that the list was right.
 */
describe("a v9 DAILY House vault is excluded from maker scoring", () => {
  it("indexed by the real kinded-factory VaultCreated handler, a daily vault and a weekly vault earn no allocation", async () => {
    await import("./houseVault");
    const vaultCreated = handlers.get("HouseVaultFactoryKinded:VaultCreated");
    expect(vaultCreated, "src/v2/houseVault.ts registers the kinded factory's VaultCreated").toBeDefined();
    const { scoreMakerBlock } = await import("./makerScoring");
    const now = 1_800_000_000n;
    const underlying = "0x0000000000000000000000000000000000000011";
    const factory = "0x000000000000000000000000000000000000f00d";
    const daily = "0x00000000000000000000000000000000000000d1";
    const weekly = "0x00000000000000000000000000000000000000d7";
    const partner = "0x0000000000000000000000000000000000000021";

    let nextOrder = 1n;
    // Two resting orders each, so every maker is enrolled on order count alone (MIN_RESTING_ORDERS).
    const quotes = (maker: string) => ([["Bid", 9_950n], ["AskResale", 10_050n]] as const).map(([kind, price]) => ({
      orderId: nextOrder++, maker, longId: 2n, kind, price, units: 100n, filled: 0n, validUntil: 0n,
      status: "open", placedAt: now - 60n, placedBlock: 90n,
    }));
    let nextFill = 1;
    const fill = (maker: string, taker = "0x0000000000000000000000000000000000000032") => ({
      id: `fill-${nextFill++}`, orderId: 9n, longId: 2n, maker, taker, units: 100n, price: 10_000n, premium: 10_000n,
      makerRebate: 0n, ts: now - 60n, block: 99n,
    });
    const state = memoryDb([
      [schema.v2Series, [{ longId: 2n, ticker: "TEST", underlying, isPut: false, strike: 200_000_000n,
        expiry: now + 86_400n, mintCutoff: now + 80_000n, mintFeePpm: 0, status: "open", lastPrice: 10_000n }]],
      [schema.v2Order, [...quotes(partner), ...quotes(daily), ...quotes(weekly)]],
      [schema.v2Market, [{ underlying, enabled: true, mintPaused: false }]],
      [schema.v2OrderBookState, [{ id: "book", tradingPaused: false }]],
      [schema.v2Fill, [fill("0x0000000000000000000000000000000000000031"), fill(partner), fill(daily), fill(weekly)]],
      [schema.v2HouseVault, []],
      [schema.v2HouseProtocolAccount, []],
      [schema.v2MakerEpoch, []],
    ]);

    // The vault's two reads at creation; any other read is a surprise the case should see.
    const client = { readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "epochEnd") return now + 86_400n;
      if (functionName === "epochId") return 0n;
      throw new Error(`unexpected read ${functionName}`);
    } };
    let logIndex = 0;
    for (const [vault, statedWeekly] of [[daily, false], [weekly, true]] as const) {
      await vaultCreated!({
        event: {
          args: { underlying, vault, name: "Stonkhouse House TEST", symbol: "hTEST", weekly: statedWeekly },
          block: { timestamp: now - 3_600n, number: 80n },
          transaction: { hash: `0x${"c".repeat(64)}` },
          log: { logIndex: logIndex++, address: factory },
        },
        context: { db: state.db, client },
      });
    }
    // The handler wrote the rows, labelled as the v9 event stated them.
    expect(state.rows(schema.v2HouseVault).map((row) => [row.vault, row.kind])).toEqual([[daily, "daily"], [weekly, "weekly"]]);

    await scoreMakerBlock({ event: { block: { number: 100n, timestamp: now } }, context: { db: state.db } } as never);

    const byMaker = new Map(state.rows(schema.v2MakerEpoch).map((row) => [String(row.maker).toLowerCase(), row]));
    // The partner beside them is scored on the same quotes and fills, so the vaults' absence is the exclusion.
    expect(byMaker.get(partner)).toMatchObject({ samples: 1, twoSidedSamples: 1, fills: 1 });
    expect(byMaker.get(partner)?.scorePpm as bigint).toBeGreaterThan(0n);
    expect(byMaker.has(daily)).toBe(false);
    expect(byMaker.has(weekly)).toBe(false);
  });
});

/*
 * A write ask the take would skip is not a quote: the book off the Clearinghouse minter allow-list, or a writer
 * that never made the book its operator (OrderBook.sol:1091, :1101, callhouse-contracts).
 */
describe("maker scoring counts only write asks the take would fill", () => {
  it("enrolls the writer that made the book its operator and not the one that did not, and none off the allow-list", async () => {
    const { scoreMakerBlock } = await import("./makerScoring");
    const now = 1_800_000_000n;
    const underlying = "0x0000000000000000000000000000000000000011";
    const orderBook = (process.env.V2_ORDER_BOOK ?? "").toLowerCase();
    expect(orderBook).toMatch(/^0x[0-9a-f]{40}$/);
    const operator = "0x0000000000000000000000000000000000000041";
    const stranger = "0x0000000000000000000000000000000000000042";
    let nextOrder = 1n;
    // Two resting write asks each, so each would be enrolled on order count alone (MIN_RESTING_ORDERS).
    const asks = (maker: string) => [10_050n, 10_100n].map((price) => ({
      orderId: nextOrder++, maker, longId: 2n, kind: "AskWrite", price, units: 100n, filled: 0n, validUntil: 0n,
      status: "open", placedAt: now - 60n, placedBlock: 90n,
    }));
    const run = async (allowed: boolean) => {
      const state = memoryDb([
        [schema.v2Series, [{ longId: 2n, ticker: "TEST", underlying, isPut: false, strike: 200_000_000n,
          expiry: now + 86_400n, mintCutoff: now + 80_000n, mintFeePpm: 0, status: "open", lastPrice: 10_000n }]],
        [schema.v2Order, [...asks(operator), ...asks(stranger)]],
        [schema.v2Market, [{ underlying, enabled: true, mintPaused: false }]],
        [schema.v2OrderBookState, [{ id: "book", tradingPaused: false }]],
        [schema.v2Ledger, [operator, stranger].map((account) => ({ id: `${account}-${underlying}`, account, asset: underlying,
          free: 10n ** 20n }))],
        [schema.v2Minter, [{ minter: orderBook, allowed }]],
        [schema.v2Account, [
          { account: operator, operators: JSON.stringify({ [orderBook]: true }) },
          { account: stranger, operators: JSON.stringify({}) },
        ]],
        [schema.v2Fill, []], [schema.v2HouseVault, []], [schema.v2HouseProtocolAccount, []], [schema.v2MakerEpoch, []],
      ]);
      await scoreMakerBlock({ event: { block: { number: 100n, timestamp: now } }, context: { db: state.db } } as never);
      return state.rows(schema.v2MakerEpoch).map((row) => String(row.maker).toLowerCase()).sort();
    };
    expect(await run(true)).toEqual([operator]);
    expect(await run(false)).toEqual([]);
  });
});

/*
 * `enabled` gates only mint (Clearinghouse.mint MarketDisabled; the book's `plan.mintOpen`, OrderBook.sol:1106).
 * A disabled market's bids and resale asks still fill, so they are still quotes; only its write asks are not. The served
 * book already applies exactly that rule (aggregateBook); scoring used to drop the whole market.
 */
describe("maker scoring on a disabled market counts the quotes the take would still fill", () => {
  it("scores a bid-and-resale maker and enrolls no write-only maker", async () => {
    const { scoreMakerBlock } = await import("./makerScoring");
    const now = 1_800_000_000n;
    const underlying = "0x0000000000000000000000000000000000000011";
    const orderBook = (process.env.V2_ORDER_BOOK ?? "").toLowerCase();
    const quoter = "0x0000000000000000000000000000000000000051";
    const writer = "0x0000000000000000000000000000000000000052";
    let nextOrder = 1n;
    const order = (maker: string, kind: string, price: bigint) => ({
      orderId: nextOrder++, maker, longId: 2n, kind, price, units: 100n, filled: 0n, validUntil: 0n,
      status: "open", placedAt: now - 60n, placedBlock: 90n,
    });
    const state = memoryDb([
      [schema.v2Series, [{ longId: 2n, ticker: "TEST", underlying, isPut: false, strike: 200_000_000n,
        expiry: now + 86_400n, mintCutoff: now + 80_000n, mintFeePpm: 0, status: "open", lastPrice: 10_000n }]],
      [schema.v2Order, [order(quoter, "Bid", 9_950n), order(quoter, "AskResale", 10_050n),
        order(writer, "AskWrite", 10_050n), order(writer, "AskWrite", 10_100n)]],
      [schema.v2Market, [{ underlying, enabled: false, mintPaused: false }]],
      [schema.v2OrderBookState, [{ id: "book", tradingPaused: false }]],
      [schema.v2Ledger, [{ id: `${writer}-${underlying}`, account: writer, asset: underlying, free: 10n ** 20n }]],
      [schema.v2Minter, [{ minter: orderBook, allowed: true }]],
      [schema.v2Account, [{ account: writer, operators: JSON.stringify({ [orderBook]: true }) }]],
      // Another maker's fill gives the series its chain reference price (the quoter's own fill is not its benchmark).
      [schema.v2Fill, ["0x0000000000000000000000000000000000000031", quoter].map((maker, index) => ({ id: `fill-${index}`,
        orderId: 9n, longId: 2n, maker, taker: "0x0000000000000000000000000000000000000032", units: 100n,
        price: 10_000n, premium: 10_000n, makerRebate: 0n, ts: now - 60n, block: 99n }))],
      [schema.v2HouseVault, []], [schema.v2HouseProtocolAccount, []], [schema.v2MakerEpoch, []],
    ]);
    await scoreMakerBlock({ event: { block: { number: 100n, timestamp: now } }, context: { db: state.db } } as never);
    const byMaker = new Map(state.rows(schema.v2MakerEpoch).map((row) => [String(row.maker).toLowerCase(), row]));
    expect(byMaker.get(quoter)).toMatchObject({ samples: 1, validSamples: 1, twoSidedSamples: 1 });
    expect(byMaker.has(writer)).toBe(false);
  });
});

/*
 * OrderBook._reserveCollateral keeps ONE budget per writer per take, so a
 * writer's free balance backs its write asks once. Capped ask by ask, three asks on a 100-unit balance scored 300 units
 * of depth; the take can fill 100.
 */
describe("maker scoring counts a writer's collateral once across its write asks", () => {
  it("three 100-unit asks on a 100-unit balance score 100 units of ask depth, not 300", async () => {
    const { scoreMakerBlock } = await import("./makerScoring");
    const now = 1_800_000_000n;
    const underlying = "0x0000000000000000000000000000000000000011";
    const orderBook = (process.env.V2_ORDER_BOOK ?? "").toLowerCase();
    const writer = "0x0000000000000000000000000000000000000053";
    let nextOrder = 1n;
    const order = (kind: string, price: bigint) => ({
      orderId: nextOrder++, maker: writer, longId: 2n, kind, price, units: 100n, filled: 0n, validUntil: 0n,
      status: "open", placedAt: now - 60n, placedBlock: 90n,
    });
    const state = memoryDb([
      [schema.v2Series, [{ longId: 2n, ticker: "TEST", underlying, isPut: false, strike: 200_000_000n,
        expiry: now + 86_400n, mintCutoff: now + 80_000n, mintFeePpm: 0, status: "open", lastPrice: 10_000n }]],
      [schema.v2Order, [order("Bid", 9_980n), order("AskWrite", 10_000n), order("AskWrite", 10_020n),
        order("AskWrite", 10_040n)]],
      [schema.v2Market, [{ underlying, enabled: true, mintPaused: false }]],
      [schema.v2OrderBookState, [{ id: "book", tradingPaused: false }]],
      // 100 call units of free underlying (1e16 per unit), no rent (mintFeePpm 0).
      [schema.v2Ledger, [{ id: `${writer}-${underlying}`, account: writer, asset: underlying, free: 100n * 10n ** 16n }]],
      [schema.v2Minter, [{ minter: orderBook, allowed: true }]],
      [schema.v2Account, [{ account: writer, operators: JSON.stringify({ [orderBook]: true }) }]],
      [schema.v2Fill, [{ id: "fill-ref", orderId: 9n, longId: 2n, maker: "0x0000000000000000000000000000000000000031",
        taker: "0x0000000000000000000000000000000000000032", units: 100n, price: 10_000n, premium: 10_000n,
        makerRebate: 0n, ts: now - 60n, block: 99n }]],
      [schema.v2HouseVault, []], [schema.v2HouseProtocolAccount, []], [schema.v2MakerEpoch, []],
    ]);
    await scoreMakerBlock({ event: { block: { number: 100n, timestamp: now } }, context: { db: state.db } } as never);
    const row = state.rows(schema.v2MakerEpoch).find((item) => String(item.maker).toLowerCase() === writer);
    // Bid 100 + asks 100: the depth a take can actually fill against this writer.
    expect(row).toMatchObject({ validSamples: 1, twoSidedSamples: 1, depthWithin100bps: 200n, depthInBand: 200n });
  });
});
