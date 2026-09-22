/**
 * The Earn VAULT and the StockZap: the P8 lending periphery's indexing plane.
 *
 * NAMING, READ THIS FIRST. "Earn" is already this product's word for the covered-call WRITING
 * surface — web/app/earn/page.tsx, web/components/v2/EarnMarket.tsx, web/lib/v2/earnTx.ts are all
 * about writing calls against stock you hold. THIS FILE IS THE LENDING VAULT: you supply a Stock
 * Token or USDG, you receive shares, the vault rests orders and parks the rest in a venue adapter
 * (v8-plan/tasks/P-periphery.md:19-30). The two are different products that share a word. The
 * route name `/v2/earn` for the lending vault is pinned by v8-plan/03-INTERFACES.md:220 and is not
 * renamed here, so everything else is prefixed instead: v2EarnVault* tables, V2_EARN_VAULT,
 * v2EarnVaultPonder.
 *
 * WHY THERE ARE NO `.on` REGISTRATIONS IN THIS FILE YET.
 *
 * Ponder derives the valid event names of `ponder.on` from ponder.config.ts, which needs an `abi:`
 * for every source, which comes from abis/v2/*.ts, which scripts/gen-abis.mjs renders from
 * ops/abis/v2/*.json. At this commit neither artefact exists in ops/abis/v2:
 *
 *   - EarnVault.json  — the contract itself is unwritten (P8-02 is in flight). Its event names and
 *                       argument shapes are therefore unknown, and guessing them would produce
 *                       handlers that decode nothing and tests that prove they decode nothing.
 *   - IStockZap.json  — the contract IS landed (callhouse-contracts src/v2/periphery/StockZap.sol)
 *                       but P8-01 deliberately did not add it to script/v2/abi-manifest.txt, and
 *                       export-abis.sh copies only what the manifest names. That is T-78.
 *
 * X8-06 LANDED. This file used to carry its registrations as PROSE, because registering a handler
 * for a contract ponder.config.ts does not have breaks the virtual `ponder:registry` types for every
 * handler file in the package, and the generated ABI modules did not exist. They exist now
 * (abis/v2/earnVault.ts, abis/v2/stockZap.ts, both emitted by scripts/gen-abis.mjs from
 * ops/abis/v2/EarnVault.json and StockZap.json), and ponder.config.ts now declares an EarnVault and
 * a StockZap source gated on V2_EARN_VAULT and V2_ZAP_HELPER. So the registrations below are the
 * prose turned back into code.
 *
 * THE EVENT NAMES ARE READ OFF THE GENERATED ABI, NOT OFF THE PLAN. The plan wrote them as
 * placeholders - deposit, withdraw, queued, fulfilled, skim, adapter move, config - on purpose. The
 * contract's actual events are Deposited, DepositQueued, DepositServed, DepositCancelled, Redeemed,
 * WithdrawalQueued, WithdrawalServed, WithdrawalCancelled, Skimmed, SweptToVenue, PulledFromVenue,
 * AdapterSet, SkimBpsSet and FundingEnabledSet; the two adapter moves are SweptToVenue and PulledFromVenue, and the single
 * "config" placeholder is three separate setters.
 *
 * DEPOSIT QUEUE (T-184 / T-421). A deposit that arrives while the vault is not at its flat boundary
 * emits DepositQueued and later DepositServed or DepositCancelled; it NEVER emits Deposited. The
 * queue handlers below preserve the owner and receiver separately, and only DepositServed creates a
 * completed v2EarnVaultDeposit row. On both paths `account` is the asset owner (Deposited.caller,
 * DepositQueued.owner) and `receiver` holds the shares; before T-421 an immediate row stored the
 * receiver as `account`. Deposit and withdrawal requests share one FIFO id space in EarnVault
 * (`_requests`, `_tail`), so a `${vault}-${id}` key names at most one row across the two queue
 * tables. Share supply remains folded from Transfer, not these events.
 *
 * THE ASSET IS READ, NOT ASSUMED. Deposited and Redeemed carry no asset - the vault has exactly one,
 * fixed at construction - but the rows are asset-keyed. It is read once per vault from asset() and
 * cached on v2EarnVaultState, the same shape src/v2/houseVault.ts uses for epochEnd() on
 * VaultCreated. A failed read rejects the handler so Ponder retries the same log; completing the
 * handler without its event row would permanently turn a transient RPC fault into missing history.
 *
 * YIELD. Nothing in this file derives a rate, a projection, or any figure scaled to a period the
 * chain did not report, and no view that exposes the venue's rate is read. A skim is base units
 * and a block; that is the whole of it.
 */
import schema from "ponder:schema";
import type { Address, Hex } from "viem";

import { earnVaultAbi } from "../../abis/v2/earnVault";
import { v2EarnVaultPonder, v2ZapPonder } from "../../lib/registry";

/** Just the parts of the Ponder context these handlers use. */
type EarnContext = { db: any; client: { readContract: (args: any) => Promise<unknown> } };

/** One queue row per (vault, request id): the contract's ids restart per deployment. */
const queueRowId = (vault: string, id: bigint) => `${vault}-${id}`;

/** Lower-cased for the same reason src/v2/treasury.ts does it: addresses are compared as text. */
const lower = <T extends string>(value: T): T => value.toLowerCase() as T;
const ZERO = "0x0000000000000000000000000000000000000000";

/** One log's provenance, identical in shape to src/v2/treasury.ts:13-26. */
export function meta(event: {
  block: { timestamp: bigint; number: bigint };
  log: { logIndex: number; address: Address };
  transaction: { hash: Hex };
}) {
  return {
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    sourceAddress: lower(event.log.address),
    ts: event.block.timestamp,
    block: event.block.number,
    logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  };
}

/**
 * The two StockZap events, as the contract declares them. Mirrored from callhouse-contracts
 * src/v2/interfaces/IStockZap.sol (worktree wt/v8-contracts at b2bf1dbc); the signatures and their
 * topic0s are pinned in v8-plan/status/INTERFACE-CHANGES-V8.md Entry 4:
 *
 *   WriteZapped(address,address,address,uint256,uint256,uint8)
 *     0x1ae8864a999d8eea7c577cc18ede6b54ec495033e500d35c7d0bf7983d8f5b8b
 *   ExitZapped(address,address,address,uint256,uint256,uint8)
 *     0x23fdd2820484cbab406be2291fedb6a8a27d14e277812685619e9bbfad0620a1
 *
 * The in/out pair is named per direction on the contract (usdgIn/assetOut, assetIn/usdgOut) and is
 * stored direction-agnostically as amountIn/amountOut, with `kind` saying which way round it is.
 */
export interface ZapEventArgs {
  account: Address;
  asset: Address;
  caller: Address;
  venue: number;
}

export type ZapKind = "write" | "exit";

export interface WriteZappedArgs extends ZapEventArgs {
  usdgIn: bigint;
  assetOut: bigint;
}

export interface ExitZappedArgs extends ZapEventArgs {
  assetIn: bigint;
  usdgOut: bigint;
}

type ZapEvent = Parameters<typeof meta>[0] & { args: WriteZappedArgs | ExitZappedArgs };

/**
 * One v2ZapAction row. `zap` is the emitting contract rather than a configured constant, so a
 * second zap deployment indexed alongside the first stays distinguishable.
 */
export function zapActionRow(kind: ZapKind, event: ZapEvent) {
  const { sourceAddress, ...provenance } = meta(event);
  const args = event.args;
  const [amountIn, amountOut] =
    kind === "write"
      ? [(args as WriteZappedArgs).usdgIn, (args as WriteZappedArgs).assetOut]
      : [(args as ExitZappedArgs).assetIn, (args as ExitZappedArgs).usdgOut];
  return {
    ...provenance,
    zap: sourceAddress,
    kind,
    account: lower(args.account),
    asset: lower(args.asset),
    caller: lower(args.caller),
    amountIn,
    amountOut,
    venue: args.venue,
  };
}

/*//////////////////////////////////////////////////////////////
                          REGISTRATIONS
//////////////////////////////////////////////////////////////*/

/**
 * The vault's asset, read once and cached on the state row. A failed read rejects the current
 * handler transaction: advancing past an asset-keyed event without its row is not recoverable from
 * a later event, while Ponder can retry a rejected handler after the RPC recovers.
 */
/**
 * The declared return was `string`, which threw away the 0x template both branches actually produce:
 * `v2EarnVaultState.asset` is `t.hex()` (null-guarded on the line below) and the readContract branch
 * is an `Address` that {lower} preserves. Every caller writes the result into a `t.hex()` column, so
 * the signature was the wrong one, not the values.
 */
async function earnAsset(context: EarnContext, vault: string, m: ReturnType<typeof meta>): Promise<Address> {
  const row = await context.db.find(schema.v2EarnVaultState, { vault });
  if (row?.asset != null) return row.asset;
  const asset = lower(
    (await context.client.readContract({
      abi: earnVaultAbi,
      address: vault as Address,
      functionName: "asset",
    })) as Address,
  );
  await upsertState(context, vault, m, { asset });
  return asset;
}

/** One state upsert, so every config event writes the same provenance columns. */
async function upsertState(
  context: EarnContext,
  vault: string,
  m: ReturnType<typeof meta>,
  values: Record<string, unknown>,
) {
  const touched = {
    updatedAt: m.ts,
    updatedBlock: m.block,
    updatedLogIndex: m.logIndex,
    updatedTx: m.tx,
  };
  await context.db
    .insert(schema.v2EarnVaultState)
    .values({ vault, asset: null, adapter: null, skimBps: null, paused: null, sharesSupply: null, ...values, ...touched })
    .onConflictDoUpdate({ ...values, ...touched });
}

v2EarnVaultPonder.on("EarnVault:Deposited", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const asset = await earnAsset(context, vault, m);
  await context.db.insert(schema.v2EarnVaultDeposit).values({
    id: m.id,
    vault,
    account: lower(event.args.caller),
    receiver: lower(event.args.receiver),
    asset,
    assets: event.args.assets,
    shares: event.args.shares,
    queueId: null,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

v2EarnVaultPonder.on("EarnVault:DepositQueued", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const asset = await earnAsset(context, vault, m);
  await context.db.insert(schema.v2EarnVaultDepositQueue).values({
    id: queueRowId(vault, event.args.id),
    vault,
    account: lower(event.args.owner),
    receiver: lower(event.args.receiver),
    asset,
    status: "queued",
    assetsQueued: event.args.assets,
    requestedAt: m.ts,
    requestedBlock: m.block,
    requestedLogIndex: m.logIndex,
    requestedTx: m.tx,
    mintedShares: null,
    fulfilledAt: null,
    fulfilledBlock: null,
    fulfilledLogIndex: null,
    fulfilledTx: null,
  });
});

/** DepositServed omits the owner, so the completed fact must recover it from DepositQueued. */
v2EarnVaultPonder.on("EarnVault:DepositServed", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const id = queueRowId(vault, event.args.id);
  const row = await context.db.find(schema.v2EarnVaultDepositQueue, { id });
  if (row === null) return;
  const receiver = lower(event.args.receiver);
  await context.db.update(schema.v2EarnVaultDepositQueue, { id }).set({
    status: "fulfilled",
    receiver,
    mintedShares: event.args.shares,
    fulfilledAt: m.ts,
    fulfilledBlock: m.block,
    fulfilledLogIndex: m.logIndex,
    fulfilledTx: m.tx,
  });
  await context.db.insert(schema.v2EarnVaultDeposit).values({
    id: m.id,
    vault,
    account: row.account,
    receiver,
    asset: row.asset,
    assets: event.args.assets,
    shares: event.args.shares,
    queueId: id,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

/** A cancelled request remains visible but never becomes a completed deposit. */
v2EarnVaultPonder.on("EarnVault:DepositCancelled", async ({ event, context }) => {
  const m = meta(event);
  const id = queueRowId(m.sourceAddress, event.args.id);
  const row = await context.db.find(schema.v2EarnVaultDepositQueue, { id });
  if (row === null) return;
  await context.db.update(schema.v2EarnVaultDepositQueue, { id }).set({
    status: "cancelled",
    fulfilledAt: m.ts,
    fulfilledBlock: m.block,
    fulfilledLogIndex: m.logIndex,
    fulfilledTx: m.tx,
  });
});

/**
 * A redemption that settles a queued request carries that request's id; one served immediately does
 * not. `queueId` null therefore means SERVED IMMEDIATELY AND NEVER QUEUED, which is the distinction
 * the column's own comment draws - it is not a missing value.
 */
v2EarnVaultPonder.on("EarnVault:Redeemed", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const asset = await earnAsset(context, vault, m);
  await context.db.insert(schema.v2EarnVaultWithdrawal).values({
    id: m.id,
    vault,
    account: lower(event.args.owner),
    asset,
    assets: event.args.assets,
    shares: event.args.shares,
    queueId: null,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

v2EarnVaultPonder.on("EarnVault:WithdrawalQueued", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const asset = await earnAsset(context, vault, m);
  await context.db.insert(schema.v2EarnVaultWithdrawalQueue).values({
    id: queueRowId(vault, event.args.id),
    vault,
    account: lower(event.args.owner),
    asset,
    status: "queued",
    sharesQueued: event.args.shares,
    // The event quotes a shortfall, not an amount the request asked for; the request names shares.
    assetsRequested: null,
    requestedAt: m.ts,
    requestedBlock: m.block,
    requestedLogIndex: m.logIndex,
    requestedTx: m.tx,
    fulfilledAssets: null,
    fulfilledAt: null,
    fulfilledBlock: null,
    fulfilledLogIndex: null,
    fulfilledTx: null,
  });
});

/**
 * `complete` false is a PARTIAL service: the request stays queued and may be served again, so the
 * row keeps its `queued` status and records what this instalment paid. Marking it fulfilled on the
 * first instalment would close a request the contract has not finished with.
 */
v2EarnVaultPonder.on("EarnVault:WithdrawalServed", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const id = queueRowId(vault, event.args.id);
  const row = await context.db.find(schema.v2EarnVaultWithdrawalQueue, { id });
  if (row === null) return;
  const paid = (row.fulfilledAssets ?? 0n) + event.args.assets;
  await context.db.update(schema.v2EarnVaultWithdrawalQueue, { id }).set({
    status: event.args.complete ? "fulfilled" : "queued",
    fulfilledAssets: paid,
    fulfilledAt: m.ts,
    fulfilledBlock: m.block,
    fulfilledLogIndex: m.logIndex,
    fulfilledTx: m.tx,
  });
  await context.db.insert(schema.v2EarnVaultWithdrawal).values({
    id: m.id,
    vault,
    account: row.account,
    asset: row.asset,
    assets: event.args.assets,
    shares: event.args.shares,
    queueId: id,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

/** Cancelled keeps fulfilledAssets NULL: nothing was paid, which is not the same as paying zero. */
v2EarnVaultPonder.on("EarnVault:WithdrawalCancelled", async ({ event, context }) => {
  const m = meta(event);
  const id = queueRowId(m.sourceAddress, event.args.id);
  const row = await context.db.find(schema.v2EarnVaultWithdrawalQueue, { id });
  if (row === null) return;
  await context.db.update(schema.v2EarnVaultWithdrawalQueue, { id }).set({
    status: "cancelled",
    fulfilledAt: m.ts,
    fulfilledBlock: m.block,
    fulfilledLogIndex: m.logIndex,
    fulfilledTx: m.tx,
  });
});

/**
 * The skim row is base units and a block, and deliberately nothing else. `gain` is what the venue
 * produced and `fee` is what left the vault; the row stores the FEE, because that is the amount
 * that actually moved. highWaterMark is not stored: it is a contract-side accounting cursor, not an
 * observation about this log.
 */
v2EarnVaultPonder.on("EarnVault:Skimmed", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const asset = await earnAsset(context, vault, m);
  await context.db.insert(schema.v2EarnVaultSkim).values({
    id: m.id,
    vault,
    asset,
    amount: event.args.fee,
    recipient: null,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

/** Out to the venue. `deposited` is what the venue took, which can be less than `offered`. */
v2EarnVaultPonder.on("EarnVault:SweptToVenue", async ({ event, context }) => {
  await adapterMove(context, meta(event), "out", event.args.offered, event.args.deposited);
});

/** Back from the venue. `withdrawn` can be less than `requested` when the venue is illiquid. */
v2EarnVaultPonder.on("EarnVault:PulledFromVenue", async ({ event, context }) => {
  await adapterMove(context, meta(event), "in", event.args.requested, event.args.withdrawn);
});

async function adapterMove(
  context: EarnContext,
  m: ReturnType<typeof meta>,
  direction: "in" | "out",
  requested: bigint,
  delivered: bigint,
) {
  const vault = m.sourceAddress;
  const asset = await earnAsset(context, vault, m);
  const state = await context.db.find(schema.v2EarnVaultState, { vault });
  await context.db.insert(schema.v2EarnVaultAdapterMove).values({
    id: m.id,
    vault,
    adapter: state?.adapter ?? null,
    asset,
    direction,
    requested,
    delivered,
    // A move that delivered less than it asked for still SUCCEEDED; the venue simply gave less.
    // Failure would be a revert, which produces no log at all.
    succeeded: true,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
}

v2EarnVaultPonder.on("EarnVault:AdapterSet", async ({ event, context }) => {
  const m = meta(event);
  await upsertState(context, m.sourceAddress, m, { adapter: lower(event.args.adapter) });
});

v2EarnVaultPonder.on("EarnVault:SkimBpsSet", async ({ event, context }) => {
  const m = meta(event);
  await upsertState(context, m.sourceAddress, m, { skimBps: Number(event.args.bps) });
});

/** `paused` is the inverse of funding being enabled: on means running, so paused is !on. */
v2EarnVaultPonder.on("EarnVault:FundingEnabledSet", async ({ event, context }) => {
  const m = meta(event);
  await upsertState(context, m.sourceAddress, m, { paused: !event.args.on });
});

/** ERC20 transfers between holders do not change supply; only mint/burn logs do. */
v2EarnVaultPonder.on("EarnVault:Transfer", async ({ event, context }) => {
  const fromZero = lower(event.args.from) === ZERO;
  const toZero = lower(event.args.to) === ZERO;
  if (!fromZero && !toZero) return;
  if (fromZero && toZero) throw new Error("EarnVault share supply: zero-to-zero transfer");
  const m = meta(event);
  const previous = await context.db.find(schema.v2EarnVaultState, { vault: m.sourceAddress });
  if (toZero && previous?.sharesSupply == null) {
    throw new Error("EarnVault share supply: burn before observed mint");
  }
  const next = (previous?.sharesSupply ?? 0n) + (fromZero ? event.args.value : -event.args.value);
  if (next < 0n) throw new Error("EarnVault share supply: burn exceeds observed supply");
  await upsertState(context, m.sourceAddress, m, { sharesSupply: next });
});

v2ZapPonder.on("StockZap:WriteZapped", async ({ event, context }) => {
  await context.db.insert(schema.v2ZapAction).values(zapActionRow("write", event));
});

v2ZapPonder.on("StockZap:ExitZapped", async ({ event, context }) => {
  await context.db.insert(schema.v2ZapAction).values(zapActionRow("exit", event));
});
