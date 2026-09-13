import { keccak256, toHex, type Hex } from "viem";

/**
 * The vault's OZ AccessControl roles, resolved from their hashes.
 *
 * | role | holder | powers |
 * |---|---|---|
 * | DEFAULT_ADMIN_ROLE | 2/3 Safe | policy inside the hard caps, fee recipient, deposit cap, accept the Valorem fee, unhalt |
 * | KEEPER_ROLE | hot wallet | rollOpen, approveListing, cancelListing, rollClose. Can never move funds out. |
 * | GUARDIAN_ROLE | 1/1 hardware key | haltWrites, cancelListing, invalidateAllListings, rollClose an hour after expiry |
 *
 * Worth indexing because "who can touch this vault right now" is a published fact, and
 * because a role granted to an address nobody recognises is the first sign of trouble.
 */
export const ROLE_DEFAULT_ADMIN: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
export const ROLE_KEEPER: Hex = keccak256(toHex("KEEPER_ROLE"));
export const ROLE_GUARDIAN: Hex = keccak256(toHex("GUARDIAN_ROLE"));

export function roleName(role: Hex): string {
  const r = role.toLowerCase();
  if (r === ROLE_DEFAULT_ADMIN) return "DEFAULT_ADMIN_ROLE";
  if (r === ROLE_KEEPER.toLowerCase()) return "KEEPER_ROLE";
  if (r === ROLE_GUARDIAN.toLowerCase()) return "GUARDIAN_ROLE";
  return "UNKNOWN_ROLE";
}
