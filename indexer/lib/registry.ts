import { ponder } from "ponder:registry";

import { FACTORY, V2_CLEARINGHOUSE, V2_EXPIRY_CALENDAR, V2_KEEPER_REWARDS, VAULT } from "./env";

/**
 * The three source groups, each either the real registry or a no-op.
 *
 * WHY THIS EXISTS. Ponder loads EVERY file under src/ at boot, whatever the config says, and its
 * build refuses to start when an indexing function names a contract the config does not have:
 * `Validation failed: Invalid event 'Vault:Transfer' uses an unrecognized contract ... name`. The
 * sources are conditional (ponder.config.ts registers the vault sources only when VAULT_ADDRESS is
 * set and the factory sources only when FACTORY_ADDRESS is), so the handler registrations have to
 * be conditional in the same way, or a factory-only deployment could not build at all.
 *
 * Wrapping every `ponder.on` in src/vault.ts in an `if` would re-indent 1,400 lines of a handler
 * file that is not supposed to change for the NVDA vault. Swapping its import for `vaultPonder`
 * changes one line and nothing else: with VAULT_ADDRESS set it IS `ponder`, the same singleton the
 * build reads `fns` from, so the registrations are the ones the vault had before. Without it every
 * `on` is a no-op and the file loads as an inert module.
 *
 * Typed as `typeof ponder` so a handler's `event`, `context` and `event.args` keep their inferred
 * shapes either way; the no-op never sees an event.
 */
const inert = { on: () => undefined } as unknown as typeof ponder;

/** src/vault.ts, src/seaport.ts, src/token.ts, src/valorem.ts: the pooled vault's handlers. */
export const vaultPonder: typeof ponder = VAULT === undefined ? inert : ponder;

/** src/factory.ts, src/writerAccount.ts: the factory market's handlers. */
export const factoryPonder: typeof ponder = FACTORY === undefined ? inert : ponder;

/** One v2 Clearinghouse contains every v2 market; its handlers are inert in v1-only mode. */
export function hasV2(): boolean {
  return V2_CLEARINGHOUSE !== undefined;
}

/** src/v2/* handlers. Use this instead of ponder directly so a v1-only build stays valid. */
export const v2Ponder: typeof ponder = hasV2() ? ponder : inert;

/** Optional periphery events are registered only when their individual address is present. */
export const v2CalendarPonder: typeof ponder = V2_EXPIRY_CALENDAR === undefined ? inert : ponder;
export const v2RewardsPonder: typeof ponder = V2_KEEPER_REWARDS === undefined ? inert : ponder;
