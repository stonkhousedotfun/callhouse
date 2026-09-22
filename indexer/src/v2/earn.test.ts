/**
 * Earn vault and zap ingest replay (X8-06). Handlers register through v2EarnVaultPonder and
 * v2ZapPonder; this file captures them the way src/v2/houseVault.handler.test.ts:7-18 does.
 *
 * WHY THIS FILE EXISTS AT ALL: src/v2/earn.ts carried its registrations as PROSE COMMENTS, so
 * `v2_earn_vault_*` and `v2_zap_action` were always empty and src/api/v2/earn.ts served empty
 * arrays with no error. The row builders had tests; the registrations did not exist to have any.
 * These cases replay the real handlers, so deleting a registration fails them.
 *
 * Event names and argument shapes are read off the GENERATED ABI (abis/v2/earnVault.ts,
 * abis/v2/stockZap.ts), not off the plan document, which wrote them as placeholders on purpose.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const { handlers, registry } = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  for (const name of ["V2_ORDER_BOOK", "V2_SETTLEMENT_ORACLE", "V2_AUTO_ROLLER", "V2_MAKER_REGISTRY"]) {
    process.env[name] ??= "0x000000000000000000000000000000000000c012";
  }
  process.env.V2_START_BLOCK ??= "1";
  process.env.V2_EARN_VAULT ??= "0x000000000000000000000000000000000000e001";
  process.env.V2_ZAP_HELPER ??= "0x000000000000000000000000000000000000e002";
  process.env.V2_EARN_START_BLOCK ??= "100";
  const handlers = new Map<string, Handler>();
  return { handlers, registry: { on: (event: string, handler: Handler) => handlers.set(event, handler) } };
});

vi.mock("../../lib/registry", () => ({
  v2EarnVaultPonder: registry,
  v2ZapPonder: registry,
}));

vi.mock("ponder:schema", () => ({
  default: {
    v2EarnVaultState: "v2EarnVaultState",
    v2EarnVaultDeposit: "v2EarnVaultDeposit",
    v2EarnVaultDepositQueue: "v2EarnVaultDepositQueue",
    v2EarnVaultWithdrawal: "v2EarnVaultWithdrawal",
    v2EarnVaultWithdrawalQueue: "v2EarnVaultWithdrawalQueue",
    v2EarnVaultSkim: "v2EarnVaultSkim",
    v2EarnVaultAdapterMove: "v2EarnVaultAdapterMove",
    v2ZapAction: "v2ZapAction",
  },
}));

const VAULT = "0x000000000000000000000000000000000000e001";
const ASSET = "0x000000000000000000000000000000000000a55e";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";
const ADAPTER = "0x000000000000000000000000000000000000ad01";
const tx = "0x" + "11".repeat(32);
let logIndex = 0;

const event = (args: object, address: string = VAULT) => ({
  args,
  block: { timestamp: 1_700_000_000n + BigInt(logIndex), number: 64_100_000n },
  transaction: { hash: tx },
  log: { logIndex: logIndex++, address },
});

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, (value = new Map()));
    return value;
  };
  const keyOf = (row: any) => String(row.id ?? row.vault);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(keyOf(key)) ?? null,
    insert: (name: string) => ({
      values: (row: any) => {
        const key = keyOf(row);
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
        const id = keyOf(key);
        const next = { ...table(name).get(id), ...values };
        table(name).set(id, next);
        return next;
      },
    }),
  };
}

/** The asset() read every asset-keyed handler makes. `null` makes it throw, as an absent vault would. */
const ctx = (db: ReturnType<typeof memoryDb>, asset: string | null = ASSET) => ({
  db,
  client: {
    readContract: async () => {
      if (asset === null) throw new Error("no code at address");
      return asset;
    },
  },
});

/** One transient asset() failure followed by recovery, using the same handler context. */
const transientAssetCtx = (db: ReturnType<typeof memoryDb>) => {
  let reads = 0;
  return {
    db,
    client: {
      readContract: async () => {
        reads += 1;
        if (reads === 1) throw new Error("transient asset read failure");
        return ASSET;
      },
    },
  };
};

beforeAll(async () => {
  await import("./earn");
});

describe("earn vault registrations", () => {
  it("registers every event the generated ABI declares that this task indexes", () => {
    for (const name of [
      "EarnVault:Deposited", "EarnVault:DepositQueued", "EarnVault:DepositServed",
      "EarnVault:DepositCancelled", "EarnVault:Redeemed", "EarnVault:WithdrawalQueued",
      "EarnVault:WithdrawalServed", "EarnVault:WithdrawalCancelled", "EarnVault:Skimmed",
      "EarnVault:SweptToVenue", "EarnVault:PulledFromVenue", "EarnVault:AdapterSet",
      "EarnVault:SkimBpsSet", "EarnVault:FundingEnabledSet", "EarnVault:Transfer",
      "StockZap:WriteZapped", "StockZap:ExitZapped",
    ]) {
      expect(handlers.get(name), `${name} has no handler`).toBeTypeOf("function");
    }
  });

  it("Deposited writes a deposit row against the asset it read from the vault", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:Deposited")!({
      event: event({ caller: ALICE, receiver: BOB, assets: 500n, shares: 480n }),
      context: ctx(db),
    });
    expect([...(db.rows.get("v2EarnVaultDeposit")?.values() ?? [])][0]).toMatchObject({
      vault: VAULT, account: ALICE, receiver: BOB, asset: ASSET,
      assets: 500n, shares: 480n, queueId: null,
    });
    expect(db.rows.get("v2EarnVaultDeposit")?.size).toBe(1);
    expect(db.rows.get("v2EarnVaultDepositQueue")?.size ?? 0).toBe(0);
    expect(db.rows.get("v2EarnVaultState")?.get(VAULT).asset).toBe(ASSET);
  });

  it("a queued deposit becomes exactly one completed fact only when served", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:DepositQueued")!({
      event: event({ id: 11n, owner: ALICE, receiver: BOB, assets: 500n }),
      context: ctx(db),
    });
    expect(db.rows.get("v2EarnVaultDeposit")?.size ?? 0).toBe(0);
    expect(db.rows.get("v2EarnVaultDepositQueue")?.get(`${VAULT}-11`)).toMatchObject({
      account: ALICE, receiver: BOB, asset: ASSET, status: "queued",
      assetsQueued: 500n, mintedShares: null,
    });

    await handlers.get("EarnVault:DepositServed")!({
      event: event({ id: 11n, receiver: BOB, assets: 500n, shares: 480n }),
      context: ctx(db),
    });
    expect(db.rows.get("v2EarnVaultDepositQueue")?.get(`${VAULT}-11`)).toMatchObject({
      account: ALICE, receiver: BOB, status: "fulfilled", mintedShares: 480n,
    });
    expect([...(db.rows.get("v2EarnVaultDeposit")?.values() ?? [])]).toEqual([
      expect.objectContaining({
        vault: VAULT, account: ALICE, receiver: BOB, asset: ASSET,
        assets: 500n, shares: 480n, queueId: `${VAULT}-11`,
      }),
    ]);
  });

  it("a cancelled queued deposit stays visible without becoming a deposit fact", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:DepositQueued")!({
      event: event({ id: 12n, owner: ALICE, receiver: BOB, assets: 250n }),
      context: ctx(db),
    });
    await handlers.get("EarnVault:DepositCancelled")!({
      event: event({ id: 12n, owner: ALICE, assets: 250n }),
      context: ctx(db),
    });
    expect(db.rows.get("v2EarnVaultDeposit")?.size ?? 0).toBe(0);
    expect(db.rows.get("v2EarnVaultDepositQueue")?.get(`${VAULT}-12`)).toMatchObject({
      account: ALICE, receiver: BOB, status: "cancelled", assetsQueued: 250n,
      mintedShares: null,
    });
  });

  it("an immediate and a served queued deposit are one fact each, never counted across paths", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:Deposited")!({
      event: event({ caller: ALICE, receiver: ALICE, assets: 300n, shares: 290n }),
      context: ctx(db),
    });
    await handlers.get("EarnVault:DepositQueued")!({
      event: event({ id: 13n, owner: ALICE, receiver: BOB, assets: 700n }),
      context: ctx(db),
    });
    expect(db.rows.get("v2EarnVaultDeposit")?.size).toBe(1);
    await handlers.get("EarnVault:DepositServed")!({
      event: event({ id: 13n, receiver: BOB, assets: 700n, shares: 650n }),
      context: ctx(db),
    });
    const deposits = [...(db.rows.get("v2EarnVaultDeposit")?.values() ?? [])];
    expect(deposits).toHaveLength(2);
    expect(deposits.filter((row) => row.queueId === null)).toEqual([
      expect.objectContaining({ account: ALICE, receiver: ALICE, assets: 300n, shares: 290n }),
    ]);
    expect(deposits.filter((row) => row.queueId === `${VAULT}-13`)).toEqual([
      expect.objectContaining({ account: ALICE, receiver: BOB, assets: 700n, shares: 650n }),
    ]);
    expect(deposits.reduce((total, row) => total + row.assets, 0n)).toBe(1_000n);
  });

  it("retries the same deposit after a transient asset read failure", async () => {
    const db = memoryDb();
    const context = transientAssetCtx(db);
    const deposited = event({ caller: ALICE, receiver: ALICE, assets: 500n, shares: 480n });

    await expect(handlers.get("EarnVault:Deposited")!({ event: deposited, context }))
      .rejects.toThrow("transient asset read failure");
    expect(db.rows.get("v2EarnVaultDeposit")?.size ?? 0).toBe(0);
    expect(db.rows.get("v2EarnVaultState")?.size ?? 0).toBe(0);

    await handlers.get("EarnVault:Deposited")!({ event: deposited, context });
    expect([...(db.rows.get("v2EarnVaultDeposit")?.values() ?? [])]).toEqual([
      expect.objectContaining({
        vault: VAULT, account: ALICE, receiver: ALICE, asset: ASSET,
        assets: 500n, shares: 480n, queueId: null,
      }),
    ]);
    expect(db.rows.get("v2EarnVaultState")?.get(VAULT).asset).toBe(ASSET);
  });

  it("retries withdrawal 7 after asset recovery and keeps a partial service visible", async () => {
    const db = memoryDb();
    const context = transientAssetCtx(db);
    const queued = event({ id: 7n, owner: ALICE, receiver: ALICE, shares: 100n, shortfall: 40n });

    await expect(handlers.get("EarnVault:WithdrawalQueued")!({ event: queued, context }))
      .rejects.toThrow("transient asset read failure");
    expect(db.rows.get("v2EarnVaultWithdrawalQueue")?.size ?? 0).toBe(0);
    expect(db.rows.get("v2EarnVaultState")?.size ?? 0).toBe(0);

    await handlers.get("EarnVault:WithdrawalQueued")!({ event: queued, context });
    expect(db.rows.get("v2EarnVaultWithdrawalQueue")?.get(`${VAULT}-7`)).toMatchObject({
      vault: VAULT,
      account: ALICE,
      asset: ASSET,
      status: "queued",
      sharesQueued: 100n,
    });

    await handlers.get("EarnVault:WithdrawalServed")!({
      event: event({ id: 7n, receiver: ALICE, shares: 60n, assets: 60n, complete: false }),
      context,
    });
    expect(db.rows.get("v2EarnVaultWithdrawalQueue")?.get(`${VAULT}-7`)).toMatchObject({
      status: "queued",
      fulfilledAssets: 60n,
    });
    expect([...(db.rows.get("v2EarnVaultWithdrawal")?.values() ?? [])]).toEqual([
      expect.objectContaining({ queueId: `${VAULT}-7`, account: ALICE, asset: ASSET, assets: 60n }),
    ]);
  });

  /**
   * A partial service must NOT close the request. `complete` false means the contract will serve it
   * again, so the row stays queued and accumulates what it has been paid.
   */
  it("a partial WithdrawalServed keeps the request queued and accumulates the paid amount", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:WithdrawalQueued")!({
      event: event({ id: 7n, owner: ALICE, receiver: ALICE, shares: 100n, shortfall: 40n }),
      context: ctx(db),
    });
    expect(db.rows.get("v2EarnVaultWithdrawalQueue")?.get(`${VAULT}-7`).status).toBe("queued");

    await handlers.get("EarnVault:WithdrawalServed")!({
      event: event({ id: 7n, receiver: ALICE, shares: 60n, assets: 60n, complete: false }),
      context: ctx(db),
    });
    const partial = db.rows.get("v2EarnVaultWithdrawalQueue")?.get(`${VAULT}-7`);
    expect(partial.status).toBe("queued");
    expect(partial.fulfilledAssets).toBe(60n);

    await handlers.get("EarnVault:WithdrawalServed")!({
      event: event({ id: 7n, receiver: ALICE, shares: 40n, assets: 40n, complete: true }),
      context: ctx(db),
    });
    const done = db.rows.get("v2EarnVaultWithdrawalQueue")?.get(`${VAULT}-7`);
    expect(done.status).toBe("fulfilled");
    expect(done.fulfilledAssets).toBe(100n);
    expect(db.rows.get("v2EarnVaultWithdrawal")?.size).toBe(2);
  });

  /** Cancelled leaves fulfilledAssets NULL: nothing was paid, which is not paying zero. */
  it("WithdrawalCancelled closes the row without inventing a zero payout", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:WithdrawalQueued")!({
      event: event({ id: 9n, owner: ALICE, receiver: ALICE, shares: 10n, shortfall: 0n }),
      context: ctx(db),
    });
    await handlers.get("EarnVault:WithdrawalCancelled")!({
      event: event({ id: 9n, owner: ALICE, shares: 10n }),
      context: ctx(db),
    });
    const row = db.rows.get("v2EarnVaultWithdrawalQueue")?.get(`${VAULT}-9`);
    expect(row.status).toBe("cancelled");
    expect(row.fulfilledAssets).toBeNull();
  });

  it("Skimmed stores the fee that moved, not the gain and not the high-water mark", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:Skimmed")!({
      event: event({ gain: 1_000n, fee: 100n, highWaterMark: 5_000n }),
      context: ctx(db),
    });
    const row = [...(db.rows.get("v2EarnVaultSkim")?.values() ?? [])][0];
    expect(row.amount).toBe(100n);
    expect(row.asset).toBe(ASSET);
  });

  it("SweptToVenue and PulledFromVenue are one table with a direction, and a short delivery still succeeded", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:AdapterSet")!({ event: event({ adapter: ADAPTER }), context: ctx(db) });
    await handlers.get("EarnVault:SweptToVenue")!({
      event: event({ offered: 900n, deposited: 900n }),
      context: ctx(db),
    });
    await handlers.get("EarnVault:PulledFromVenue")!({
      event: event({ requested: 500n, withdrawn: 300n }),
      context: ctx(db),
    });
    const moves = [...(db.rows.get("v2EarnVaultAdapterMove")?.values() ?? [])];
    expect(moves.map((m) => m.direction)).toEqual(["out", "in"]);
    expect(moves.every((m) => m.adapter === ADAPTER)).toBe(true);
    const short = moves.find((m) => m.direction === "in");
    expect(short.requested).toBe(500n);
    expect(short.delivered).toBe(300n);
    expect(short.succeeded).toBe(true);
  });

  it("the config setters upsert one state row rather than three", async () => {
    const db = memoryDb();
    await handlers.get("EarnVault:AdapterSet")!({ event: event({ adapter: ADAPTER }), context: ctx(db) });
    await handlers.get("EarnVault:SkimBpsSet")!({ event: event({ bps: 250 }), context: ctx(db) });
    await handlers.get("EarnVault:FundingEnabledSet")!({ event: event({ on: false }), context: ctx(db) });
    expect(db.rows.get("v2EarnVaultState")?.size).toBe(1);
    expect(db.rows.get("v2EarnVaultState")?.get(VAULT)).toMatchObject({
      adapter: ADAPTER, skimBps: 250, paused: true,
    });
  });

  it("tracks share supply only from mint and burn Transfer logs", async () => {
    const db = memoryDb();
    const transfer = handlers.get("EarnVault:Transfer");
    expect(transfer).toBeTypeOf("function");
    await transfer!({
      event: event({ from: "0x0000000000000000000000000000000000000000", to: ALICE, value: 10n }),
      context: ctx(db),
    });
    expect(db.rows.get("v2EarnVaultState")?.get(VAULT).sharesSupply).toBe(10n);
    await transfer!({ event: event({ from: ALICE, to: ADAPTER, value: 7n }), context: ctx(db) });
    expect(db.rows.get("v2EarnVaultState")?.get(VAULT).sharesSupply).toBe(10n);
    await transfer!({
      event: event({ from: ADAPTER, to: "0x0000000000000000000000000000000000000000", value: 4n }),
      context: ctx(db),
    });
    expect(db.rows.get("v2EarnVaultState")?.get(VAULT).sharesSupply).toBe(6n);
  });

  it("fails closed if a share burn appears without a preceding mint", async () => {
    const db = memoryDb();
    await expect(handlers.get("EarnVault:Transfer")!({
      event: event({ from: ALICE, to: "0x0000000000000000000000000000000000000000", value: 1n }),
      context: ctx(db),
    })).rejects.toThrow(/share supply/i);
    expect(db.rows.get("v2EarnVaultState")?.get(VAULT)?.sharesSupply ?? null).toBeNull();
  });

  it("both zap directions write one action row each, keyed by the emitting contract", async () => {
    const db = memoryDb();
    await handlers.get("StockZap:WriteZapped")!({
      event: event({ account: ALICE, asset: ASSET, caller: ALICE, usdgIn: 100n, assetOut: 2n, venue: 1 }, "0x000000000000000000000000000000000000e002"),
      context: ctx(db),
    });
    await handlers.get("StockZap:ExitZapped")!({
      event: event({ account: ALICE, asset: ASSET, caller: ALICE, assetIn: 2n, usdgOut: 98n, venue: 1 }, "0x000000000000000000000000000000000000e002"),
      context: ctx(db),
    });
    const actions = [...(db.rows.get("v2ZapAction")?.values() ?? [])];
    expect(actions.map((a) => a.kind)).toEqual(["write", "exit"]);
    expect(actions.map((a) => [a.amountIn, a.amountOut])).toEqual([[100n, 2n], [2n, 98n]]);
    expect(actions.every((a) => a.zap === "0x000000000000000000000000000000000000e002")).toBe(true);
  });
});
