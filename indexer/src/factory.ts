import schema from "ponder:schema";
import type { Address } from "viem";

import { accountFactoryAbi } from "../abis/accountFactory";
import { MARKET, MULTICALL3, START_BLOCK } from "../lib/env";
import { factoryAddress, getMarket, patchMarket } from "../lib/factoryIndexing";
import { factorySettings, marketWeekId, type FactoryPolicyTuple } from "../lib/factoryLifecycle";
import { log } from "../lib/log";
import { factoryPonder as ponder } from "../lib/registry";
import { ROLE_DEFAULT_ADMIN, roleName } from "../lib/roles";

/**
 * The factory's own events: accounts created and rekeyed, the week, the switches, the roles.
 *
 * LOG-ONLY. Nothing in a handler below makes an `eth_call`. The public RPC for chain 4663 has no
 * historical state (a historical `eth_call` answers "historical state ... is not available"), and
 * a per-market archive endpoint is not part of the Tier 1 rollout, so a handler that read the
 * chain would stall every backfill on the endpoint the market actually runs against. The one
 * exception is `Factory:setup`, below, which is best-effort and says so in the row.
 *
 * Registered through `factoryPonder`, which is the real registry only when FACTORY_ADDRESS is set
 * (lib/registry.ts explains why the registration itself has to be conditional).
 */

/*//////////////////////////////////////////////////////////////
                               SETUP
//////////////////////////////////////////////////////////////*/

/**
 * How long the setup read may take before the row is published unverified. Ponder retries a
 * failed `eth_call` nine times with exponential backoff (about two minutes), and the public RPC
 * fails every historical call, so without a deadline a factory-only deployment on that RPC would
 * sit two minutes per view before indexing its first block. The read keeps running in the
 * background after the deadline; its result is dropped and its rejection swallowed.
 */
const SETUP_READ_TIMEOUT_MS = 30_000;

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  const settled = p.then<T | null>((v) => v).catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One Multicall3 result, or null when the batch failed, timed out, or that one call reverted. */
const at = <T>(batch: readonly { status: string; result?: unknown }[] | null, i: number): T | null => {
  const r = batch?.[i];
  if (r === undefined || r.status !== "success") return null;
  return (r.result ?? null) as T | null;
};

/**
 * Seed the market row with what only views can say, once, before any event.
 *
 * Two batches, because they need different things from the RPC:
 *   - the immutables (`asset`, `priceFeed`, `clear`, `implementation`) are read with Ponder's
 *     `cache: "immutable"`, which reads at the latest block and caches forever. An immutable is
 *     the same at START_BLOCK and at the head by definition, so this is exact, and it works on
 *     the public RPC, which serves `eth_call` at the head.
 *   - the constructor-set settings (`policy`, `feeRecipient`, `depositCap`) are read pinned to
 *     START_BLOCK, as `Vault:setup` does, because they can change and the tape must start from
 *     what they were when the market opened. That needs an archive RPC. On one that has none the
 *     batch times out, the columns stay null, `settingsVerified` stays false, and the market row
 *     says so rather than publishing zeros. `FeeRecipientSet` and `DepositCapSet` still update
 *     their columns as they arrive; `PolicySet` carries nothing and only stamps `policySetAt`.
 */
ponder.on("Factory:setup", async ({ context }) => {
  const factory = factoryAddress();
  await getMarket(context.db);

  const call = (functionName: "asset" | "priceFeed" | "clear" | "implementation" | "policy" | "feeRecipient" | "depositCap") =>
    ({ abi: accountFactoryAbi, address: factory, functionName }) as const;

  const [immutables, settings] = await Promise.all([
    withDeadline(
      context.client.multicall({
        contracts: [call("asset"), call("priceFeed"), call("clear"), call("implementation")],
        allowFailure: true,
        multicallAddress: MULTICALL3,
        cache: "immutable",
      }),
      SETUP_READ_TIMEOUT_MS,
    ),
    withDeadline(
      context.client.multicall({
        contracts: [call("policy"), call("feeRecipient"), call("depositCap")],
        allowFailure: true,
        multicallAddress: MULTICALL3,
      }),
      SETUP_READ_TIMEOUT_MS,
    ),
  ]);

  const seeded = factorySettings({
    asset: at<Address>(immutables, 0),
    feed: at<Address>(immutables, 1),
    clear: at<Address>(immutables, 2),
    implementation: at<Address>(immutables, 3),
    policy: at<FactoryPolicyTuple>(settings, 0),
    feeRecipient: at<Address>(settings, 1),
    depositCap: at<bigint>(settings, 2),
  });

  const verified = settings !== null && at(settings, 0) !== null && at(settings, 1) !== null && at(settings, 2) !== null;
  if (!verified) {
    log.warn(
      { factory, market: MARKET, startBlock: START_BLOCK, read: Object.keys(seeded) },
      "factory settings unreadable at START_BLOCK (archive RPC needed); policy, fee recipient and cap stay " +
        "unverified until a governance event, and this read re-runs only on a redeploy (a new schema): " +
        "redeploy against an archive RPC to verify them",
    );
  }
  if (immutables === null) {
    log.warn({ factory, market: MARKET }, "factory immutables unreadable; asset and feed stay unverified");
  }

  await patchMarket(context.db, null, { ...seeded, settingsVerified: verified });
  log.info({ factory, market: MARKET, settingsVerified: verified, ...seeded }, "market row seeded");
});

/*//////////////////////////////////////////////////////////////
                             ACCOUNTS
//////////////////////////////////////////////////////////////*/

/**
 * `createAccount`: a new clone. This is also the event Ponder's factory source keys on, so from
 * this log onwards the clone's own events arrive at src/writerAccount.ts. One account per owner
 * (`AlreadyHasAccount`), so `index` is both the count and the account's expiry offset.
 */
ponder.on("Factory:AccountCreated", async ({ event, context }) => {
  const { owner, account, index } = event.args;

  await context.db
    .insert(schema.writerAccount)
    .values({
      id: account,
      factory: factoryAddress(),
      owner,
      index,
      createdAt: event.block.timestamp,
      createdBlock: event.block.number,
      createdTx: event.transaction.hash,
      lastActivityAt: event.block.timestamp,
      lastActivityBlock: event.block.number,
    })
    // A bare row can pre-exist only on a replay bounded inside a week (lib/factoryIndexing.ts
    // `getAccount`); this names its owner and index without disturbing what it accumulated.
    .onConflictDoUpdate({ owner, index, createdAt: event.block.timestamp, createdBlock: event.block.number, createdTx: event.transaction.hash });

  const m = await getMarket(context.db);
  await patchMarket(context.db, event, { accountCount: m.accountCount + 1 });

  log.info({ market: MARKET, owner, account, index, txHash: event.transaction.hash }, "account created");
});

/**
 * `transferOwnership` on a clone calls `factory.rekey`, which emits this BEFORE the clone's own
 * `OwnershipTransferred` in the same transaction. Both handlers set the same owner; either alone
 * is enough, and neither can disagree.
 */
ponder.on("Factory:AccountRekeyed", async ({ event, context }) => {
  const { from, to, account } = event.args;
  const existing = await context.db.find(schema.writerAccount, { id: account });
  if (existing === null) return;
  await context.db.update(schema.writerAccount, { id: account }).set({
    owner: to,
    lastActivityAt: event.block.timestamp,
    lastActivityBlock: event.block.number,
  });
  await patchMarket(context.db, event, {});
  log.info({ market: MARKET, account, from, to, txHash: event.transaction.hash }, "account rekeyed");
});

/*//////////////////////////////////////////////////////////////
                              THE WEEK
//////////////////////////////////////////////////////////////*/

/**
 * `setWeek`: the keeper's terms for the coming week. The factory numbers weeks itself (`id` is
 * its counter), so a row exists from here and never before. Accounts that `list` afterwards pin
 * THESE terms; a later `setWeek` starts a new row and does not move anything already listed.
 */
ponder.on("Factory:WeekSet", async ({ event, context }) => {
  const { id, strikeUsdg, exerciseTs, baseExpiryTs, askUsdg } = event.args;
  const factory = factoryAddress();
  const weekId = Number(id);

  await context.db
    .insert(schema.marketWeek)
    .values({
      id: marketWeekId(factory, weekId),
      factory,
      weekId,
      strikeUsdg,
      exerciseTs: BigInt(exerciseTs),
      baseExpiryTs: BigInt(baseExpiryTs),
      askUsdg,
      setAt: event.block.timestamp,
      setBlock: event.block.number,
      setTx: event.transaction.hash,
    })
    // The counter never repeats an id; the guard makes a replayed event idempotent.
    .onConflictDoNothing();

  await patchMarket(context.db, event, {
    weekId,
    strikeUsdg,
    exerciseTs: BigInt(exerciseTs),
    baseExpiryTs: BigInt(baseExpiryTs),
    askUsdg,
    weekSetAt: event.block.timestamp,
  });

  // The week's opening line in the tape: the terms every listing this week will carry.
  log.info(
    { market: MARKET, weekId, strikeUsdg, exerciseTs, baseExpiryTs, askUsdg, txHash: event.transaction.hash },
    "week set",
  );
});

/*//////////////////////////////////////////////////////////////
                             GOVERNANCE
//////////////////////////////////////////////////////////////*/

/** The guardian's switch: `list` and every fill's `authorizeOrder` revert `WritesAreHalted` while it is on. */
ponder.on("Factory:WritesHalted", async ({ event, context }) => {
  const { halted } = event.args;
  await patchMarket(context.db, event, { writesHalted: halted });
  // WRITES_HALTED from ops/alerts.md: nothing lists and nothing fills until it lifts.
  log.warn({ market: MARKET, halted, txHash: event.transaction.hash }, halted ? "writes halted" : "writes resumed");
});

/**
 * `setPolicy` emits an EMPTY event. The values are in storage only, and this handler cannot read
 * them (log-only, see the file header), so it records that the policy moved and leaves the six
 * columns as the setup read seeded them. The API publishes `policySetAt` beside them so a reader
 * can tell "verified at setup" from "changed since".
 */
ponder.on("Factory:PolicySet", async ({ event, context }) => {
  await patchMarket(context.db, event, { policySetAt: event.block.timestamp });
  log.warn({ market: MARKET, txHash: event.transaction.hash }, "policy changed; the event carries no values, read policy() to learn them");
});

ponder.on("Factory:FeeRecipientSet", async ({ event, context }) => {
  await patchMarket(context.db, event, { feeRecipient: event.args.recipient });
  log.warn({ market: MARKET, recipient: event.args.recipient, txHash: event.transaction.hash }, "fee recipient changed");
});

ponder.on("Factory:DepositCapSet", async ({ event, context }) => {
  await patchMarket(context.db, event, { depositCap: event.args.cap });
  log.info({ market: MARKET, cap: event.args.cap, txHash: event.transaction.hash }, "deposit cap changed");
});

/*//////////////////////////////////////////////////////////////
                               ROLES
//////////////////////////////////////////////////////////////*/

/**
 * Same three roles as the vault (lib/roles.ts): the admin sets policy, fee recipient and cap;
 * the keeper sets the week and lists for owners; the guardian halts. The constructor's
 * `_grantRole(DEFAULT_ADMIN_ROLE, admin_)` is the first event of the deploy transaction, so
 * `market.admin` is exact from the first block indexed.
 */
ponder.on("Factory:RoleGranted", async ({ event, context }) => {
  const { role, account, sender } = event.args;
  // Lowercased like the vault's role_member ids (src/vault.ts), so the same `${role}-${account}`
  // lookup convention works on both tables.
  const id = `${role}-${account.toLowerCase()}`;

  await context.db
    .insert(schema.marketRole)
    .values({
      id,
      factory: factoryAddress(),
      role,
      roleName: roleName(role),
      account,
      granted: true,
      grantedAt: event.block.timestamp,
      grantedTx: event.transaction.hash,
    })
    .onConflictDoUpdate({ granted: true, grantedAt: event.block.timestamp, grantedTx: event.transaction.hash, revokedAt: null, revokedTx: null });

  const isAdmin = role.toLowerCase() === ROLE_DEFAULT_ADMIN;
  await patchMarket(context.db, event, isAdmin ? { admin: account } : {});

  // ROLE_CHANGE from ops/alerts.md: a grant to an address nobody recognises is the first sign of trouble.
  log.warn({ market: MARKET, role: roleName(role), account, sender, txHash: event.transaction.hash }, "role granted");
});

ponder.on("Factory:RoleRevoked", async ({ event, context }) => {
  const { role, account, sender } = event.args;
  const id = `${role}-${account.toLowerCase()}`;

  const existing = await context.db.find(schema.marketRole, { id });
  if (existing !== null) {
    await context.db.update(schema.marketRole, { id }).set({
      granted: false,
      revokedAt: event.block.timestamp,
      revokedTx: event.transaction.hash,
    });
  }

  const m = await getMarket(context.db);
  const wasAdmin = role.toLowerCase() === ROLE_DEFAULT_ADMIN && m.admin !== null && m.admin.toLowerCase() === account.toLowerCase();
  await patchMarket(context.db, event, wasAdmin ? { admin: null } : {});

  log.warn({ market: MARKET, role: roleName(role), account, sender, txHash: event.transaction.hash }, "role revoked");
});
