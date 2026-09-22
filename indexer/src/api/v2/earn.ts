import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, desc, eq, sql } from "ponder";
import { getAddress, isAddress, type Address } from "viem";

import { earnVaultAbi } from "../../../abis/v2/earnVault";
import { CHAIN_NAME, LIVE_READ_TIMEOUT_MS, V2_EARN_VAULT } from "../../../lib/env";
import { address } from "./shared";

/**
 * F-APP-INDEXER-06. This route used to select the whole deposit, skim and adapter-move tables with no
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

/**
 * T-OP-086 (SEC-19, T-OP-065). The DISPLAY figure for a lending-vault share while the vault may hold an
 * option position. `convertToShares` / `convertToAssets` REVERT `PositionOpen()` while `hasOpenPosition()`
 * (T-OP-065), so nothing here reads them: the vault exposes `indicativeAssetsPerShare()` and
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
};

const NO_LIVE: EarnLive = { indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: null };

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
  ]), allowFailure: true }) as Promise<ReadonlyArray<{ status: string; result?: unknown }>>);
  if (rows === null) return result;
  vaults.forEach((vault, index) => {
    const perShare = rows[index * 3];
    const total = rows[index * 3 + 1];
    const open = rows[index * 3 + 2];
    result.set(vault.toLowerCase(), {
      indicativeAssetsPerShare: perShare?.status === "success" && typeof perShare.result === "bigint"
        ? perShare.result.toString() : null,
      indicativeTotalAssets: total?.status === "success" && typeof total.result === "bigint"
        ? total.result.toString() : null,
      hasOpenPosition: open?.status === "success" && typeof open.result === "boolean" ? open.result : null,
    });
  });
  return result;
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
    const [deposits, skims, queues, accountQueued, live] = await Promise.all([
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
      // Scoped to the caller's own open requests, never the whole queue.
      wallet === null ? [] : db.select().from(schema.v2EarnVaultWithdrawalQueue).where(and(queuedStatus,
        sql`${lowerKey(schema.v2EarnVaultWithdrawalQueue.account)} = ${wallet}`)),
      // T-OP-086: the live display mark, one multicall for every vault in the same request.
      readEarnLive(states.map((row) => getAddress(row.vault))),
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
    // A vault with no rows is absent from a GROUP BY, which is what keeps "never observed" (null)
    // distinct from an observed zero.
    const depositByVault = new Map(deposits.map((row) => [row.vault, row.total]));
    const skimByVault = new Map(skims.map((row) => [row.vault, row.total]));
    const queueByVault = new Map(queues.map((row) => [row.vault, row]));

    const vaults = states.map((row) => {
      const key = row.vault.toLowerCase();
      const open = queueByVault.get(key);
      const lastMove = lastMoves.get(key);
      const mark = live.get(key) ?? NO_LIVE;
      return {
        vault: address(row.vault),
        asset: row.asset ? address(row.asset) : null,
        adapter: row.adapter ? address(row.adapter) : null,
        paused: row.paused,
        sharesSupply: row.sharesSupply === null ? null : row.sharesSupply.toString(),
        deposited: depositByVault.get(key) ?? null,
        skimmed: skimByVault.get(key) ?? null,
        // T-OP-086: display-only mark and the flag that says whether it is the one to show.
        indicativeAssetsPerShare: mark.indicativeAssetsPerShare,
        indicativeTotalAssets: mark.indicativeTotalAssets,
        hasOpenPosition: mark.hasOpenPosition,
        queue: {
          depth: open?.depth ?? 0,
          oldestRequestedAt: open === undefined ? null : Number(open.oldest),
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
      };
    }).sort((left, right) => left.vault.localeCompare(right.vault));

    const account = wallet ? {
      address: address(wallet),
      shares: null,
      queued: accountQueued.map((item) => ({
        id: item.id,
        status: item.status as "queued" | "fulfilled" | "cancelled",
        sharesQueued: item.sharesQueued.toString(),
        assetsRequested: item.assetsRequested === null ? null : item.assetsRequested.toString(),
        fulfilledAssets: item.fulfilledAssets === null ? null : item.fulfilledAssets.toString(),
        requestedAt: Number(item.requestedAt),
      })),
    } : null;

    return c.json({ configured: true, vaults, account });
  });
}
