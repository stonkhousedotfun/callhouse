import schema from "ponder:schema";
import type { Address } from "viem";

import { FACTORY, MARKET } from "./env";
import type { DB, EventMeta } from "./indexing";
import { marketWeekId } from "./factoryLifecycle";

/**
 * Shared reducers for the factory market: the market row, the account rows and the week rows,
 * each read-or-create and patch, the same shape as lib/indexing.ts keeps for the vault. Split
 * from it so the vault's helpers stay untouched and so nothing here depends on VAULT_ADDRESS.
 *
 * Every function takes the factory from the environment rather than as an argument: one
 * deployment indexes one factory (the Tier 1 rule), and `factoryAddress()` is the single place
 * that says so.
 */

/** The factory this deployment indexes. The handlers that call this are registered only when it is set. */
export function factoryAddress(): Address {
  if (FACTORY === undefined) {
    throw new Error("[callhouse/indexer] factory code path reached with FACTORY_ADDRESS unset");
  }
  return FACTORY;
}

/*//////////////////////////////////////////////////////////////
                              MARKET
//////////////////////////////////////////////////////////////*/

/**
 * Read the singleton market row, creating it on first touch. Every column has a default or is
 * nullable, so the fresh row is the market at its deploy: no week, no accounts, settings
 * unverified until `Factory:setup` patches them.
 */
export async function getMarket(db: DB) {
  const id = factoryAddress();
  const existing = await db.find(schema.market, { id });
  if (existing !== null) return existing;
  return await db.insert(schema.market).values({ id, ticker: MARKET });
}

export type MarketRow = Awaited<ReturnType<typeof getMarket>>;

type MarketPatch = Partial<Omit<MarketRow, "id">>;

/** Patch the market row, stamping the event's block and time so `/v1/health` can report the last activity. */
export async function patchMarket(db: DB, event: EventMeta | null, values: MarketPatch) {
  await getMarket(db);
  const stamp = event === null ? {} : { lastBlock: event.block.number, lastTimestamp: event.block.timestamp };
  return await db.update(schema.market, { id: factoryAddress() }).set({ ...values, ...stamp });
}

/*//////////////////////////////////////////////////////////////
                             ACCOUNTS
//////////////////////////////////////////////////////////////*/

/**
 * Read an account row, creating a bare one if its `AccountCreated` was not indexed.
 *
 * With START_BLOCK at the factory's deploy block every clone's creation is indexed and this never
 * creates anything (Ponder only delivers a clone's events after its `AccountCreated`, so the row
 * always exists). The bare row is for a replay bounded inside a week: an event from a clone whose
 * creation is before the range still gets a row rather than being dropped, with `owner` and
 * `index` at their "unknown" values (zero address, 0) until a rekey names the owner.
 */
export async function getAccount(db: DB, account: Address, event: EventMeta) {
  const existing = await db.find(schema.writerAccount, { id: account });
  if (existing !== null) return existing;
  return await db.insert(schema.writerAccount).values({
    id: account,
    factory: factoryAddress(),
    owner: "0x0000000000000000000000000000000000000000",
    index: 0,
    createdAt: event.block.timestamp,
    createdBlock: event.block.number,
    createdTx: event.transaction.hash,
    lastActivityAt: event.block.timestamp,
    lastActivityBlock: event.block.number,
  });
}

export type AccountRow = Awaited<ReturnType<typeof getAccount>>;

type AccountPatch = Partial<Omit<AccountRow, "id">>;

/** Patch an account row and stamp its last activity. */
export async function patchAccount(db: DB, account: Address, event: EventMeta, values: AccountPatch) {
  await getAccount(db, account, event);
  return await db.update(schema.writerAccount, { id: account }).set({
    ...values,
    lastActivityAt: event.block.timestamp,
    lastActivityBlock: event.block.number,
  });
}

/*//////////////////////////////////////////////////////////////
                               WEEKS
//////////////////////////////////////////////////////////////*/

/**
 * Read a week row by the factory's week id, or null. Unlike the vault's `getCycle` there is no
 * bare insert: a week's terms are the `WeekSet` event and nothing else carries them, so a row
 * without them would publish a strike of zero. A replay that missed the `WeekSet` attributes its
 * fills to the account rows and leaves the week absent, which the API renders as null.
 */
export async function findWeek(db: DB, weekId: number) {
  return await db.find(schema.marketWeek, { id: marketWeekId(factoryAddress(), weekId) });
}

export type WeekRow = NonNullable<Awaited<ReturnType<typeof findWeek>>>;

type WeekPatch = Partial<Omit<WeekRow, "id" | "factory" | "weekId">>;

/** Patch a week row that exists. A no-op, not an error, when it does not (see `findWeek`). */
export async function patchWeek(db: DB, weekId: number, values: WeekPatch) {
  const id = marketWeekId(factoryAddress(), weekId);
  const existing = await db.find(schema.marketWeek, { id });
  if (existing === null) return null;
  return await db.update(schema.marketWeek, { id }).set(values);
}
