/**
 * The Admin Safe's execution delays, as the chain has them now.
 *
 * THE SOURCE IS THE INDEXED HOLDER DELAY, NEVER THE PLANNED TABLE. `/v2/config` `access.roles[].holders[].delayS` is
 * the delay AccessManager applies to that holder's calls on that role, derived from indexed chain events
 * (indexer src/api/v2/markets.ts, `effectiveDelay`). The planned delays -- script/v2/roles.v8.json, and its generated
 * copy in indexer lib/v2/accessManagerRoles.generated.ts -- are false on one side of the admin's lock transaction: the
 * zero-delay redeploy gives the Admin Safe every lane at 0, and one later Safe transaction raises them all. Copy that
 * states a delay reads it from here, and says nothing numeric when it cannot.
 *
 * ROLES ARE MATCHED BY NUMERIC ID, NEVER BY NAME. The manifest's names are bare (FEE_MANAGER) while older fixtures carry
 * a _ROLE suffix; the ids are the contract's (roles.v8.json "roles", V8Roles.sol).
 */
import type { ConfigResponse } from "./api-types";

/** AccessManager role ids of the Admin Safe's six DELAYED lanes (roles.v8.json "roles"). NEW_LISTING is separate, below. */
export const ROLE_ID = {
  ADMIN: 0,
  FEE_MANAGER: 1,
  MARKET_FEE_MANAGER: 2,
  CONFIG_ADMIN: 3,
  TREASURY_ADMIN: 4,
  LISTING: 5,
} as const;

/** The six lanes whose changes the guardian could cancel while they wait (Trust page). */
export const ADMIN_SAFE_ROLE_IDS: readonly number[] = Object.values(ROLE_ID);

/**
 * NEW_LISTING, the Admin Safe's one lane with NO delay by design. It can only set up
 * what does not exist yet: `registerMarket` (a market that is not registered), `createVault` (a House vault not created
 * yet) and the first-time `listMarket` / `listFeed` / `listPool` / `listRouteV3` / `listRouteV4`, each of which reverts
 * for an asset its contract was ever configured for. Every change to an existing market stays on a delayed lane above.
 * It is deliberately NOT in ADMIN_SAFE_ROLE_IDS: nothing on it is ever scheduled, so the guardian has nothing to cancel,
 * and its 0 says nothing about whether the admin's lock has run (adminSafeActsImmediately must not read it).
 */
export const NEW_LISTING_ROLE_ID = 11;

/** What the Trust page says beside NEW_LISTING, so its "No delay" reads as the design rather than a missing lock. */
export const NEW_LISTING_NOTE =
  "No delay by design: this role can only set up a market that does not exist yet (its first listing, price sources, payout route and House vault). Every change to an existing market still waits on its delayed role.";

/** A role's scope note for the Trust page, or null. Matched by numeric id, like every role here. */
export function roleScopeNote(roleId: number): string | null {
  return roleId === NEW_LISTING_ROLE_ID ? NEW_LISTING_NOTE : null;
}

export type AdminDelaySource = Pick<ConfigResponse, "access" | "safes"> | null | undefined;

/**
 * The Admin Safe's holder delay on `roleId`, in seconds, or null when it cannot be read: no config, no `access` table,
 * the role missing (the indexer drops a role with no indexed row), no `safes.admin`, or the Safe not among the holders.
 * Addresses compare case-insensitively.
 */
export function adminSafeHolderDelay(config: AdminDelaySource, roleId: number): number | null {
  const admin = config?.safes?.admin?.toLowerCase();
  const role = config?.access?.roles.find((candidate) => candidate.id === roleId);
  if (!admin || !role) return null;
  const holder = role.holders.find((candidate) => candidate.address.toLowerCase() === admin);
  return holder === undefined ? null : holder.delayS;
}

/**
 * True only when the Admin Safe's holder delay reads 0 on EVERY one of the six admin lanes (ids 0-5). Any lane non-zero,
 * unread or missing is false: a claim that changes take effect immediately must hold for all of them.
 */
export function adminSafeActsImmediately(config: AdminDelaySource): boolean {
  return ADMIN_SAFE_ROLE_IDS.every((id) => adminSafeHolderDelay(config, id) === 0);
}

/** "No delay", "2 days", "1 hour", "1800 seconds": whole days or hours when exact, else seconds. */
export function formatDelay(seconds: number): string {
  if (seconds === 0) return "No delay";
  const hours = seconds / (60 * 60);
  const days = hours / 24;
  if (Number.isInteger(days)) return `${days} ${days === 1 ? "day" : "days"}`;
  if (Number.isInteger(hours)) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
