import { beforeAll, describe, expect, it, vi } from "vitest";
import { toFunctionSelector } from "viem";

type Handler = (input: { event: any; context: any }) => Promise<void>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock("../../lib/registry", () => ({
  v2AccessManagerPonder: { on: (event: string, handler: Handler) => handlers.set(event, handler) },
}));
// accessManager.ts imports ../../lib/env for the env-first target map, which pulls FULL env
// validation into this file's import graph: without this mock the suite dies with
// "Missing required environment variable PONDER_RPC_URL_4663" before a single test runs.
// rent.handler.test.ts and flywheel.handler.test.ts mock it the same way. Every value is undefined
// so the map falls through to the mocked registry below, which is what these tests are about.
vi.mock("../../lib/env", () => ({
  V2_CLEARINGHOUSE: undefined, V2_ORDER_BOOK: undefined, V2_SETTLEMENT_ORACLE: undefined,
  V2_EXPIRY_CALENDAR: undefined, V2_KEEPER_REWARDS: undefined, V2_AUTO_ROLLER: undefined,
  V2_MAKER_VAULT: undefined, V2_MAKER_REGISTRY: undefined, V2_REWARDS_DISTRIBUTOR: undefined,
  V2_PAYOUT_ROUTER: undefined, V2_FEE_SPLITTER: undefined, V2_BUYBACK_EXECUTOR: undefined,
  V2_HOUSE_VAULT_FACTORY: undefined,
}));

vi.mock("../../lib/v2/marketRegistry.generated", () => ({
  V2_REGISTRY: {
    contracts: {
      clearinghouse: "0x000000000000000000000000000000000000c011",
      orderBook: null, settlementOracle: null, expiryCalendar: null, keeperRewards: null,
      autoRoller: null, payoutAdapter: null, makerVault: null, makerRegistry: null,
      rewardsDistributor: null, accessManager: null,
      sources: { chainlink: null, univ3: null, dataStreams: null },
    },
    flywheel: { feeSplitter: null, buybackExecutor: null },
  },
}));

vi.mock("ponder:schema", () => ({ default: {
  v2AccessOperation: "v2AccessOperation", v2AccessRole: "v2AccessRole",
  v2AccessRoleMember: "v2AccessRoleMember", v2AccessTarget: "v2AccessTarget",
  v2AccessTargetFunction: "v2AccessTargetFunction",
} }));

function memoryDb() {
  const rows = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = rows.get(name);
    if (value === undefined) rows.set(name, value = new Map());
    return value;
  };
  const rowKey = (row: any) => String(row.id ?? row.roleId ?? row.target);
  const lookupKey = (key: any) => String(key.id ?? key.roleId ?? key.target);
  return {
    rows,
    find: async (name: string, key: any) => table(name).get(lookupKey(key)) ?? null,
    insert: (name: string) => ({ values: (row: any) => {
      const key = rowKey(row);
      const previous = table(name).get(key);
      if (previous === undefined) table(name).set(key, row);
      return {
        then: (resolve: (value: any) => void) => resolve(row),
        onConflictDoUpdate: async (values: any) => {
          table(name).set(key, previous === undefined ? row : { ...previous, ...values });
        },
      };
    } }),
    update: (name: string, key: any) => ({ set: async (values: any) => {
      const id = lookupKey(key);
      const next = { ...table(name).get(id), ...values };
      table(name).set(id, next);
      return next;
    } }),
  };
}

const tx = `0x${"b".repeat(64)}`;
const manager = "0x000000000000000000000000000000000000a001";
let nextLog = 0;
const event = (args: object, timestamp = 100n) => ({
  args,
  block: { timestamp, number: 500n },
  transaction: { hash: tx },
  log: { logIndex: nextLog++, address: manager },
});

beforeAll(async () => { await import("./accessManager"); });

describe("AccessManager event reducers", () => {
  it("registers the complete AccessManager event surface", () => {
    for (const name of [
      "OperationScheduled", "OperationExecuted", "OperationCanceled",
      "RoleAdminChanged", "RoleGrantDelayChanged", "RoleGranted", "RoleGuardianChanged", "RoleLabel", "RoleRevoked",
      "TargetAdminDelayUpdated", "TargetClosed", "TargetFunctionRoleUpdated",
    ]) expect(handlers.has(`AccessManager:${name}`), name).toBe(true);
  });

  it("preserves member activation while staging an existing member's delay reduction", async () => {
    const db = memoryDb();
    const context = { db };
    const account = "0x000000000000000000000000000000000000a002";
    await handlers.get("AccessManager:RoleGranted")!({
      event: event({ roleId: 2n, account, delay: 259_200, since: 120, newMember: true }, 100n), context,
    });
    await handlers.get("AccessManager:RoleGranted")!({
      event: event({ roleId: 2n, account, delay: 0, since: 300, newMember: false }, 200n), context,
    });
    const id = `2:${account.toLowerCase()}`;
    expect(db.rows.get("v2AccessRoleMember")?.get(id)).toMatchObject({
      roleId: 2n, roleName: "MARKET_FEE_MANAGER", granted: true,
      memberSince: 120n, executionDelayS: 259_200n,
      pendingExecutionDelayS: 0n, pendingExecutionDelayAt: 300n,
    });
    await handlers.get("AccessManager:RoleRevoked")!({
      event: event({ roleId: 2n, account }, 250n), context,
    });
    expect(db.rows.get("v2AccessRoleMember")?.get(id)).toMatchObject({
      granted: false, memberSince: 120n, pendingExecutionDelayS: null,
    });
  });

  it("labels operations by target plus selector and keeps nonces independent", async () => {
    const db = memoryDb();
    const context = { db };
    const target = "0x000000000000000000000000000000000000c011";
    const caller = "0x000000000000000000000000000000000000a003";
    const selector = toFunctionSelector("setCreatePaused(bool)");
    await handlers.get("AccessManager:TargetFunctionRoleUpdated")!({
      event: event({ target, selector, roleId: 7n }), context,
    });
    const operationId = `0x${"1".repeat(64)}`;
    const data = `${selector}${"0".repeat(63)}1`;
    for (const nonce of [1, 2]) {
      await handlers.get("AccessManager:OperationScheduled")!({
        event: event({ operationId, nonce, schedule: 1_000, caller, target, data }, 400n), context,
      });
    }
    await handlers.get("AccessManager:OperationExecuted")!({
      event: event({ operationId, nonce: 1 }, 1_000n), context,
    });
    const first = db.rows.get("v2AccessOperation")?.get(`${operationId}:1`);
    const second = db.rows.get("v2AccessOperation")?.get(`${operationId}:2`);
    expect(first).toMatchObject({
      status: "executed", targetName: "Clearinghouse", functionSignature: "setCreatePaused(bool)",
      label: "Clearinghouse.setCreatePaused(bool)", roleId: 7n, roleName: "GUARDIAN",
      expectedRoleId: 7n, readyAt: 1_000n, expiresAt: 605_800n,
    });
    expect(second).toMatchObject({ status: "pending", nonce: 2n });
  });

  // THE PROTECTED FACT IS "A PENDING OPERATION IS VISIBLE", not "the resolver returns a string".
  // An operation against a target this indexer cannot name used to be stored with label null, and
  // BOTH /v2/admin/operations and the /v2/config pending notice filtered label-null rows away — so
  // the API answered HTTP 200 and "no pending governance operations" while one was pending against
  // the AccessManager. Naming a target is best effort. Showing the operation is not.
  it("keeps an operation against an UNCONFIGURED target visible, with an explicit unknown-target label", async () => {
    const db = memoryDb();
    const context = { db };
    // Present in no registry entry and no env var, so the resolver cannot name it.
    const target = "0x00000000000000000000000000000000deadbeef";
    const caller = "0x000000000000000000000000000000000000a004";
    const selector = toFunctionSelector("setCreatePaused(bool)");
    const operationId = `0x${"2".repeat(64)}`;
    const data = `${selector}${"0".repeat(63)}1`;
    await handlers.get("AccessManager:OperationScheduled")!({
      event: event({ operationId, nonce: 1, schedule: 1_000, caller, target, data }, 400n), context,
    });
    const row = db.rows.get("v2AccessOperation")?.get(`${operationId}:1`) as any;
    expect(row, "an operation against an unnamed target must still be recorded").toBeDefined();
    expect(row.targetName).toBeNull();
    expect(row.label).not.toBeNull();
    expect(row.label).toBe(`unknown-target ${target} ${selector}`);
  });

  // A SECOND path to a null label that the finding did not mention: calldata under four bytes
  // carries no selector, and the label then fell back to targetName, which is null for an unnamed
  // target. Fixing only the unknown-target case would have left this one dropping rows.
  it("keeps an operation whose calldata carries no selector visible too", async () => {
    const db = memoryDb();
    const context = { db };
    const target = "0x00000000000000000000000000000000deadbeef";
    const caller = "0x000000000000000000000000000000000000a005";
    const operationId = `0x${"3".repeat(64)}`;
    await handlers.get("AccessManager:OperationScheduled")!({
      event: event({ operationId, nonce: 1, schedule: 1_000, caller, target, data: "0x1234" }, 400n), context,
    });
    const row = db.rows.get("v2AccessOperation")?.get(`${operationId}:1`) as any;
    expect(row).toBeDefined();
    expect(row.label).toBe(`unknown-target ${target} no-selector`);
  });

  it("retains delayed role and target administration transitions", async () => {
    const db = memoryDb();
    const context = { db };
    const target = "0x000000000000000000000000000000000000c011";
    await handlers.get("AccessManager:RoleGrantDelayChanged")!({
      event: event({ roleId: 3n, delay: 50, since: 500 }, 100n), context,
    });
    await handlers.get("AccessManager:TargetAdminDelayUpdated")!({
      event: event({ target, delay: 75, since: 600 }, 100n), context,
    });
    expect(db.rows.get("v2AccessRole")?.get("3")).toMatchObject({
      grantDelayS: 0n, pendingGrantDelayS: 50n, pendingGrantDelayAt: 500n,
    });
    expect(db.rows.get("v2AccessTarget")?.get(target)).toMatchObject({
      adminDelayS: 0n, pendingAdminDelayS: 75n, pendingAdminDelayAt: 600n,
    });
  });
});
