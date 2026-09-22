import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { asc, desc, eq } from "ponder";
import { getAddress, isAddress } from "viem";

import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { address, error, money, signedMoney } from "./shared";

/**
 * House vault tape, served from the ingest T-175 landed (indexer/src/v2/houseVault.ts writes
 * v2HouseVault, v2HouseEpoch, v2HouseNav, v2HouseShareBalance and the two queue tables).
 *
 * This file used to be a stub that returned `{ items: [], nextCursor: null }` and 404'd every
 * market path, with a header saying ingest did not exist yet. It did exist. A stub that answers
 * 200 with a constant beside populated tables is worse than an outage: the consumer cannot tell
 * it is being served a literal, and the test that covered it asserted the literal, so dropping
 * every house table left the suite green.
 *
 * NULLS ARE FACTS HERE. `usdg` / `stockUnits` on a NAV row and `start` / `end` on an epoch are
 * nullable columns; they are forwarded as null and never coerced to 0, because 0 at a settlement
 * boundary means "an empty book was published", which is a different claim from "the log did not
 * say". The wire schemas were widened to match the columns in this same commit.
 */

type VaultRow = typeof schema.v2HouseVault.$inferSelect;
type EpochRow = typeof schema.v2HouseEpoch.$inferSelect;
type NavRow = typeof schema.v2HouseNav.$inferSelect;
type DepositRow = typeof schema.v2HouseDepositQueue.$inferSelect;
type WithdrawRow = typeof schema.v2HouseWithdrawQueue.$inferSelect;

/**
 * Ticker for a vault's underlying Stock Token. The generated registry is the source of truth for
 * the ticker <-> underlying pair (operator note 2026-09-20 on stale generated market data): this
 * reads indexer/lib/v2/marketRegistry.generated.ts, NOT web/lib/markets.generated.ts.
 *
 * Returns null rather than "" when the underlying is not a registered market. An empty string
 * would flow into `market` and read as a published-but-unnamed vault; null lets the caller decide,
 * and the list keeps the vault under its address instead of silently dropping it.
 */
function tickerFor(underlying: string): string | null {
  const key = underlying.toLowerCase();
  const row = V2_REGISTRY.markets.find((m) => m.underlying.toLowerCase() === key);
  return row === undefined ? null : row.ticker;
}

function navWire(row: NavRow | undefined) {
  if (row === undefined) return null;
  return {
    epoch: row.epochId.toString(),
    at: Number(row.at),
    usdg: row.usdg === null ? null : money(row.usdg),
    stockUnits: row.stockUnits === null ? null : row.stockUnits.toString(),
    settlementPrice: money(row.settlementPrice),
    navUsdg: money(row.navUsdg),
  };
}

function epochWire(row: EpochRow, nav: NavRow | undefined) {
  return {
    id: row.epochId.toString(),
    start: row.start === null ? null : Number(row.start),
    end: row.end === null ? null : Number(row.end),
    nav: navWire(nav),
    resultUsdg: row.resultUsdg === null ? null : signedMoney(row.resultUsdg),
  };
}

/** Only rows the contract still has open. A closed request is history, not a queue entry. */
function isOpen(row: { status: string }) {
  return row.status === "queued";
}

function depositWire(row: DepositRow) {
  return {
    kind: "deposit" as const,
    account: address(row.account),
    // Preserve both legs: a Stock Token-only request has an observed zero USDG leg.
    assets: row.usdgAmount.toString(),
    stockAmount: row.stockAmount.toString(),
    shares: null,
    requestedAt: Number(row.requestedAt),
  };
}

function withdrawWire(row: WithdrawRow) {
  return {
    kind: "withdraw" as const,
    account: address(row.account),
    assets: null,
    stockAmount: null,
    shares: row.shares.toString(),
    requestedAt: Number(row.requestedAt),
  };
}

/**
 * The epoch a vault is currently in. Prefers the `running` row; falls back to the highest epochId
 * observed, so a vault whose roll landed without a successor row still reports its last epoch
 * rather than reporting nothing.
 */
function currentEpochRow(rows: EpochRow[]): EpochRow | undefined {
  const running = rows.find((row) => row.status === "running");
  if (running !== undefined) return running;
  return rows.reduce<EpochRow | undefined>(
    (best, row) => (best === undefined || row.epochId > best.epochId ? row : best),
    undefined,
  );
}

export function registerHouseRoutes(app: Hono) {
  app.get("/house", async (c) => {
    const [vaults, epochs, navs] = await Promise.all([
      db.select().from(schema.v2HouseVault),
      db.select().from(schema.v2HouseEpoch),
      db.select().from(schema.v2HouseNav),
    ]);

    const items = vaults
      .map((vault: VaultRow) => {
        const key = vault.vault.toLowerCase();
        const mine = epochs.filter((row: EpochRow) => row.vault.toLowerCase() === key);
        const current = currentEpochRow(mine);
        const nav = current === undefined
          ? undefined
          : navs.find((row: NavRow) => row.vault.toLowerCase() === key && row.epochId === current.epochId);
        return {
          // Falls back to the vault address so an unregistered underlying is still nameable.
          market: tickerFor(vault.underlying) ?? address(vault.vault),
          vault: address(vault.vault),
          currentEpoch: current === undefined ? null : epochWire(current, nav),
          sharesSupply: vault.sharesSupply === null ? null : vault.sharesSupply.toString(),
        };
      })
      .sort((left, right) => left.market.localeCompare(right.market));

    // No cursor pagination yet: one vault per listed market is a small, bounded set.
    return c.json({ items, nextCursor: null });
  });

  app.get("/house/:market", async (c) => {
    const ticker = c.req.param("market");
    const market = V2_REGISTRY.markets.find((row) => row.ticker.toLowerCase() === ticker.toLowerCase());
    if (market === undefined) {
      return error(c, "not_found", "No House vault is published for that market.", 404);
    }

    const rawAddress = c.req.query("address");
    if (rawAddress !== undefined && rawAddress !== "" && !isAddress(rawAddress)) {
      return error(c, "bad_request", "address is not a valid address.", 400);
    }
    const wallet = rawAddress ? getAddress(rawAddress).toLowerCase() : null;

    const vaults = await db.select().from(schema.v2HouseVault)
      .where(eq(schema.v2HouseVault.underlying, market.underlying.toLowerCase() as `0x${string}`));
    const vault = vaults[0];
    if (vault === undefined) {
      return error(c, "not_found", "No House vault has been created for that market.", 404);
    }

    const vaultKey = vault.vault as `0x${string}`;
    const [epochRows, navRows, deposits, withdrawals, balances] = await Promise.all([
      db.select().from(schema.v2HouseEpoch).where(eq(schema.v2HouseEpoch.vault, vaultKey))
        .orderBy(desc(schema.v2HouseEpoch.epochId)),
      db.select().from(schema.v2HouseNav).where(eq(schema.v2HouseNav.vault, vaultKey)),
      db.select().from(schema.v2HouseDepositQueue).where(eq(schema.v2HouseDepositQueue.vault, vaultKey))
        .orderBy(asc(schema.v2HouseDepositQueue.requestedAt)),
      db.select().from(schema.v2HouseWithdrawQueue).where(eq(schema.v2HouseWithdrawQueue.vault, vaultKey))
        .orderBy(asc(schema.v2HouseWithdrawQueue.requestedAt)),
      db.select().from(schema.v2HouseShareBalance).where(eq(schema.v2HouseShareBalance.vault, vaultKey)),
    ]);

    const navFor = (epochId: bigint) => navRows.find((row: NavRow) => row.epochId === epochId);
    const current = currentEpochRow(epochRows);

    const queue = [
      ...deposits.filter(isOpen).map(depositWire),
      ...withdrawals.filter(isOpen).map(withdrawWire),
    ].sort((left, right) => left.requestedAt - right.requestedAt);

    const shares = wallet === null ? null : (() => {
      const held = balances.find((row) => row.account.toLowerCase() === wallet);
      return {
        address: address(wallet),
        // Null is "no share row observed"; "0" is an observed empty holding. Not the same fact.
        shares: held === undefined ? null : held.shares.toString(),
        queued: queue.filter((item) => item.account.toLowerCase() === wallet),
      };
    })();

    return c.json({
      market: market.ticker,
      vault: address(vault.vault),
      currentEpoch: current === undefined ? null : epochWire(current, navFor(current.epochId)),
      epochs: epochRows.map((row: EpochRow) => epochWire(row, navFor(row.epochId))),
      shares,
      queue,
    });
  });
}
