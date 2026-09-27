import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { asc, desc, eq } from "ponder";
import { getAddress, isAddress } from "viem";

import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { houseEarliestWithdrawal } from "../../v2/earnYield";
import { SETTLEMENT_WINDOW } from "../../v2/settlementWindow";
import { address, error, money, signedMoney } from "./shared";

/**
 * House vault tape, served from the House vault ingest (indexer/src/v2/houseVault.ts writes
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
 * the ticker <-> underlying pair (a stale generated market file named the wrong token once): this
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

/** The stored kind, or `unknown` for a value this build does not know (never guessed as weekly). */
function vaultKind(row: VaultRow): "weekly" | "daily" | "unknown" {
  return row.kind === "weekly" || row.kind === "daily" ? row.kind : "unknown";
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

/**
 * Where an open request stands, by the contract's own rule. HouseVault.claim retires a request when
 * `r.epochId < epochId` (callhouse-contracts src/v2/periphery/house/HouseVault.sol `claim`: `d.epochId < epochId`,
 * `w.epochId < epochId`), and cancelDepositRequest / cancelWithdrawRequest revert TooEarly when `r.epochId != epochId`.
 * `epochId` is the vault's CURRENT epoch, which moves only in `rollEpoch`, so the clock never decides this: after
 * `epochEnd` a request stays pending until the roll. `current` null (the vault's epoch is not indexed) is `unknown`,
 * never a guess.
 */
export function houseRequestStatus(requestEpoch: bigint, current: bigint | null): "pending" | "claimable" | "unknown" {
  if (current === null) return "unknown";
  return requestEpoch < current ? "claimable" : "pending";
}

/** What every queue item carries about its maturity. `current` and `endOf` come from the vault's rows. */
type Maturity = { current: bigint | null; endOf: (epochId: bigint) => bigint | null };

function maturityWire(row: { epochId: bigint }, m: Maturity) {
  const end = m.endOf(row.epochId);
  return {
    epochId: row.epochId.toString(),
    status: houseRequestStatus(row.epochId, m.current),
    maturesAt: end === null ? null : Number(end),
  };
}

function depositWire(row: DepositRow, m: Maturity) {
  return {
    kind: "deposit" as const,
    account: address(row.account),
    // Preserve both legs: a Stock Token-only request has an observed zero USDG leg.
    assets: row.usdgAmount.toString(),
    stockAmount: row.stockAmount.toString(),
    shares: null,
    requestedAt: Number(row.requestedAt),
    ...maturityWire(row, m),
  };
}

function withdrawWire(row: WithdrawRow, m: Maturity) {
  return {
    kind: "withdraw" as const,
    account: address(row.account),
    assets: null,
    stockAmount: null,
    shares: row.shares.toString(),
    requestedAt: Number(row.requestedAt),
    ...maturityWire(row, m),
  };
}

/**
 * When a withdrawal requested now is priced: the current epoch's end (HouseVault `rollEpoch`, see
 * earnYield.houseEarliestWithdrawal). The vault row's `currentEpochEnd` is the ingest's own read of `epochEnd()`
 * (VaultCreated / EpochRolled, houseVault.ts); the current epoch row's `end` covers a vault row that lacks it.
 */
function earliestWithdrawal(vault: VaultRow, current: EpochRow | undefined, now: number) {
  const end = vault.currentEpochEnd ?? current?.end ?? null;
  return houseEarliestWithdrawal({
    now,
    kind: vaultKind(vault),
    epochEnd: end === null ? null : Number(end),
    settlementWindow: SETTLEMENT_WINDOW,
  });
}

/**
 * The fixed order of a market's House vaults, replacing "whatever row the database returns first". Daily
 * first (daily vaults lead once they are live, so a caller that names no vault gets the
 * one open for deposits), then weekly, then unknown. Within one kind the earliest-created vault comes first -- lowest
 * createdBlock, then createdLogIndex, then the lowercase address -- so the launch vault, which holds the existing
 * money, leads when two vaults share a kind. With one vault per market (today) this returns exactly what vaults[0] did.
 */
const KIND_ORDER = { daily: 0, weekly: 1, unknown: 2 } as const;

export function compareHouseVaults(left: VaultRow, right: VaultRow): number {
  const byKind = KIND_ORDER[vaultKind(left)] - KIND_ORDER[vaultKind(right)];
  if (byKind !== 0) return byKind;
  if (left.createdBlock !== right.createdBlock) return left.createdBlock < right.createdBlock ? -1 : 1;
  if (left.createdLogIndex !== right.createdLogIndex) return left.createdLogIndex - right.createdLogIndex;
  const a = left.vault.toLowerCase();
  const b = right.vault.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
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
    const now = Math.floor(Date.now() / 1000);
    const [vaults, epochs, navs] = await Promise.all([
      db.select().from(schema.v2HouseVault),
      db.select().from(schema.v2HouseEpoch),
      db.select().from(schema.v2HouseNav),
    ]);

    // Vaults in the fixed per-market order first; the market sort below is stable (ES2019), so it keeps
    // that order inside each market.
    const items = [...vaults].sort(compareHouseVaults)
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
          kind: vaultKind(vault),
          currentEpoch: current === undefined ? null : epochWire(current, nav),
          sharesSupply: vault.sharesSupply === null ? null : vault.sharesSupply.toString(),
          earliestWithdrawal: earliestWithdrawal(vault, current, now),
        };
      })
      .sort((left, right) => left.market.localeCompare(right.market));

    // No cursor pagination yet: a market holds at most one weekly and one daily vault (plus any legacy-factory
    // weekly vault), so this is a small, bounded set. It is NOT one vault per market; see compareHouseVaults.
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

    // `?vault=` opens one exact vault of this market. Same validation as `address` (viem strict: lowercase or
    // a correct EIP-55 checksum). Rows come back lowercase (the ingest writes lower(), and the t.hex() column lowercases
    // on write) while every link the web builds carries the checksummed form, so the pick compares lowercase strings.
    const rawVault = c.req.query("vault");
    if (rawVault !== undefined && rawVault !== "" && !isAddress(rawVault)) {
      return error(c, "bad_request", "vault is not a valid address.", 400);
    }
    const wanted = rawVault ? rawVault.toLowerCase() : null;

    const vaults = await db.select().from(schema.v2HouseVault)
      .where(eq(schema.v2HouseVault.underlying, market.underlying.toLowerCase() as `0x${string}`));
    const ordered = [...vaults].sort(compareHouseVaults);
    const vault = wanted === null
      ? ordered[0]
      : ordered.find((row: VaultRow) => row.vault.toLowerCase() === wanted);
    if (vault === undefined) {
      // A named vault that is not one of this market's is a 404, never the default vault: the page would otherwise
      // show, and write to, a vault nobody asked for.
      return wanted === null
        ? error(c, "not_found", "No House vault has been created for that market.", 404)
        : error(c, "not_found", "That address is not a House vault for this market.", 404);
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

    // The vault row's own read of epochId (VaultCreated / EpochRolled), else the current epoch row's id.
    const maturity: Maturity = {
      current: vault.currentEpochId ?? current?.epochId ?? null,
      endOf: (epochId) => epochRows.find((row: EpochRow) => row.epochId === epochId)?.end
        ?? (epochId === vault.currentEpochId ? vault.currentEpochEnd : null) ?? null,
    };
    const queue = [
      ...deposits.filter(isOpen).map((row) => depositWire(row, maturity)),
      ...withdrawals.filter(isOpen).map((row) => withdrawWire(row, maturity)),
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
      kind: vaultKind(vault),
      currentEpoch: current === undefined ? null : epochWire(current, navFor(current.epochId)),
      epochs: epochRows.map((row: EpochRow) => epochWire(row, navFor(row.epochId))),
      shares,
      queue,
      earliestWithdrawal: earliestWithdrawal(vault, current, Math.floor(Date.now() / 1000)),
    });
  });
}
