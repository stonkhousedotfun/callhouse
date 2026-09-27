/**
 * Whether the EarnVault refuses to price because its venue adapter cannot be read.
 *
 * In the v9 EarnVault (EarnVault.sol `_recordVenue` / `_venueUnpriced`), while the venue
 * adapter's `totalAssets()` reverts and the vault's last known venue value is not zero (or is zero only
 * because pulls were subtracted from it while it could not be read), nothing is priced: `deposit` and
 * `redeem` queue, `processQueue` returns having served nothing, `skim` takes nothing (it still emits `Skimmed(0, 0)`),
 * and `convertToShares` / `convertToAssets` revert `VenueUnreadable()`. The last known value is private, so the vault's
 * own answer is the one read here: `convertToAssets(1)` reverting VenueUnreadable is exactly `_venueUnpriced()`. The
 * state ends when the venue reads again or TREASURY_ADMIN writes the venue off with `setAdapter` (`VenueWrittenOff`).
 *
 * PositionOpen is checked before VenueUnreadable, so while a position is open the vault does not say. That answer is
 * read as `false` here: every caller gates on `hasOpenPosition()` first, and nothing is sent while a position is open.
 */
import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from 'viem';

import { earnVaultAbi } from '../abi/earnVault.js';

/** The share amount the probe prices. Any amount works: both refusals are checked before the amount is used. */
export const VENUE_PROBE_SHARES = 1n;

/** The custom error a failed call reverted with, decoded against the call's ABI; null when there is none to decode. */
export function revertErrorName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : null;
}

/**
 * A failed `convertToAssets` probe as "is the venue unpriced": true for VenueUnreadable, false for PositionOpen (see
 * the header). Anything else throws: an RPC failure or an undecodable revert is an unknown answer, never "priced".
 */
export function venueUnpricedFromError(error: unknown, vault: Address): boolean {
  const name = revertErrorName(error);
  if (name === 'VenueUnreadable') return true;
  if (name === 'PositionOpen') return false;
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`EarnVault ${vault}: convertToAssets(${VENUE_PROBE_SHARES}) failed and did not say why: ${detail}`);
}

/** The probe as one read: false when the vault prices, true when it refuses VenueUnreadable. */
export async function readVenueUnpriced(client: Pick<PublicClient, 'readContract'>, vault: Address): Promise<boolean> {
  try {
    await client.readContract({ address: vault, abi: earnVaultAbi, functionName: 'convertToAssets', args: [VENUE_PROBE_SHARES] });
    return false;
  } catch (error) {
    return venueUnpricedFromError(error, vault);
  }
}
