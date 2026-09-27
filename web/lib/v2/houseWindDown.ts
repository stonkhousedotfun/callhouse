/**
 * wind the weekly House vaults down once the daily vaults are live.
 *
 * THE SIGNAL is the /v2/house list itself: a weekly vault is winding down when the list carries at least one DAILY
 * vault. That is the web's mirror of the keeper's rule (keeper/src/v2/mm/house.ts legacyWeeklyWindingDown: the legacy
 * weekly factory winds down once a kinded, daily-capable factory is configured). The indexer lists a vault as `daily`
 * only when it read that from a factory's vault (indexer src/v2/houseVaultKind.ts), so a daily row IS the
 * daily vaults being live, and no separate switch exists that could disagree with it.
 *
 * `unknown` never counts as daily. An unknown kind is a vault the indexer could not place; treating it as daily would
 * shut the weekly deposit on a guess. The list being unread (an indexer error) winds nothing down either: no wind-down
 * notice is shown on missing data. But the list is the ONLY signal, so while it is unread or failed a weekly vault's
 * deposit stays shut (houseWindDownUnknown): a read that did not happen never offers a deposit the protocol
 * decided to close.
 *
 * WHAT WINDING DOWN DOES AND DOES NOT DO. It hides the weekly vault's deposit action and says when to withdraw. It
 * never touches withdrawals or claims: HouseVault.claim and rollEpoch are permissionless on chain, and a depositor's
 * way out stays on the page for as long as they hold shares. Nothing on chain stops a deposit into a weekly vault
 * (HouseVault has no deposit switch), so this is the page declining to offer one, not a chain rule.
 */
import type { HouseVaultKind } from "./api-types";
import { formatNewYork } from "./houseEpoch";

type Kind = HouseVaultKind | undefined;

/** True for a weekly vault while the list carries a daily one. Pure. */
export function houseWindingDown(kind: Kind, listed: readonly Kind[]): boolean {
  return kind === "weekly" && listed.includes("daily");
}

/**
 * true for a weekly vault while the /v2/house list is unread or its read failed (`listRead` false), so its
 * wind-down is UNKNOWN and its deposit stays shut. A daily or unknown-kind vault is never wound down, so the list
 * cannot shut its deposit. Pure.
 */
export function houseWindDownUnknown(kind: Kind, listRead: boolean): boolean {
  return kind === "weekly" && !listRead;
}

/** The line a weekly vault's Deposit panel shows while its wind-down could not be checked (the list read failed). */
export const HOUSE_WIND_DOWN_UNREAD =
  "Could not check whether this weekly vault is winding down. New deposits are closed until it can be checked; withdrawals stay open.";

/** The wind-down line, with the exit at the current epoch's end (the close a withdrawal requested now is paid at). */
export function houseWindDownHeadline(epochEnd: number | null): string {
  const at = epochEnd === null ? "the vault's next close" : formatNewYork(epochEnd);
  return `Winding down: no new deposits; withdraw at ${at}.`;
}

/** What winding down means for someone already in the vault. States what happens, not what it will earn. */
export const HOUSE_WIND_DOWN_DETAIL =
  "This weekly vault is closing now that the daily house vaults are live. It takes no new deposits, and its bot only closes what the vault already holds. A withdrawal you request before the close is paid there, in kind. Requesting a withdrawal and claiming it stay open for as long as you hold shares.";

/**
 * The kinds a depositor can still choose between: a weekly vault drops out once a daily one is listed. The /vaults
 * index states the House withdrawal cadence from these, so it names the daily cadence rather than both.
 */
export function houseKindsOpenForDeposit(kinds: readonly Kind[]): Kind[] {
  return kinds.includes("daily") ? kinds.filter((kind) => kind !== "weekly") : [...kinds];
}

/** Daily vaults first (the default once they are live); every other row keeps its order. Stable, and does not mutate. */
export function dailyFirst<T extends { kind?: HouseVaultKind }>(items: readonly T[]): T[] {
  return [...items.filter((item) => item.kind === "daily"), ...items.filter((item) => item.kind !== "daily")];
}
