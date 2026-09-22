/**
 * House vault ingest replay. Handlers register through v2HouseVaultPonder; this file
 * captures them the same way flywheel.handler.test.ts:7-18 does.
 *
 * Topic0s are derived from generated ABIs and compared with independently
 * mirrored event signatures in lib/v2/houseVaultEvents.ts.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { toEventSelector } from "viem";
import type { Abi, AbiEvent } from "viem";

import * as actualSchema from "../../ponder.schema";
import { houseVaultAbi } from "../../abis/v2/houseVault";
import { houseVaultFactoryAbi } from "../../abis/v2/houseVaultFactory";
import {
  HOUSE_VAULT_EVENTS,
} from "../../lib/v2/houseVaultEvents";
import { houseFillRows, meta } from "../../lib/v2/houseVault";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  for (const name of ["V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY"]) {
    process.env[name] ??= "0x000000000000000000000000000000000000c012";
  }
  process.env.V2_START_BLOCK ??= "1";
  process.env.V2_HOUSE_VAULT_FACTORY ??= "0x000000000000000000000000000000000000f001";
  process.env.V2_HOUSE_START_BLOCK ??= "100";
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (event: string, handler: Handler) => handlers.set(event, handler) } };
});

vi.mock("../../lib/registry", () => ({
  v2HouseVaultPonder: registry,
  // The OrderFilled handler registers here. T-175 gives it a House-fill call site, and the only way to
  // prove that call site exists is to replay the real handler - see the fill-tape case below.
  v2Ponder: registry,
}));

vi.mock("ponder:schema", () => ({
  default: {
    v2HouseVault: "v2HouseVault",
    v2HouseEpoch: "v2HouseEpoch",
    v2HouseNav: "v2HouseNav",
    v2HouseShareBalance: "v2HouseShareBalance",
    v2HouseDepositQueue: "v2HouseDepositQueue",
    v2HouseWithdrawQueue: "v2HouseWithdrawQueue",
    v2HouseQueueSettlement: "v2HouseQueueSettlement",
    v2HouseClaim: "v2HouseClaim",
    v2HousePerformanceFee: "v2HousePerformanceFee",
    v2HouseFill: "v2HouseFill",
    v2HouseSelfDealRefusal: "v2HouseSelfDealRefusal",
    v2HouseProtocolAccount: "v2HouseProtocolAccount",
    v2HouseLimits: "v2HouseLimits",
    v2HouseExposure: "v2HouseExposure",
    // Read or written by OrderBook:OrderFilled, which the fill-tape case replays.
    v2Order: "v2Order",
    v2Fill: "v2Fill",
    v2Series: "v2Series",
    v2Market: "v2Market",
  },
}));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, (value = new Map()));
    return value;
  };
  // `id` and `vault` cover every House table. The order book's rows are keyed by orderId, longId or
  // underlying, and the fill-tape case replays the real OrderFilled handler, which reads all three.
  const keyOf = (row: any) => String(row.id ?? row.vault ?? row.orderId ?? row.longId ?? row.underlying);
  const rowKey = keyOf;
  const lookupKey = keyOf;
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(lookupKey(key)) ?? null,
    insert: (name: string) => ({
      values: (row: any) => {
        const key = rowKey(row);
        const previous = table(name).get(key);
        if (previous === undefined) table(name).set(key, row);
        return {
          then: (resolve: (value: any) => void) => resolve(row),
          onConflictDoUpdate: async (values: any) => {
            table(name).set(key, previous === undefined ? { ...row, ...values } : { ...previous, ...values });
          },
        };
      },
    }),
    update: (name: string, key: any) => ({
      set: async (values: any) => {
        const id = lookupKey(key);
        const next = { ...table(name).get(id), ...values };
        table(name).set(id, next);
        return next;
      },
    }),
  };
}

const tx = `0x${"b".repeat(64)}`;
let logIndex = 0;
const FACTORY = "0x000000000000000000000000000000000000f001";
const VAULT = "0x000000000000000000000000000000000000b001";
const UNDERLYING = "0x0000000000000000000000000000000000000a01";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";
const ZERO = "0x0000000000000000000000000000000000000000";

const event = (args: object, address: string) => ({
  args,
  block: { timestamp: 1_700_000_000n + BigInt(logIndex), number: 64_100_000n },
  transaction: { hash: tx },
  log: { logIndex: logIndex++, address },
});

beforeAll(async () => {
  await import("./houseVault");
  await import("./orderBook");
});

/**
 * The parameter used to be `readonly { type?: string; name?: string }[]`, which widened every entry
 * to a shape {toEventSelector} does not accept. Taking viem's `Abi` keeps the discriminated union, so
 * the `type !== "event"` check below NARROWS to `AbiEvent` instead of needing an assertion -- and a
 * missing event now throws by name rather than returning undefined through a `!`.
 */
function abiEvent(abi: Abi, name: string): AbiEvent {
  const item = abi.find((entry) => entry.type === "event" && entry.name === name);
  if (item === undefined || item.type !== "event") throw new Error(`abi has no event ${name}`);
  return item;
}

describe("House vault event signatures", () => {
  it("match the compiler-pinned keccak strings in HouseVaultInterface.t.sol", () => {
    expect(toEventSelector(abiEvent(houseVaultFactoryAbi, "VaultCreated"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.VaultCreated),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "EpochRolled"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.EpochRolled),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "DepositRequested"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.DepositRequested),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "Claimed"))).toBe(
      toEventSelector(HOUSE_VAULT_EVENTS.Claimed),
    );
    expect(toEventSelector(abiEvent(houseVaultAbi, "LimitsSet"))).toBe(
      toEventSelector("event LimitsSet((uint64,uint128,uint16,uint16,uint32,uint128))"),
    );
  });
});

describe("House vault handler registrations", () => {
  it("registers every indexed event", () => {
    for (const name of [
      "HouseVaultFactory:VaultCreated",
      "HouseVault:DepositRequested",
      "HouseVault:DepositRequestCancelled",
      "HouseVault:WithdrawRequested",
      "HouseVault:WithdrawRequestCancelled",
      "HouseVault:EpochRolled",
      "HouseVault:Claimed",
      "HouseVault:LimitsSet",
      "HouseVault:PerformanceFeeBpsSet",
      "HouseVault:ProtocolAccountSet",
      "HouseVault:QuotingPausedSet",
      "HouseVault:ExposureSet",
      "HouseVault:Transfer",
    ]) expect(handlers.has(name), name).toBe(true);
  });
});

describe("one replay assertion per indexed event", () => {
  it("VaultCreated opens the registry and a running epoch 0", async () => {
    const db = memoryDb();
    const readAbis: unknown[] = [];
    const context = {
      db,
      client: {
        readContract: async ({ abi, functionName }: { abi: unknown; functionName: string }) => {
          readAbis.push(abi);
          if (functionName === "epochEnd") return 1_700_604_800n;
          if (functionName === "epochId") return 0n;
          throw new Error(functionName);
        },
      },
    };
    await handlers.get("HouseVaultFactory:VaultCreated")!({
      event: event({ underlying: UNDERLYING, vault: VAULT, name: "Stonkhouse House NVDA", symbol: "hNVDA" }, FACTORY),
      context,
    });
    expect(readAbis).toEqual([houseVaultAbi, houseVaultAbi]);
    const vault = db.rows.get("v2HouseVault")?.get(VAULT);
    expect(vault).toMatchObject({
      vault: VAULT,
      underlying: UNDERLYING,
      sharesToken: VAULT,
      factory: FACTORY,
      symbol: "hNVDA",
      sharesSupply: null,
      currentEpochId: 0n,
      currentEpochEnd: 1_700_604_800n,
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-0`)).toMatchObject({ status: "running", resultUsdg: null });
    expect(db.rows.get("v2HouseNav")).toBeUndefined();
  });

  it("DepositRequested / cancel, WithdrawRequested / cancel", async () => {
    const db = memoryDb();
    const context = { db };
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: ALICE, usdgAmount: 100n, stockAmount: 0n, epochId: 0n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`)).toMatchObject({
      status: "queued", usdgAmount: 100n, stockAmount: 0n, epochId: 0n,
    });
    await handlers.get("HouseVault:DepositRequestCancelled")!({
      event: event({ account: ALICE, usdgAmount: 100n, stockAmount: 0n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`).status).toBe("cancelled");
    await handlers.get("HouseVault:WithdrawRequested")!({
      event: event({ account: BOB, shares: 5n, epochId: 0n }, VAULT),
      context,
    });
    await handlers.get("HouseVault:WithdrawRequestCancelled")!({
      event: event({ account: BOB, shares: 5n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseWithdrawQueue")?.get(`${VAULT}-${BOB}`).status).toBe("cancelled");
  });

  it("EpochRolled writes exactly one NAV row; usdg and stockUnits stay null", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, sharesSupply: 0n }]]));
    db.rows.set("v2HouseEpoch", new Map([[`${VAULT}-0`, { id: `${VAULT}-0`, vault: VAULT, epochId: 0n, start: 1n, status: "running" }]]));
    const context = { db };
    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 0n, epochEnd: 99n, price: 50n, nav: 1_000n, supply: 1_000n,
        sharesMinted: 1_000n, sharesBurned: 0n, performanceFee: 0n,
      }, VAULT),
      context,
    });
    const navs = [...(db.rows.get("v2HouseNav")?.values() ?? [])];
    expect(navs).toHaveLength(1);
    expect(navs[0]).toMatchObject({
      epochId: 0n, usdg: null, stockUnits: null, settlementPrice: 50n, navUsdg: 1_000n,
      sourceEvent: "EpochRolled", performanceFee: 0n,
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-0`).status).toBe("rolled");
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-1`).status).toBe("running");
    expect(db.rows.get("v2HouseQueueSettlement")?.size).toBe(1);
    expect([...(db.rows.get("v2HousePerformanceFee")?.values() ?? [])][0].amount).toBe(0n);
  });

  it("Claimed stores in-kind legs", async () => {
    const db = memoryDb();
    const context = { db };
    await handlers.get("HouseVault:Claimed")!({
      event: event({ account: ALICE, shares: 10n, usdgAmount: 4n, stockAmount: 2n }, VAULT),
      context,
    });
    expect([...(db.rows.get("v2HouseClaim")?.values() ?? [])][0]).toMatchObject({
      account: ALICE, shares: 10n, usdgAmount: 4n, stockAmount: 2n,
    });
  });

  it("LimitsSet, PerformanceFeeBpsSet, ProtocolAccountSet, QuotingPausedSet, ExposureSet", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, quotingPaused: null, performanceFeeBps: null }]]));
    const context = { db };
    await handlers.get("HouseVault:LimitsSet")!({
      event: event({
        limits: { maxSeriesUnits: 1n, maxTotalNotional: 2n, askToleranceBps: 3, maxBidBpsOfSpot: 4,
          maxOrderLifetime: 0xffff_ffff, maxDailyOutflow: 6n },
      }, VAULT),
      context,
    });
    expect([...(db.rows.get("v2HouseLimits")?.values() ?? [])][0]).toMatchObject({
      maxSeriesUnits: 1n, maxDailyOutflow: 6n, askToleranceBps: 3,
      maxOrderLifetime: 4_294_967_295n,
    });
    expect(actualSchema.v2HouseLimits.maxOrderLifetime.getSQLType()).toBe("numeric(78)");
    await handlers.get("HouseVault:PerformanceFeeBpsSet")!({ event: event({ bps: 200 }, VAULT), context });
    expect(db.rows.get("v2HouseVault")?.get(VAULT).performanceFeeBps).toBe(200);
    await handlers.get("HouseVault:ProtocolAccountSet")!({
      event: event({ account: BOB, blocked: true }, VAULT),
      context,
    });
    expect([...(db.rows.get("v2HouseProtocolAccount")?.values() ?? [])][0]).toMatchObject({
      account: BOB, blocked: true,
    });
    expect(db.rows.get("v2HouseSelfDealRefusal")).toBeUndefined();
    await handlers.get("HouseVault:QuotingPausedSet")!({ event: event({ paused: true }, VAULT), context });
    expect(db.rows.get("v2HouseVault")?.get(VAULT).quotingPaused).toBe(true);
    await handlers.get("HouseVault:ExposureSet")!({
      event: event({ longId: 9n, units: 8n, notional: 7n, totalNotional: 6n }, VAULT),
      context,
    });
    expect([...(db.rows.get("v2HouseExposure")?.values() ?? [])][0]).toMatchObject({ longId: 9n, units: 8n });
  });

  it("Transfer updates holder balances and supply; never writes NAV", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, sharesSupply: null }]]));
    const context = { db };
    await handlers.get("HouseVault:Transfer")!({
      event: event({ from: ZERO, to: ALICE, value: 50n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseVault")?.get(VAULT).sharesSupply).toBe(50n);
    expect(db.rows.get("v2HouseShareBalance")?.get(`${VAULT}-${ALICE}`).shares).toBe(50n);
    expect(db.rows.get("v2HouseNav")).toBeUndefined();
  });
});

describe("two depositors, three epochs, one win and one loss; mid-epoch deposit does not write NAV", () => {
  it("walks the queue, two boundaries, and a mid-epoch deposit", async () => {
    logIndex = 0;
    const db = memoryDb();
    const context = {
      db,
      client: {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "epochEnd") return 1_000n;
          if (functionName === "epochId") return 0n;
          throw new Error(functionName);
        },
      },
    };
    await handlers.get("HouseVaultFactory:VaultCreated")!({
      event: event({ underlying: UNDERLYING, vault: VAULT, name: "H", symbol: "hNVDA" }, FACTORY),
      context,
    });
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: ALICE, usdgAmount: 100n, stockAmount: 0n, epochId: 0n }, VAULT),
      context,
    });
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: BOB, usdgAmount: 50n, stockAmount: 0n, epochId: 0n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseNav")?.size ?? 0).toBe(0);

    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 0n, epochEnd: 1_000n, price: 10n, nav: 200n, supply: 150n,
        sharesMinted: 150n, sharesBurned: 0n, performanceFee: 5n,
      }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseNav")?.size).toBe(1);
    expect([...(db.rows.get("v2HouseNav")?.values() ?? [])][0].navUsdg).toBe(200n);

    const charlie = "0x00000000000000000000000000000000000000c1";
    await handlers.get("HouseVault:DepositRequested")!({
      event: event({ account: charlie, usdgAmount: 20n, stockAmount: 0n, epochId: 1n }, VAULT),
      context,
    });
    expect(db.rows.get("v2HouseNav")?.size).toBe(1);

    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 1n, epochEnd: 2_000n, price: 8n, nav: 140n, supply: 170n,
        sharesMinted: 20n, sharesBurned: 0n, performanceFee: 0n,
      }, VAULT),
      context,
    });
    const navs = [...(db.rows.get("v2HouseNav")?.values() ?? [])];
    expect(navs).toHaveLength(2);
    expect(navs.map((row) => row.navUsdg)).toEqual([200n, 140n]);
    expect(navs.every((row) => row.sourceEvent === "EpochRolled")).toBe(true);
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-1`).status).toBe("rolled");
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-2`).status).toBe("running");
    expect(db.rows.get("v2HouseSelfDealRefusal")).toBeUndefined();
  });

  /*--------------------------------------------------------------- T-175 */

  /**
   * F-APP-INDEXER-01. `HouseVault.claim` retires a side on "a request existed AND its epoch is past",
   * then computes the payout, which floors to zero routinely. The event carries AMOUNTS, NOT a
   * retirement flag, so gating `closeQueue` on them left a zero-output row `queued` FOREVER - and the
   * next request added to the phantom amount, corrupting a tape only a full re-index repairs.
   */
  it("a claim that pays zero still closes the matured queue row", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, currentEpochId: 1n }]]));
    db.rows.set("v2HouseDepositQueue", new Map([[`${VAULT}-${ALICE}`, {
      id: `${VAULT}-${ALICE}`, vault: VAULT, account: ALICE, epochId: 0n,
      usdgAmount: 5n, stockAmount: 0n, status: "queued",
    }]]));
    await handlers.get("HouseVault:Claimed")!({
      event: event({ account: ALICE, shares: 0n, usdgAmount: 0n, stockAmount: 0n }, VAULT),
      context: { db },
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`).status).toBe("claimed");
  });

  /** The other direction: maturity, not the claim, is what closes a row. */
  it("a request made in the OPEN epoch is not closed by a claim that retired the other side", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, currentEpochId: 1n }]]));
    db.rows.set("v2HouseDepositQueue", new Map([[`${VAULT}-${ALICE}`, {
      id: `${VAULT}-${ALICE}`, vault: VAULT, account: ALICE, epochId: 1n,
      usdgAmount: 5n, stockAmount: 0n, status: "queued",
    }]]));
    await handlers.get("HouseVault:Claimed")!({
      event: event({ account: ALICE, shares: 0n, usdgAmount: 7n, stockAmount: 0n }, VAULT),
      context: { db },
    });
    expect(db.rows.get("v2HouseDepositQueue")?.get(`${VAULT}-${ALICE}`).status).toBe("queued");
  });

  /**
   * F-APP-INDEXER-02. The roll wrote the new epoch's `end` as null though `roll()` sets it in the SAME
   * transaction. Note the `client` mock: the existing EpochRolled case above passes no client, so the
   * read throws into its catch and that case stays green whatever this handler does - which is exactly
   * why this one supplies the client and asserts the value.
   */
  it("the roll fills the new epoch's end from epochEnd(), not null", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT, currentEpochId: 0n, currentEpochEnd: 1_000n }]]));
    await handlers.get("HouseVault:EpochRolled")!({
      event: event({
        epochId: 0n, epochEnd: 1_000n, price: 50n, nav: 1_000n, supply: 10n,
        sharesMinted: 0n, sharesBurned: 0n, performanceFee: 0n,
      }, VAULT),
      context: { db, client: { readContract: async () => 2_000n } },
    });
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-0`).end).toBe(1_000n);
    expect(db.rows.get("v2HouseEpoch")?.get(`${VAULT}-1`).end).toBe(2_000n);
    expect(db.rows.get("v2HouseVault")?.get(VAULT).currentEpochEnd).toBe(2_000n);
  });

  /**
   * F-APP-INDEXER-03, THE ARCHETYPE. `recordHouseFills` was exported and called by nothing - the whole
   * repository held one occurrence of the name, its own definition - so `v2_house_fill` was silently
   * always empty. This replays the REAL OrderFilled handler rather than the pure projector below,
   * because the projector was never the broken part: the CALL SITE was. Delete the call and this goes
   * red while every houseFillRows test stays green.
   */
  it("a House vault's OrderFilled writes the fill tape", async () => {
    const db = memoryDb();
    db.rows.set("v2HouseVault", new Map([[VAULT, { vault: VAULT }]]));
    db.rows.set("v2Order", new Map([["7", {
      orderId: 7n, longId: 3n, maker: VAULT, units: 10n, filled: 0n, status: "open",
    }]]));
    db.rows.set("v2Series", new Map([["3", {
      longId: 3n, underlying: "NVDA", volumeUnits: 0n, volumeUsdg: 0n,
    }]]));
    db.rows.set("v2Market", new Map([["NVDA", {
      underlying: "NVDA", volumeUnits: 0n, volumeUsdg: 0n, premiumUsdg: 0n, feesUsdg: 0n,
    }]]));
    await handlers.get("OrderBook:OrderFilled")!({
      event: event({
        orderId: 7n, longId: 3n, taker: ALICE, maker: VAULT, units: 2n, price: 5n, premium: 10n,
        sellerFee: 1n, makerRebate: 0n, primary: true, takerIsBuyer: true, recipient: ALICE,
      }, VAULT),
      context: { db },
    });
    expect(db.rows.get("v2HouseFill")?.size ?? 0).toBeGreaterThan(0);
  });
});

describe("houseFillRows", () => {
  it("projects an OrderFilled onto a registered vault and ignores others", () => {
    const fillEvent = {
      args: {
        orderId: 1n, longId: 2n, maker: VAULT as `0x${string}`, taker: ALICE as `0x${string}`,
        units: 3n, price: 4n, premium: 5n, sellerFee: 6n, makerRebate: 7n,
      },
      block: { timestamp: 9n, number: 8n },
      log: { logIndex: 0, address: "0x0000000000000000000000000000000000000b00" as `0x${string}` },
      transaction: { hash: tx as `0x${string}` },
    };
    expect(houseFillRows(fillEvent, new Set([VAULT]))).toEqual([
      expect.objectContaining({ vault: VAULT, side: "maker", makerRebate: 7n, units: 3n }),
    ]);
    expect(houseFillRows(fillEvent, new Set())).toEqual([]);
  });
});

describe("meta", () => {
  it("keys a row by transaction and log index", () => {
    expect(meta(event({}, VAULT) as never)).toEqual(expect.objectContaining({
      sourceAddress: VAULT,
      tx,
    }));
  });
});
