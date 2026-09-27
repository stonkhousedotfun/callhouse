import { describe, expect, it, vi } from "vitest";

vi.mock("ponder:schema", () => ({ default: { v2EarnVaultSample: "v2EarnVaultSample" } }));

import { earnSampleId, sampleEarnVault } from "./earnSample";
import { EARN_VENUE_PROBE_SHARES } from "./earnYield";

const VAULT = "0x000000000000000000000000000000000000E011" as const;
const ADAPTER = "0x000000000000000000000000000000000000ad01";
const VENUE = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const TS = 1_800_003_700n; // hour 500001
const BLOCK = 70_000_000n;

function memoryDb() {
  const rows = new Map<string, any>();
  let conflictIgnored = 0;
  return {
    rows,
    get conflictIgnored() { return conflictIgnored; },
    find: async (_table: string, key: { id: string }) => rows.get(key.id) ?? null,
    insert: (_table: string) => ({
      values: (row: any) => ({
        onConflictDoNothing: async () => {
          if (rows.has(row.id)) conflictIgnored += 1;
          else rows.set(row.id, row);
        },
      }),
    }),
  };
}

/** A readContract that answers from `answers` by `address:functionName`; an Error or a missing key reverts. */
function client(answers: Record<string, unknown>, asked: string[] = []) {
  return {
    readContract: async (args: { address: string; functionName: string; args?: unknown[] }) => {
      const key = `${args.address.toLowerCase()}:${args.functionName}`;
      asked.push(key);
      if (args.functionName === "convertToAssets") expect(args.args).toEqual([EARN_VENUE_PROBE_SHARES]);
      const value = answers[key];
      if (value === undefined || value instanceof Error) throw value ?? new Error("execution reverted");
      return value;
    },
  };
}

const v = (fn: string) => `${VAULT.toLowerCase()}:${fn}`;
const vaultAnswers = {
  // The vault. 1 USDG deposited mints 1e18 share base units (one whole share, 18 decimals over a
  // 1e12-per-USDG-unit first mint), and the mark is reported per whole share: 1 USDG = 1_000_000 base units.
  [v("totalAssets")]: 1_050_000n,
  [v("totalSupply")]: 10n ** 18n,
  [v("highWaterMark")]: 1_000_000n,
  [v("skimBps")]: 1_000,
  [v("hasOpenPosition")]: false,
  [v("adapter")]: ADAPTER,
  [`${ADAPTER}:venue`]: VENUE,
  [`${VENUE.toLowerCase()}:name`]: "Steakhouse USDG",
  [`${VENUE.toLowerCase()}:convertToAssets`]: 1_007_800_908_426_163n,
};

const event = (number = BLOCK, timestamp = TS) => ({ block: { number, timestamp } });

describe("hourly Earn sampler", () => {
  it("writes one row per vault per hour with the net-of-skim price and the venue probe", async () => {
    const db = memoryDb();
    const outcome = await sampleEarnVault({
      vault: VAULT, startBlock: 1, event: event(), context: { db, client: client(vaultAnswers) },
    });
    expect(outcome).toBe("written");
    const row = db.rows.get(earnSampleId(VAULT, TS));
    expect(earnSampleId(VAULT, TS)).toBe(`${VAULT.toLowerCase()}-500001`);
    expect(row).toEqual({
      id: `${VAULT.toLowerCase()}-500001`,
      vault: VAULT.toLowerCase(),
      ts: TS,
      block: BLOCK,
      totalAssets: 1_050_000n,
      totalSupply: 10n ** 18n,
      highWaterMark: 1_000_000n,
      skimBps: 1_000,
      pricePerShare: 1_050_000n,
      // 10% of the 5% above the mark is withheld: 1.045 USDG a share.
      netPricePerShare: 1_045_000n,
      positionOpen: false,
      adapter: ADAPTER,
      venue: VENUE.toLowerCase(),
      venueName: "Steakhouse USDG",
      venueProbeAssets: 1_007_800_908_426_163n,
    });
  });

  it("reads nothing when the hour already has its row (59 ticks of 60)", async () => {
    const db = memoryDb();
    await sampleEarnVault({ vault: VAULT, startBlock: 1, event: event(), context: { db, client: client(vaultAnswers) } });
    const asked: string[] = [];
    const again = await sampleEarnVault({
      vault: VAULT, startBlock: 1, event: event(BLOCK + 600n, TS + 60n), context: { db, client: client(vaultAnswers, asked) },
    });
    expect(again).toBe("exists");
    expect(asked).toEqual([]);
    // The next hour is a new row.
    const next = await sampleEarnVault({
      vault: VAULT, startBlock: 1, event: event(BLOCK + 36_000n, TS + 3_600n), context: { db, client: client(vaultAnswers) },
    });
    expect(next).toBe("written");
    expect(db.rows.size).toBe(2);
  });

  it("does nothing unconfigured or before the vault's deploy block", async () => {
    const db = memoryDb();
    const asked: string[] = [];
    expect(await sampleEarnVault({ vault: undefined, startBlock: 1, event: event(), context: { db, client: client(vaultAnswers, asked) } }))
      .toBe("unconfigured");
    expect(await sampleEarnVault({ vault: VAULT, startBlock: undefined, event: event(), context: { db, client: client(vaultAnswers, asked) } }))
      .toBe("unconfigured");
    expect(await sampleEarnVault({ vault: VAULT, startBlock: Number(BLOCK) + 1, event: event(), context: { db, client: client(vaultAnswers, asked) } }))
      .toBe("before-deploy");
    expect(asked).toEqual([]);
    expect(db.rows.size).toBe(0);
  });

  it("leaves the hour free for a retry when the price cannot be read", async () => {
    const db = memoryDb();
    const answers = { ...vaultAnswers, [v("totalSupply")]: new Error("rpc down") };
    expect(await sampleEarnVault({ vault: VAULT, startBlock: 1, event: event(), context: { db, client: client(answers) } }))
      .toBe("unread");
    expect(db.rows.size).toBe(0);
  });

  it("stores a failed side read as null, never as zero, and skips the venue with no adapter", async () => {
    const db = memoryDb();
    const asked: string[] = [];
    const answers = {
      ...vaultAnswers,
      [v("hasOpenPosition")]: new Error("execution reverted"),
      [v("adapter")]: "0x0000000000000000000000000000000000000000",
    };
    await sampleEarnVault({ vault: VAULT, startBlock: 1, event: event(), context: { db, client: client(answers, asked) } });
    const row = db.rows.get(earnSampleId(VAULT, TS));
    expect(row.positionOpen).toBeNull();
    expect(row.adapter).toBe("0x0000000000000000000000000000000000000000");
    expect(row.venue).toBeNull();
    expect(row.venueName).toBeNull();
    expect(row.venueProbeAssets).toBeNull();
    expect(asked.some((key) => key.startsWith(ADAPTER) || key.startsWith(VENUE.toLowerCase()))).toBe(false);
  });

  it("a supply of zero is no price, not a zero price", async () => {
    const db = memoryDb();
    const answers = { ...vaultAnswers, [v("totalAssets")]: 0n, [v("totalSupply")]: 0n };
    await sampleEarnVault({ vault: VAULT, startBlock: 1, event: event(), context: { db, client: client(answers) } });
    const row = db.rows.get(earnSampleId(VAULT, TS));
    expect(row.pricePerShare).toBeNull();
    expect(row.netPricePerShare).toBeNull();
  });
});
