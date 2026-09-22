import schema from "ponder:schema";
import { toFunctionSelector, type Address, type Hex } from "viem";

import {
  V2_AUTO_ROLLER, V2_CLEARINGHOUSE, V2_EXPIRY_CALENDAR, V2_FEE_SPLITTER, V2_HOUSE_VAULT_FACTORY,
  V2_KEEPER_REWARDS, V2_MAKER_REGISTRY, V2_MAKER_VAULT, V2_ORDER_BOOK, V2_PAYOUT_ROUTER,
  V2_REWARDS_DISTRIBUTOR, V2_SETTLEMENT_ORACLE, V2_BUYBACK_EXECUTOR, V2_EARN_VAULT,
} from "../../lib/env";
import { v2AccessManagerPonder as ponder } from "../../lib/registry";
import { V2_ACCESS_MANIFEST } from "../../lib/v2/accessManagerRoles.generated";
import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";

const OPERATION_EXPIRATION = 7n * 86_400n;
const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

/**
 * Name -> address for the targets an address source exists for. ENV FIRST, generated registry
 * second: `indexer/lib/v2/marketRegistry.generated.ts` is all nulls until O8-08's post-broadcast
 * write-back, so building from the registry alone made EVERY target unresolvable on a real
 * deployment. `api/v2/markets.ts` already does `V2_ACCESS_MANAGER ?? contracts.accessManager` one
 * file away; this is that idiom applied to the whole set.
 *
 * Addresses are NOT taken from `accessManagerRoles.generated.ts` — that file carries role and
 * selector data, not addresses.
 */
const addressByName: Record<string, string | null> = {
  Clearinghouse: V2_CLEARINGHOUSE ?? V2_REGISTRY.contracts.clearinghouse,
  OrderBook: V2_ORDER_BOOK ?? V2_REGISTRY.contracts.orderBook,
  SettlementOracle: V2_SETTLEMENT_ORACLE ?? V2_REGISTRY.contracts.settlementOracle,
  ChainlinkFeedSource: V2_REGISTRY.contracts.sources.chainlink,
  UniV3TwapSource: V2_REGISTRY.contracts.sources.univ3,
  DataStreamsSource: V2_REGISTRY.contracts.sources.dataStreams,
  ExpiryCalendar: V2_EXPIRY_CALENDAR ?? V2_REGISTRY.contracts.expiryCalendar,
  KeeperRewards: V2_KEEPER_REWARDS ?? V2_REGISTRY.contracts.keeperRewards,
  AutoRoller: V2_AUTO_ROLLER ?? V2_REGISTRY.contracts.autoRoller,
  MakerVault: V2_MAKER_VAULT ?? V2_REGISTRY.contracts.makerVault,
  MakerRegistry: V2_MAKER_REGISTRY ?? V2_REGISTRY.contracts.makerRegistry,
  RewardsDistributor: V2_REWARDS_DISTRIBUTOR ?? V2_REGISTRY.contracts.rewardsDistributor,
  PayoutRouter: V2_PAYOUT_ROUTER ?? V2_REGISTRY.contracts.payoutAdapter,
  FeeSplitter: V2_FEE_SPLITTER ?? V2_REGISTRY.flywheel.feeSplitter,
  V4BuybackExecutor: V2_BUYBACK_EXECUTOR ?? V2_REGISTRY.flywheel.buybackExecutor,
  HouseVaultFactory: V2_HOUSE_VAULT_FACTORY ?? null,
  // The Earn vault HAS an address source and was simply never listed here: `V2_EARN_VAULT`
  // (lib/env.ts) is the same env ponder.config.ts registers the Earn sources from. Until T-501 the
  // manifest carried an EarnVault target while this map did not, so every Earn AccessManager
  // operation labelled `unknown-target …` although the address was available all along. There is no
  // registry key to fall back to — marketRegistry.generated.ts has no earnVault — so env or null.
  EarnVault: V2_EARN_VAULT ?? null,
  // No address source exists for these four today: no env name, no registry key. HouseVault is
  // created per instance by the factory, so it is not a single static address at all. They resolve
  // to null, which no longer hides their operations — the label falls back to `unknown-target …`.
  // StockVenueAdapter arrived in the manifest with the same T-422 export that added EarnVault, and
  // the bidirectional guard below is what surfaced it: fixing only the reported name would have left
  // this one silent, which is the whole reason the guard and not the entry is the defect. Checked
  // before writing null rather than guessing an address: the NAME `V2_STOCK_VENUE_ADAPTER` exists
  // on the DEPLOY side (callhouse-contracts script/v2/DeployV8.s.sol, docs/DEPLOY-V2.md, where its
  // own source reads "none, and blocked on an owner input"), but lib/env.ts exports no such
  // variable and marketRegistry.generated.ts has no venue or adapter key, so nothing here can read
  // one today. When an env name lands, this null becomes `V2_STOCK_VENUE_ADAPTER ?? null`.
  HouseVault: null,
  Hedger: null,
  RewardsDistributorLender: null,
  StockVenueAdapter: null,
};

/**
 * THE LIST OF TARGETS COMES FROM THE MANIFEST, NOT FROM A LITERAL HERE.
 *
 * A hand-maintained list is how this broke: `accessManagerRoles.generated.ts` grew to 19 targets in
 * T-153 while this map stayed at 15, so RewardsDistributorLender, HouseVault, HouseVaultFactory and
 * Hedger had no entry at all and their operations could never be named. Keying off the manifest
 * means the next manifest change cannot silently desync — a new target appears here automatically
 * with a null address, and the assertion below fails loudly if this file has no address entry for
 * it, which is the prompt to add one.
 */
const targetAddresses: Record<string, string | null> = Object.fromEntries(
  Object.keys(V2_ACCESS_MANIFEST.targets as Record<string, unknown>)
    .map((name) => [name, addressByName[name] ?? null]),
);

/**
 * Desync in the other direction: an address entry whose name the manifest does not carry is dead
 * weight that will never be consulted, and usually means a rename landed in one file only.
 */
const unknownAddressNames = Object.keys(addressByName)
  .filter((name) => !(name in targetAddresses));
if (unknownAddressNames.length > 0) {
  throw new Error(`[callhouse/indexer] accessManager addressByName has names absent from the role manifest: ${unknownAddressNames.join(", ")}`);
}

/**
 * THE SAME DESYNC, THE OTHER WAY ROUND, AND THE ONE THAT ACTUALLY HAPPENED (T-501).
 *
 * The check above only ever looked from `addressByName` towards the manifest. A manifest target
 * with NO entry here passed in silence, because `targetAddresses` maps it to `null` through the
 * `?? null` above and a null is indistinguishable from a deliberate "no address source exists".
 * That is how EarnVault sat unlabelled through a whole interface version: the file carried an
 * assertion that reads as if it covered this and did not — a check that cannot see its subject.
 *
 * So state the requirement instead: EVERY manifest target names a key here, and a target with no
 * address source says so with an explicit `null`. Throwing rather than warning is deliberate and
 * matches the check above; a mixed policy in one file would be worse than either.
 */
const unlistedTargets = Object.keys(V2_ACCESS_MANIFEST.targets as Record<string, unknown>)
  .filter((name) => !(name in addressByName));
if (unlistedTargets.length > 0) {
  throw new Error(`[callhouse/indexer] accessManager addressByName has no entry for role-manifest targets: ${unlistedTargets.join(", ")}. Add each one — an explicit null is the right entry when no env name or registry key exists.`);
}

const manifestRoles = V2_ACCESS_MANIFEST.roles as Record<string, number>;
const manifestDelays = V2_ACCESS_MANIFEST.delaysS as Record<string, number>;
const manifestTargets = V2_ACCESS_MANIFEST.targets as unknown as Record<string, Record<string, string>>;

function roleName(roleId: bigint): string {
  return Object.entries(manifestRoles).find(([, id]) => BigInt(id) === roleId)?.[0] ?? `ROLE_${roleId}`;
}

function expectedDelay(roleId: bigint): bigint | null {
  const delay = manifestDelays[roleName(roleId)];
  return delay === undefined ? null : BigInt(delay);
}

function targetName(target: Address): string | null {
  const needle = target.toLowerCase();
  return Object.entries(targetAddresses).find(([, address]) => address?.toLowerCase() === needle)?.[0] ?? null;
}

/**
 * A label for an operation whose target this indexer cannot name. It is deliberately NOT null.
 *
 * A pending governance operation must never be invisible, and `label` is descriptive metadata — it
 * must not decide whether a row is reported. It used to: the API filtered on `isNotNull(label)` and
 * the wire mapper dropped label-null rows, so an operation against an unresolved target produced
 * HTTP 200 and "no pending operations" while the operation was pending against the AccessManager.
 * Naming the target is best effort; SHOWING the operation is not.
 *
 * The string carries the two facts an operator needs to act — which address and which selector —
 * and is greppable, so an unnamed target is visible as a gap rather than as silence.
 */
function unknownTargetLabel(target: Address, selector: Hex): string {
  return `unknown-target ${lower(target)} ${lower(selector)}`;
}

function manifestFunction(target: Address, selector: Hex) {
  const name = targetName(target);
  if (name === null) {
    return {
      targetName: null, functionSignature: null, expectedRoleId: null,
      label: unknownTargetLabel(target, selector),
    };
  }
  const functions = manifestTargets[name] ?? {};
  const signature = Object.keys(functions).find((candidate) => toFunctionSelector(candidate) === selector) ?? null;
  const expectedName = signature === null ? null : functions[signature] ?? null;
  const expectedRole = expectedName === null ? undefined : manifestRoles[expectedName];
  return {
    targetName: name,
    functionSignature: signature,
    // Only named AccessManager roles have an expected role id; keep an unknown future annotation nullable.
    expectedRoleId: expectedRole === undefined ? null : BigInt(expectedRole),
    label: signature === null ? name : `${name}.${signature}`,
  };
}

function selectorFromData(data: Hex): Hex | null {
  return data.length < 10 ? null : data.slice(0, 10).toLowerCase() as Hex;
}

function operationId(operationId: Hex, nonce: bigint | number): string {
  return `${operationId.toLowerCase()}:${BigInt(nonce)}`;
}

function memberId(roleId: bigint, account: Address): string {
  return `${roleId}:${account.toLowerCase()}`;
}

function targetFunctionId(target: Address, selector: Hex): string {
  return `${target.toLowerCase()}:${selector.toLowerCase()}`;
}

function eventMeta(event: {
  block: { timestamp: bigint; number: bigint };
  log: { logIndex: number };
  transaction: { hash: Hex };
}) {
  return {
    updatedAt: event.block.timestamp,
    updatedBlock: event.block.number,
    updatedLogIndex: event.log.logIndex,
    updatedTx: event.transaction.hash,
  };
}

function delayedValue(
  current: bigint | null,
  pending: bigint | null,
  pendingAt: bigint | null,
  next: bigint,
  effect: bigint,
  at: bigint,
) {
  const promoted = pending !== null && pendingAt !== null && pendingAt <= at ? pending : current;
  if (effect <= at) return { current: next, pending: null, pendingAt: null };
  return { current: promoted, pending: next, pendingAt: effect };
}

async function updateRole(
  context: any,
  event: any,
  roleId: bigint,
  changes: Record<string, unknown>,
) {
  const current = await context.db.find(schema.v2AccessRole, { roleId });
  const values = { ...changes, ...eventMeta(event) };
  if (current === null) {
    await context.db.insert(schema.v2AccessRole).values({
      roleId, name: roleName(roleId), expectedExecutionDelayS: expectedDelay(roleId), ...values,
    });
  } else {
    await context.db.update(schema.v2AccessRole, { roleId }).set(values);
  }
}

ponder.on("AccessManager:OperationScheduled", async ({ event, context }) => {
  const { operationId: rawId, nonce: rawNonce, schedule, caller, target, data } = event.args;
  const nonce = BigInt(rawNonce);
  const targetKey = lower(target);
  const selector = selectorFromData(data);
  // Calldata too short to carry a selector. `targetName` is null for a target this indexer cannot
  // name, so the label falls back to a non-null description for the same reason as above: the row
  // must remain visible. "no-selector" is stated rather than implied by an empty field.
  const annotation = selector === null
    ? {
        targetName: targetName(targetKey), functionSignature: null, expectedRoleId: null,
        label: targetName(targetKey) ?? `unknown-target ${targetKey} no-selector`,
      }
    : manifestFunction(targetKey, selector);
  const mapping = selector === null ? null : await context.db.find(schema.v2AccessTargetFunction, {
    id: targetFunctionId(targetKey, selector),
  });
  // AccessManager's default for an unmapped restricted selector is ADMIN_ROLE (0).
  const actualRoleId = mapping?.roleId ?? 0n;
  const readyAt = BigInt(schedule);
  const id = operationId(rawId, nonce);
  const current = await context.db.find(schema.v2AccessOperation, { id });
  const values = {
    opId: lower(rawId), nonce,
    caller: lower(caller), target: targetKey, data: lower(data), selector,
    ...annotation,
    roleId: actualRoleId, roleName: roleName(actualRoleId),
    scheduledAt: event.block.timestamp, readyAt, expiresAt: readyAt + OPERATION_EXPIRATION,
    scheduledBlock: event.block.number, scheduledLogIndex: event.log.logIndex,
    scheduledTx: event.transaction.hash,
  };
  if (current === null) {
    await context.db.insert(schema.v2AccessOperation).values({ id, status: "pending", ...values });
  } else {
    // A bounded replay may see the terminal event first. Filling its payload must never reopen it.
    await context.db.update(schema.v2AccessOperation, { id }).set(values);
  }
});

async function finishOperation(event: any, context: any, status: "executed" | "canceled") {
  const operation = lower(event.args.operationId);
  const nonce = BigInt(event.args.nonce);
  const id = operationId(operation, nonce);
  const current = await context.db.find(schema.v2AccessOperation, { id });
  const values = {
    status,
    finishedAt: event.block.timestamp,
    finishedBlock: event.block.number,
    finishedLogIndex: event.log.logIndex,
    finishedTx: event.transaction.hash,
  };
  if (current === null) {
    await context.db.insert(schema.v2AccessOperation).values({
      id, opId: operation, nonce, ...values,
    });
  } else {
    await context.db.update(schema.v2AccessOperation, { id }).set(values);
  }
}

ponder.on("AccessManager:OperationExecuted", async ({ event, context }) => {
  await finishOperation(event, context, "executed");
});

ponder.on("AccessManager:OperationCanceled", async ({ event, context }) => {
  await finishOperation(event, context, "canceled");
});

ponder.on("AccessManager:RoleLabel", async ({ event, context }) => {
  await updateRole(context, event, BigInt(event.args.roleId), { chainLabel: event.args.label });
});

ponder.on("AccessManager:RoleAdminChanged", async ({ event, context }) => {
  await updateRole(context, event, BigInt(event.args.roleId), { adminRoleId: BigInt(event.args.admin) });
});

ponder.on("AccessManager:RoleGuardianChanged", async ({ event, context }) => {
  await updateRole(context, event, BigInt(event.args.roleId), { guardianRoleId: BigInt(event.args.guardian) });
});

ponder.on("AccessManager:RoleGrantDelayChanged", async ({ event, context }) => {
  const roleId = BigInt(event.args.roleId);
  const current = await context.db.find(schema.v2AccessRole, { roleId });
  const next = delayedValue(
    current?.grantDelayS ?? 0n,
    current?.pendingGrantDelayS ?? null,
    current?.pendingGrantDelayAt ?? null,
    BigInt(event.args.delay), BigInt(event.args.since), event.block.timestamp,
  );
  await updateRole(context, event, roleId, {
    grantDelayS: next.current ?? 0n,
    pendingGrantDelayS: next.pending,
    pendingGrantDelayAt: next.pendingAt,
  });
});

ponder.on("AccessManager:RoleGranted", async ({ event, context }) => {
  const { account, newMember } = event.args;
  const roleId = BigInt(event.args.roleId);
  const accountKey = lower(account);
  const id = memberId(roleId, accountKey);
  const current = await context.db.find(schema.v2AccessRoleMember, { id });
  const grantMeta = {
    granted: true,
    lastGrantNewMember: newMember,
    grantedAt: event.block.timestamp,
    grantedBlock: event.block.number,
    grantedTx: event.transaction.hash,
    revokedAt: null, revokedBlock: null, revokedTx: null,
  };
  let delayValues: Record<string, unknown>;
  if (newMember) {
    delayValues = {
      memberSince: BigInt(event.args.since),
      executionDelayS: BigInt(event.args.delay),
      pendingExecutionDelayS: null,
      pendingExecutionDelayAt: null,
    };
  } else {
    const next = delayedValue(
      current?.executionDelayS ?? null,
      current?.pendingExecutionDelayS ?? null,
      current?.pendingExecutionDelayAt ?? null,
      BigInt(event.args.delay), BigInt(event.args.since), event.block.timestamp,
    );
    delayValues = {
      executionDelayS: next.current,
      pendingExecutionDelayS: next.pending,
      pendingExecutionDelayAt: next.pendingAt,
    };
  }
  const values = { ...grantMeta, ...delayValues };
  if (current === null) {
    await context.db.insert(schema.v2AccessRoleMember).values({
      id, roleId, roleName: roleName(roleId), account: accountKey,
      memberSince: newMember ? BigInt(event.args.since) : null,
      ...values,
    });
  } else {
    await context.db.update(schema.v2AccessRoleMember, { id }).set(values);
  }
});

ponder.on("AccessManager:RoleRevoked", async ({ event, context }) => {
  const roleId = BigInt(event.args.roleId);
  const account = lower(event.args.account);
  const id = memberId(roleId, account);
  const current = await context.db.find(schema.v2AccessRoleMember, { id });
  const values = {
    granted: false,
    executionDelayS: null,
    pendingExecutionDelayS: null,
    pendingExecutionDelayAt: null,
    revokedAt: event.block.timestamp,
    revokedBlock: event.block.number,
    revokedTx: event.transaction.hash,
  };
  if (current === null) {
    await context.db.insert(schema.v2AccessRoleMember).values({
      id, roleId, roleName: roleName(roleId), account, memberSince: null, ...values,
    });
  } else {
    await context.db.update(schema.v2AccessRoleMember, { id }).set(values);
  }
});

ponder.on("AccessManager:TargetClosed", async ({ event, context }) => {
  const target = lower(event.args.target);
  const current = await context.db.find(schema.v2AccessTarget, { target });
  const values = { targetName: targetName(target), closed: event.args.closed, ...eventMeta(event) };
  if (current === null) await context.db.insert(schema.v2AccessTarget).values({ target, ...values });
  else await context.db.update(schema.v2AccessTarget, { target }).set(values);
});

ponder.on("AccessManager:TargetAdminDelayUpdated", async ({ event, context }) => {
  const target = lower(event.args.target);
  const current = await context.db.find(schema.v2AccessTarget, { target });
  const next = delayedValue(
    current?.adminDelayS ?? 0n,
    current?.pendingAdminDelayS ?? null,
    current?.pendingAdminDelayAt ?? null,
    BigInt(event.args.delay), BigInt(event.args.since), event.block.timestamp,
  );
  const values = {
    targetName: targetName(target),
    adminDelayS: next.current ?? 0n,
    pendingAdminDelayS: next.pending,
    pendingAdminDelayAt: next.pendingAt,
    ...eventMeta(event),
  };
  if (current === null) await context.db.insert(schema.v2AccessTarget).values({ target, ...values });
  else await context.db.update(schema.v2AccessTarget, { target }).set(values);
});

ponder.on("AccessManager:TargetFunctionRoleUpdated", async ({ event, context }) => {
  const target = lower(event.args.target);
  const selector = lower(event.args.selector);
  const roleId = BigInt(event.args.roleId);
  const annotation = manifestFunction(target, selector);
  const values = {
    target, selector, ...annotation,
    roleId, roleName: roleName(roleId),
    changedAt: event.block.timestamp,
    changedBlock: event.block.number,
    changedLogIndex: event.log.logIndex,
    changedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2AccessTargetFunction)
    .values({ id: targetFunctionId(target, selector), ...values })
    .onConflictDoUpdate(values);
});
