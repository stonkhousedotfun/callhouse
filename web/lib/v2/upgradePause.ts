/**
 * The deposit doors that a whole-deployment pause does not close on chain.
 *
 * The guardian's brakes are `OrderBook.tradingPaused` (every market) and each market's Clearinghouse `mintPaused`.
 * Three deposit entry points read neither: `Clearinghouse.deposit`, `HouseVault.requestDeposit` and `EarnVault.deposit`
 * have no pause check of their own (the v8 launch source: Clearinghouse.sol, HouseVault.sol,
 * EarnVault.sol). So a deployment the guardian has fully paused, as v8 was on 2026-09-23 for the move to v9, still
 * takes deposits, and the app stops showing them once it points at the next deployment.
 *
 *
 * The app closes those three buttons when the chain says the WHOLE deployment is paused: trading paused and every
 * market's mint paused. A mint pause on one market is a decision about that market, not an upgrade, and closes nothing
 * here. The flags are the ones /v2/markets already serves from the indexed brake logs (api-schema.ts `marketSchema`,
 * ); nothing new is read. It follows the chain both ways: unpausing reopens the doors with no build or flag.
 *
 * Withdrawals, cancels, redeems and claims are never gated here. People must always be able to leave.
 *
 * A served EMPTY market list is not a pause: the doors then behave under their own gates. An unread or failed list is
 * UNKNOWN, not "not paused": the chain may be paused and nothing else would stop the deposit, so an unknown
 * pause keeps the doors shut too. This gate only ever closes a door; it never opens one.
 */
import type { Market } from "./api-types";

export const UPGRADE_PAUSE_NOTE = "Paused for upgrade. New deposits are closed; withdrawals stay open.";
export const UPGRADE_PAUSE_UNREAD_NOTE =
  "Could not check whether deposits are paused for an upgrade. New deposits are closed until it can be checked; withdrawals stay open.";

type MarketBrakes = Pick<Market, "tradingPaused" | "mintPaused">;

/** True only when the served list has at least one market and every one reads both brakes on. */
export function pausedForUpgrade(markets: readonly MarketBrakes[] | null | undefined): boolean {
  if (!markets || markets.length === 0) return false;
  return markets.every((market) => market.tradingPaused && market.mintPaused);
}

export type DepositDoor = { open: boolean; note: string | null };

/**
 * One deposit button's final state: open only when its own gate (`ready`) is open AND the served market list says the
 * deployment is not paused for an upgrade. `note` is the one line to show while the upgrade pause holds the door shut,
 * else null.
 *
 * `markets` null is a FAILED read (the callers pass `markets.isError ? null : markets.data`) and undefined is
 * a read not answered yet. Both keep the door shut; the failed read says why, the one in flight says nothing yet.
 */
export function depositDoor(ready: boolean, markets: readonly MarketBrakes[] | null | undefined): DepositDoor {
  if (markets === undefined) return { open: false, note: null };
  if (markets === null) return { open: false, note: UPGRADE_PAUSE_UNREAD_NOTE };
  const paused = pausedForUpgrade(markets);
  return { open: ready && !paused, note: paused ? UPGRADE_PAUSE_NOTE : null };
}
