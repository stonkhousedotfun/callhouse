import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, desc, eq, inArray, isNotNull, lt, lte, or, sql } from "ponder";
import { getAddress, isAddress, type Address } from "viem";

import { erc20Abi } from "../../../abis/erc20";
import { clearinghouseAbi } from "../../../abis/v2/clearinghouse";
import { earnVaultAbi } from "../../../abis/v2/earnVault";
import { CHAIN_NAME, LIVE_READ_TIMEOUT_MS, V2_CLEARINGHOUSE, V2_EARN_VAULT } from "../../../lib/env";
import { earnVenueAdapterReadAbi } from "../../v2/earnSample";
import {
  DAY_S, earnEarliestWithdrawal, realisedSamplePrice, revertErrorName, trailingApy, unescrowed, venueLiquidity, type Apy,
  type PriceSample,
} from "../../v2/earnYield";
import { address } from "./shared";

/**
 * This route used to select the whole deposit, skim and adapter-move tables with no
 * WHERE and no LIMIT and aggregate them in JavaScript, on an unauthenticated GET. Every figure is now
 * reduced in SQL to one row per vault, so the rows shipped to this process no longer grow with
 * protocol history.
 *
 * NOT a LIMIT. A limit with no WHERE would aggregate only the newest rows and serve them as the whole
 * history: a fast wrong answer instead of a slow right one.
 *
 * WHAT THIS DOES NOT FIX: `sum` still reads every row of its vault inside Postgres, so the query is
 * O(history) there, just no longer O(history) in bytes and JS work. The O(1) form is a running total
 * kept on v2EarnVaultState by the ingest, which is a ponder.schema.ts change outside this route.
 *
 * Vault and account keys are compared through lower(): rows are not guaranteed to share a case (the
 * JS version this replaces lowercased both sides for the same reason).
 */
const lowerKey = (column: unknown) => sql<string>`lower(${column})`;

/** The most venue write-offs /v2/earn sends per vault, newest first (schema.ts `venueWriteOffs`). */
export const EARN_WRITE_OFFS_SENT = 20;

/**
 * The DISPLAY figure for a lending-vault share while the vault may hold an
 * option position. `convertToShares` / `convertToAssets` REVERT `PositionOpen()` while `hasOpenPosition()`
 * so nothing here reads them: the vault exposes `indicativeAssetsPerShare()` and
 * `indicativeTotalAssets()` -- a conservative MARK (locked collateral less the option's intrinsic value at
 * the oracle spot, floored at zero), never a price anyone is paid -- and this route forwards it as-is.
 *
 * Null rule (api-schema.ts:535): null is "not read", "0" is an observed zero. One multicall per request,
 * `allowFailure: true`, bounded by LIVE_READ_TIMEOUT_MS exactly as `readSpots` in ./chain.ts is: a revert,
 * an RPC failure, a missing client (tests) or a vault deployed before the view existed each yield null
 * for that field, never a throw and never a fabricated figure. The two figures and the boolean are read
 * in the same call so they describe the same block.
 */
export type EarnLive = {
  indicativeAssetsPerShare: string | null;
  indicativeTotalAssets: string | null;
  hasOpenPosition: boolean | null;
  /**
   * `fundingEnabled()`, the JIT book-funding switch. Read live because the deploy never emits
   * FundingEnabledSet: an indexed-only value is null at launch while the contract's is false.
   */
  fundingEnabled: boolean | null;
};

const NO_LIVE: EarnLive = { indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: null, fundingEnabled: null };
const LIVE_LEGS = 4;

async function bounded<T>(promise: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LIVE_READ_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readEarnLive(vaults: Address[]): Promise<Map<string, EarnLive>> {
  const result = new Map<string, EarnLive>(vaults.map((vault) => [vault.toLowerCase(), NO_LIVE]));
  if (vaults.length === 0) return result;
  const client = (publicClients as Record<string, { multicall: (args: unknown) => Promise<unknown> } | undefined>)[CHAIN_NAME];
  if (client === undefined) return result;
  const rows = await bounded(client.multicall({ contracts: vaults.flatMap((vault) => [
    { abi: earnVaultAbi, address: vault, functionName: "indicativeAssetsPerShare" as const },
    { abi: earnVaultAbi, address: vault, functionName: "indicativeTotalAssets" as const },
    { abi: earnVaultAbi, address: vault, functionName: "hasOpenPosition" as const },
    { abi: earnVaultAbi, address: vault, functionName: "fundingEnabled" as const },
  ]), allowFailure: true }) as Promise<ReadonlyArray<{ status: string; result?: unknown }>>);
  if (rows === null) return result;
  vaults.forEach((vault, index) => {
    const perShare = rows[index * LIVE_LEGS];
    const total = rows[index * LIVE_LEGS + 1];
    const open = rows[index * LIVE_LEGS + 2];
    const funding = rows[index * LIVE_LEGS + 3];
    result.set(vault.toLowerCase(), {
      indicativeAssetsPerShare: perShare?.status === "success" && typeof perShare.result === "bigint"
        ? perShare.result.toString() : null,
      indicativeTotalAssets: total?.status === "success" && typeof total.result === "bigint"
        ? total.result.toString() : null,
      hasOpenPosition: open?.status === "success" && typeof open.result === "boolean" ? open.result : null,
      fundingEnabled: funding?.status === "success" && typeof funding.result === "boolean" ? funding.result : null,
    });
  });
  return result;
}

/**
 * The live reads "earliest withdrawal" and the venue figures need, in ONE further multicall per request
 * (same `allowFailure`, same LIVE_READ_TIMEOUT_MS bound as {readEarnLive}; kept separate so the indicative-mark
 * call stays exactly the three views pinned). Every field is null when its leg fails.
 *   vault    queue() (head <= tail is `_queueOpen`), escrowedAssets(), deferredAssets(), totalAssets();
 *   asset    balanceOf(vault), which with escrowedAssets() and deferredAssets() gives `_unescrowed`;
 *   ledger   Clearinghouse.free(vault, asset), which `_raise` pulls before the venue. The Clearinghouse is
 *            this indexer's V2_CLEARINGHOUSE, the one the production boot checks against the baked registry;
 *            with it unset the leg is not read and the ledger term stays null;
 *   adapter  withdrawable(), totalAssets() (the vault's position), maxIsAdvisory(), venue().
 *   probe    vault convertToAssets(1), read ONLY for why it fails: reverting VenueUnreadable means
 *            the venue cannot be read and nothing is priced (`venueUnreadable` true); an answer is false; any other
 *            failure (PositionOpen included, which the position flag already covers) leaves it null.
 * The price itself is NOT READ from convertToShares / convertToAssets, which revert PositionOpen.
 */
export type EarnLiquidity = {
  queueOpen: boolean | null;
  escrowed: bigint | null;
  deferred: bigint | null;
  balance: bigint | null;
  ledger: bigint | null;
  totalAssets: bigint | null;
  advisory: boolean | null;
  withdrawable: bigint | null;
  position: bigint | null;
  venue: string | null;
  venueUnreadable: boolean | null;
};

const NO_LIQUIDITY: EarnLiquidity = {
  queueOpen: null, escrowed: null, deferred: null, balance: null, ledger: null, totalAssets: null,
  advisory: null, withdrawable: null, position: null, venue: null, venueUnreadable: null,
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A non-zero adapter, or null: the zero address is a real "detached" value and `_raise` then has no venue. */
function attachedAdapter(adapter: string | null): Address | null {
  return adapter === null || adapter.toLowerCase() === ZERO_ADDRESS ? null : getAddress(adapter);
}

export async function readEarnLiquidity(
  vaults: Array<{ vault: Address; asset: Address | null; adapter: Address | null }>,
): Promise<Map<string, EarnLiquidity>> {
  const result = new Map<string, EarnLiquidity>(vaults.map((row) => [row.vault.toLowerCase(), NO_LIQUIDITY]));
  if (vaults.length === 0) return result;
  const client = (publicClients as Record<string, { multicall: (args: unknown) => Promise<unknown> } | undefined>)[CHAIN_NAME];
  if (client === undefined) return result;

  type Field = keyof EarnLiquidity;
  const legs: Array<{ key: string; field: Field; contract: Record<string, unknown> }> = [];
  for (const row of vaults) {
    const key = row.vault.toLowerCase();
    const vaultCall = (functionName: string) => ({ abi: earnVaultAbi, address: row.vault, functionName });
    legs.push({ key, field: "queueOpen", contract: vaultCall("queue") });
    legs.push({ key, field: "escrowed", contract: vaultCall("escrowedAssets") });
    legs.push({ key, field: "deferred", contract: vaultCall("deferredAssets") });
    legs.push({ key, field: "totalAssets", contract: vaultCall("totalAssets") });
    legs.push({ key, field: "venueUnreadable",
      contract: { abi: earnVaultAbi, address: row.vault, functionName: "convertToAssets", args: [1n] } });
    if (row.asset !== null) {
      legs.push({ key, field: "balance",
        contract: { abi: erc20Abi, address: row.asset, functionName: "balanceOf", args: [row.vault] } });
      if (V2_CLEARINGHOUSE !== undefined) {
        legs.push({ key, field: "ledger",
          contract: { abi: clearinghouseAbi, address: V2_CLEARINGHOUSE, functionName: "free", args: [row.vault, row.asset] } });
      }
    }
    if (row.adapter !== null) {
      const adapterCall = (functionName: string) => ({ abi: earnVenueAdapterReadAbi, address: row.adapter, functionName });
      legs.push({ key, field: "withdrawable", contract: adapterCall("withdrawable") });
      legs.push({ key, field: "position", contract: adapterCall("totalAssets") });
      legs.push({ key, field: "advisory", contract: adapterCall("maxIsAdvisory") });
      legs.push({ key, field: "venue", contract: adapterCall("venue") });
    }
  }

  const rows = await bounded(client.multicall({ contracts: legs.map((leg) => leg.contract), allowFailure: true }) as
    Promise<ReadonlyArray<{ status: string; result?: unknown; error?: unknown }>>);
  if (rows === null) return result;
  const out = new Map<string, EarnLiquidity>(vaults.map((row) => [row.vault.toLowerCase(), { ...NO_LIQUIDITY }]));
  legs.forEach((leg, index) => {
    const row = rows[index];
    const target = out.get(leg.key)!;
    if (leg.field === "venueUnreadable") {
      if (row?.status === "success") target.venueUnreadable = false;
      else if (revertErrorName(row?.error) === "VenueUnreadable") target.venueUnreadable = true;
      return;
    }
    if (row?.status !== "success") return;
    const value = row.result;
    switch (leg.field) {
      case "queueOpen":
        // queue() returns (head, tail); `_queueOpen` is head <= tail (EarnVault.sol:1229-1231).
        if (Array.isArray(value) && typeof value[0] === "bigint" && typeof value[1] === "bigint") {
          target.queueOpen = value[0] <= value[1];
        }
        return;
      case "advisory":
        if (typeof value === "boolean") target.advisory = value;
        return;
      case "venue":
        if (typeof value === "string" && isAddress(value)) target.venue = getAddress(value);
        return;
      default:
        if (typeof value === "bigint") (target as Record<string, unknown>)[leg.field] = value;
    }
  });
  return out;
}

/**
 * The latest expiry among the positions the vault still holds -- its own long or short balances and the
 * longs it has escrowed in an AskResale -- which is the earliest `processQueue` can serve anything
 * (`_positionOpen`). Null when nothing held is indexed. A settled series the vault has not
 * yet redeemed still counts: its balance is still there, so the boundary is still shut.
 * An AskResale holds its escrow "live or expired and unpruned" (EarnVault `_resaleEscrowOpen` /
 * `_holdsEscrow`: not cancelled and not fully filled, no time test), so a V2Clock-`expired` order counts as well as an
 * `open` one. `pruned`, `cancelled` and `filled` hold nothing.
 */
async function openPositionExpiry(vault: string): Promise<number | null> {
  const expiry = sql<string | null>`max(${schema.v2Series.expiry})::text`;
  const [[held], [resale]] = await Promise.all([
    db.select({ expiry }).from(schema.v2Balance)
      .innerJoin(schema.v2Series, eq(schema.v2Balance.longId, schema.v2Series.longId))
      .where(and(sql`${lowerKey(schema.v2Balance.holder)} = ${vault}`, sql`${schema.v2Balance.units} > 0`)),
    db.select({ expiry }).from(schema.v2Order)
      .innerJoin(schema.v2Series, eq(schema.v2Order.longId, schema.v2Series.longId))
      .where(and(sql`${lowerKey(schema.v2Order.maker)} = ${vault}`, eq(schema.v2Order.kind, "AskResale"),
        inArray(schema.v2Order.status, ["open", "expired"]))),
  ]);
  const values = [held?.expiry, resale?.expiry].filter((v): v is string => typeof v === "string").map(Number);
  return values.length === 0 ? null : Math.max(...values);
}

/**
 * The contract queue id at the end of a queue row id (`${vault}-${id}`, indexer/src/v2/earn.ts
 * `queueRowId`), canonical. Null when the row id does not end in one -- the ingest never writes such a row, and the
 * wire then offers no cancel rather than a guessed id.
 */
export function queueIdOf(rowId: string): string | null {
  const match = /-(\d+)$/.exec(rowId);
  return match === null ? null : BigInt(match[1]!).toString();
}

type QueueTable = typeof schema.v2EarnVaultWithdrawalQueue | typeof schema.v2EarnVaultDepositQueue;

/**
 * How many OPEN entries of `vault`'s queue, in EITHER direction, were issued before the one requested at
 * (`block`, `logIndex`). IEarnVault keeps one FIFO for deposits and withdrawals, and `_enqueue` issues ids in
 * execution order, so the log order of the requests IS the id order and nothing here parses an id. A cancelled or
 * served entry waits for nothing and is not counted; a partially served one is still `queued` and is.
 */
async function queueAhead(vault: string, block: bigint, logIndex: number): Promise<number> {
  const ahead = (table: QueueTable) => db.select({ n: sql<number>`count(*)::int` }).from(table).where(and(
    sql`${lowerKey(table.vault)} = ${vault}`,
    eq(table.status, "queued"),
    or(lt(table.requestedBlock, block), and(eq(table.requestedBlock, block), lt(table.requestedLogIndex, logIndex))),
  ));
  const [[withdrawals], [deposits]] = await Promise.all([
    ahead(schema.v2EarnVaultWithdrawalQueue), ahead(schema.v2EarnVaultDepositQueue),
  ]);
  return Number(withdrawals?.n ?? 0) + Number(deposits?.n ?? 0);
}

type SampleRow = typeof schema.v2EarnVaultSample.$inferSelect;
const sampleTable = schema.v2EarnVaultSample;

/** The newest sample matching `where`, optionally no later than `atOrBefore`. One indexed LIMIT 1 read. */
async function latestSample(where: ReturnType<typeof and>, atOrBefore?: bigint): Promise<SampleRow | undefined> {
  const [row] = await db.select().from(sampleTable)
    .where(atOrBefore === undefined ? where : and(where, lte(sampleTable.ts, atOrBefore)))
    .orderBy(desc(sampleTable.ts)).limit(1);
  return row;
}

const priced = (row: SampleRow | undefined, price: bigint | null | undefined): PriceSample | undefined =>
  row === undefined || price === null || price === undefined ? undefined : { ts: Number(row.ts), price };

/**
 * Realised 7d / 30d APY from the hourly samples' gross share price.
 * Not the net-of-mark price: the mark rises on a mint as well as on a skim, so that series
 * can climb while the share price does not. The fee that left is the Skimmed row.
 * Only FLAT samples count: while `hasOpenPosition()` was true, totalAssets was the understated flat-NAV floor, and a
 * sample whose flag could not be read is not vouched for either. The window start is the newest flat sample at
 * least one window before the newest flat sample (trailingApy says why it is never shorter).
 */
async function vaultApy(vault: string): Promise<{ apy7d: Apy; apy30d: Apy }> {
  const flat = and(eq(sampleTable.vault, vault as Address), eq(sampleTable.positionOpen, false),
    isNotNull(sampleTable.pricePerShare));
  const end = await latestSample(flat);
  if (end === undefined) {
    const none = trailingApy(undefined, undefined, 0);
    return { apy7d: none, apy30d: { ...none } };
  }
  const [start7, start30] = await Promise.all([
    latestSample(flat, end.ts - BigInt(7 * DAY_S)),
    latestSample(flat, end.ts - BigInt(30 * DAY_S)),
  ]);
  const endPrice = priced(end, realisedSamplePrice(end));
  return {
    apy7d: trailingApy(endPrice, priced(start7, start7 === undefined ? undefined : realisedSamplePrice(start7)), 7 * DAY_S),
    apy30d: trailingApy(endPrice, priced(start30, start30 === undefined ? undefined : realisedSamplePrice(start30)), 30 * DAY_S),
  };
}

/**
 * The venue's own APY from its sampled `convertToAssets(EARN_VENUE_PROBE_SHARES)`, over 24h and 7d, and
 * the venue's name from the newest sample. A window only spans samples of the SAME venue: an adapter swap starts the
 * venue's history over rather than dividing one venue's price by another's.
 */
async function venueApy(vault: string): Promise<{ venue: string | null; name: string | null; apy24h: Apy; apy7d: Apy }> {
  const probed = and(eq(sampleTable.vault, vault as Address), isNotNull(sampleTable.venue),
    isNotNull(sampleTable.venueProbeAssets));
  const end = await latestSample(probed);
  if (end === undefined || end.venue === null) {
    const none = trailingApy(undefined, undefined, 0);
    return { venue: null, name: null, apy24h: none, apy7d: { ...none } };
  }
  const same = and(probed, eq(sampleTable.venue, end.venue));
  const [start1, start7] = await Promise.all([
    latestSample(same, end.ts - BigInt(DAY_S)),
    latestSample(same, end.ts - BigInt(7 * DAY_S)),
  ]);
  const endPrice = priced(end, end.venueProbeAssets);
  return {
    venue: end.venue,
    name: end.venueName,
    apy24h: trailingApy(endPrice, priced(start1, start1?.venueProbeAssets), DAY_S),
    apy7d: trailingApy(endPrice, priced(start7, start7?.venueProbeAssets), 7 * DAY_S),
  };
}

export function registerEarnRoutes(app: Hono) {
  app.get("/earn", async (c) => {
    if (V2_EARN_VAULT === undefined) {
      return c.json({ configured: false }, 404);
    }

    const rawAddress = c.req.query("address");
    if (rawAddress !== undefined && rawAddress !== "" && !isAddress(rawAddress)) {
      return c.json({ error: { code: "bad_request", message: "address is not a valid address." } }, 400);
    }
    const wallet = rawAddress ? getAddress(rawAddress).toLowerCase() : null;

    const queuedStatus = eq(schema.v2EarnVaultWithdrawalQueue.status, "queued");
    const states = await db.select().from(schema.v2EarnVaultState);
    const [deposits, skims, queues, depositQueues, accountQueued, accountDeposits, live] = await Promise.all([
      db.select({
        vault: lowerKey(schema.v2EarnVaultDeposit.vault),
        total: sql<string>`sum(${schema.v2EarnVaultDeposit.assets})::text`,
      }).from(schema.v2EarnVaultDeposit).groupBy(lowerKey(schema.v2EarnVaultDeposit.vault)),
      db.select({
        vault: lowerKey(schema.v2EarnVaultSkim.vault),
        total: sql<string>`sum(${schema.v2EarnVaultSkim.amount})::text`,
      }).from(schema.v2EarnVaultSkim).groupBy(lowerKey(schema.v2EarnVaultSkim.vault)),
      db.select({
        vault: lowerKey(schema.v2EarnVaultWithdrawalQueue.vault),
        depth: sql<number>`count(*)::int`,
        oldest: sql<string>`min(${schema.v2EarnVaultWithdrawalQueue.requestedAt})::text`,
      }).from(schema.v2EarnVaultWithdrawalQueue).where(queuedStatus)
        .groupBy(lowerKey(schema.v2EarnVaultWithdrawalQueue.vault)),
      // Queued DEPOSITS wait in the same FIFO, so they are part of the depth a new request queues behind.
      db.select({
        vault: lowerKey(schema.v2EarnVaultDepositQueue.vault),
        depth: sql<number>`count(*)::int`,
        oldest: sql<string>`min(${schema.v2EarnVaultDepositQueue.requestedAt})::text`,
      }).from(schema.v2EarnVaultDepositQueue).where(eq(schema.v2EarnVaultDepositQueue.status, "queued"))
        .groupBy(lowerKey(schema.v2EarnVaultDepositQueue.vault)),
      // Scoped to the caller's own open requests, never the whole queue.
      wallet === null ? [] : db.select().from(schema.v2EarnVaultWithdrawalQueue).where(and(queuedStatus,
        sql`${lowerKey(schema.v2EarnVaultWithdrawalQueue.account)} = ${wallet}`)),
      // The caller's queued DEPOSITS too -- the same FIFO, and just as cancellable (DepositQueued.owner).
      wallet === null ? [] : db.select().from(schema.v2EarnVaultDepositQueue).where(and(
        eq(schema.v2EarnVaultDepositQueue.status, "queued"),
        sql`${lowerKey(schema.v2EarnVaultDepositQueue.account)} = ${wallet}`)),
      // The live display mark, one multicall for every vault in the same request.
      readEarnLive(states.map((row) => getAddress(row.vault))),
    ]);
    const now = Math.floor(Date.now() / 1000);

    // Liquidity for "earliest withdrawal" and the venue, then the per-vault history reads.
    const [liquidity, extras] = await Promise.all([
      readEarnLiquidity(states.map((row) => ({
        vault: getAddress(row.vault),
        asset: row.asset ? getAddress(row.asset) : null,
        adapter: attachedAdapter(row.adapter),
      }))),
      Promise.all(states.map(async (row) => {
        const key = row.vault.toLowerCase();
        const [expiry, yields, venue] = await Promise.all([openPositionExpiry(key), vaultApy(key), venueApy(key)]);
        return [key, { expiry, yields, venue }] as const;
      })).then((entries) => new Map(entries)),
    ]);

    // The newest move per vault, one LIMIT 1 read per vault, so what reaches this process is one row
    // per vault rather than every move ever made. The lower() predicate cannot use the (vault, ts)
    // index, so Postgres may still scan; see WHAT THIS DOES NOT FIX above.
    const lastMoves = new Map(await Promise.all(states.map(async (row) => {
      const key = row.vault.toLowerCase();
      const [move] = await db.select().from(schema.v2EarnVaultAdapterMove)
        .where(sql`${lowerKey(schema.v2EarnVaultAdapterMove.vault)} = ${key}`)
        .orderBy(desc(schema.v2EarnVaultAdapterMove.ts), desc(schema.v2EarnVaultAdapterMove.logIndex))
        .limit(1);
      return [key, move] as const;
    })));
    // Each vault's venue write-offs (VenueWrittenOff), newest first and bounded per
    // vault: every one needs a TREASURY_ADMIN setAdapter on a venue that stopped answering, so they are rare.
    const writeOffs = new Map(await Promise.all(states.map(async (row) => {
      const key = row.vault.toLowerCase();
      const rows = await db.select().from(schema.v2EarnVaultVenueWriteOff)
        .where(sql`${lowerKey(schema.v2EarnVaultVenueWriteOff.vault)} = ${key}`)
        .orderBy(desc(schema.v2EarnVaultVenueWriteOff.block), desc(schema.v2EarnVaultVenueWriteOff.logIndex))
        .limit(EARN_WRITE_OFFS_SENT);
      return [key, rows] as const;
    })));
    // A vault with no rows is absent from a GROUP BY, which is what keeps "never observed" (null)
    // distinct from an observed zero.
    const depositByVault = new Map(deposits.map((row) => [row.vault, row.total]));
    const skimByVault = new Map(skims.map((row) => [row.vault, row.total]));
    const queueByVault = new Map(queues.map((row) => [row.vault, { depth: Number(row.depth), oldest: Number(row.oldest) }]));
    for (const row of depositQueues) {
      const seen = queueByVault.get(row.vault);
      const depth = Number(row.depth) + (seen?.depth ?? 0);
      const oldest = seen === undefined ? Number(row.oldest) : Math.min(seen.oldest, Number(row.oldest));
      queueByVault.set(row.vault, { depth, oldest });
    }

    const vaults = states.map((row) => {
      const key = row.vault.toLowerCase();
      const open = queueByVault.get(key);
      const lastMove = lastMoves.get(key);
      const mark = live.get(key) ?? NO_LIVE;
      const liq = liquidity.get(key) ?? NO_LIQUIDITY;
      const extra = extras.get(key);
      const adapter = attachedAdapter(row.adapter);
      const venueCash = venueLiquidity({ advisory: liq.advisory, withdrawable: liq.withdrawable, position: liq.position });
      // The live venue() wins; the sampled one covers an RPC miss. The sampled name AND APY describe the sampled
      // venue, so they are used only when it is the venue shown: straight after an adapter swap the new venue has
      // no samples yet, and showing the old venue's rate under the new address would be a wrong fact, not a gap.
      const venueAddress = liq.venue ?? (extra?.venue.venue ? getAddress(extra.venue.venue) : null);
      const sameVenue = Boolean(extra?.venue.venue && venueAddress !== null
        && extra.venue.venue.toLowerCase() === venueAddress.toLowerCase());
      const venueName = sameVenue ? extra!.venue.name : null;
      const none = trailingApy(undefined, undefined, 0);
      return {
        vault: address(row.vault),
        asset: row.asset ? address(row.asset) : null,
        adapter: row.adapter ? address(row.adapter) : null,
        // The live read, else the last FundingEnabledSet indexed. Never shown to users as a pause.
        fundingEnabled: mark.fundingEnabled ?? row.fundingEnabled,
        sharesSupply: row.sharesSupply === null ? null : row.sharesSupply.toString(),
        deposited: depositByVault.get(key) ?? null,
        skimmed: skimByVault.get(key) ?? null,
        // display-only mark and the flag that says whether it is the one to show.
        indicativeAssetsPerShare: mark.indicativeAssetsPerShare,
        indicativeTotalAssets: mark.indicativeTotalAssets,
        hasOpenPosition: mark.hasOpenPosition,
        queue: {
          depth: open?.depth ?? 0,
          oldestRequestedAt: open === undefined ? null : open.oldest,
        },
        lastAdapterMove: lastMove ? {
          adapter: lastMove.adapter ? address(lastMove.adapter) : null,
          // Ingest records contract movement as in/out; the public wire names the same
          // adapter-to-vault and vault-to-adapter directions pull/push.
          direction: lastMove.direction === "in" ? "pull" : lastMove.direction === "out" ? "push"
            : lastMove.direction === "pull" || lastMove.direction === "push" ? lastMove.direction : null,
          requested: lastMove.requested.toString(),
          delivered: lastMove.delivered === null ? null : lastMove.delivered.toString(),
          ts: Number(lastMove.ts),
          tx: lastMove.tx,
        } : null,
        // The event's own amount (lastKnown), never a share-price difference.
        venueWriteOffs: (writeOffs.get(key) ?? []).map((w) => ({
          adapter: address(w.adapter),
          amount: w.lastKnown.toString(),
          ts: Number(w.ts),
          tx: w.tx,
        })),

        apy7d: extra?.yields.apy7d ?? none,
        apy30d: extra?.yields.apy30d ?? { ...none },
        totalAssets: liq.totalAssets === null ? null : liq.totalAssets.toString(),
        venue: adapter === null ? null : {
          address: venueAddress,
          name: venueName,
          apy24h: sameVenue ? extra!.venue.apy24h : { ...none },
          apy7d: sameVenue ? extra!.venue.apy7d : { ...none },
          withdrawable: venueCash.amount === null ? null : venueCash.amount.toString(),
          withdrawableSource: venueCash.source,
          position: liq.position === null ? null : liq.position.toString(),
        },
        earliestWithdrawal: earnEarliestWithdrawal({
          now,
          positionOpen: mark.hasOpenPosition,
          positionExpiry: extra?.expiry ?? null,
          queueOpen: liq.queueOpen,
          venueUnreadable: liq.venueUnreadable,
          wallet: unescrowed(liq.balance, liq.escrowed, liq.deferred),
          ledger: liq.ledger,
          venueAttached: adapter !== null,
          venue: venueCash.amount,
        }),
      };
    }).sort((left, right) => left.vault.localeCompare(right.vault));

    // What a partial service already burned, so the card shows the shares STILL escrowed; and each open
    // request's place in its vault's queue. Both are bounded by the caller's own open requests.
    const servedIds = accountQueued.map((item) => item.id);
    const [served, positions] = await Promise.all([
      servedIds.length === 0 ? [] : db.select({
        queueId: schema.v2EarnVaultWithdrawal.queueId,
        shares: sql<string>`sum(${schema.v2EarnVaultWithdrawal.shares})::text`,
      }).from(schema.v2EarnVaultWithdrawal).where(inArray(schema.v2EarnVaultWithdrawal.queueId, servedIds))
        .groupBy(schema.v2EarnVaultWithdrawal.queueId),
      Promise.all([...accountQueued, ...accountDeposits].map(async (item) =>
        [item.id, 1 + await queueAhead(item.vault.toLowerCase(), item.requestedBlock, item.requestedLogIndex)] as const))
        .then((entries) => new Map(entries)),
    ]);
    const servedShares = new Map(served.map((row) => [row.queueId, BigInt(row.shares)]));
    const queued = [
      ...accountQueued.map((item) => {
        const left = item.sharesQueued - (servedShares.get(item.id) ?? 0n);
        return {
          id: item.id,
          status: item.status as "queued" | "fulfilled" | "cancelled",
          sharesQueued: item.sharesQueued.toString(),
          assetsRequested: item.assetsRequested === null ? null : item.assetsRequested.toString(),
          fulfilledAssets: item.fulfilledAssets === null ? null : item.fulfilledAssets.toString(),
          requestedAt: Number(item.requestedAt),
          vault: address(item.vault),
          queueId: queueIdOf(item.id),
          kind: "withdrawal" as const,
          assetsQueued: null,
          sharesEscrowed: (left > 0n ? left : 0n).toString(),
          position: positions.get(item.id)!,
        };
      }),
      ...accountDeposits.map((item) => ({
        id: item.id,
        status: item.status as "queued" | "fulfilled" | "cancelled",
        // A deposit entry escrows assets and never shares (IEarnVault.Request invariant); nothing is paid out yet.
        sharesQueued: "0",
        assetsRequested: null,
        fulfilledAssets: null,
        requestedAt: Number(item.requestedAt),
        vault: address(item.vault),
        queueId: queueIdOf(item.id),
        kind: "deposit" as const,
        assetsQueued: item.assetsQueued.toString(),
        sharesEscrowed: "0",
        position: positions.get(item.id)!,
      })),
    ].sort((left, right) => left.vault.localeCompare(right.vault) || left.position - right.position);

    // Payments the vault holds for the caller, as owner or receiver (both may claimDeferred), still unpaid.
    const heldRows = wallet === null ? [] : await db.select().from(schema.v2EarnVaultHeldPayment).where(and(
      sql`${schema.v2EarnVaultHeldPayment.assets} > 0`,
      or(
        sql`${lowerKey(schema.v2EarnVaultHeldPayment.owner)} = ${wallet}`,
        sql`${lowerKey(schema.v2EarnVaultHeldPayment.receiver)} = ${wallet}`,
      ),
    ));
    const held = heldRows
      .map((row) => ({
        vault: address(row.vault),
        queueId: row.requestId.toString(),
        owner: address(row.owner),
        receiver: address(row.receiver),
        asset: address(row.asset),
        assets: row.assets.toString(),
        updatedAt: Number(row.updatedAt),
      }))
      .sort((left, right) => left.vault.localeCompare(right.vault) || Number(BigInt(left.queueId) - BigInt(right.queueId)));

    const account = wallet ? { address: address(wallet), shares: null, queued, held } : null;

    return c.json({ configured: true, vaults, account });
  });
}
