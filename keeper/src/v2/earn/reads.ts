import { parseAbi, zeroAddress, type Address, type PublicClient } from 'viem';

import { earnVaultAbi } from '../abi/earnVault.js';
import type { EarnState } from './plan.js';
import { VENUE_PROBE_SHARES, venueUnpricedFromError } from './venue.js';

/**
 * The reads planEarn needs, in one multicall, plus the adapter's `withdrawable()` when there is an adapter.
 *
 * `withdrawable` is declared here rather than generated: the keeper's generated ABIs are the v2 contracts it
 * drives (scripts/gen-abis.mjs), and the venue adapter is not one of them; `IEarnVenueAdapter.withdrawable()` is
 * the one view this file asks it for. Same for the ERC-20 `balanceOf`.
 */
const adapterAbi = parseAbi(['function withdrawable() view returns (uint256)']);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface EarnReadInput {
  client: Pick<PublicClient, 'multicall' | 'readContract'>;
  vault: Address;
  usdg: Address;
  now: number;
  lastSkimAt: number | null;
}

/** The reads planEarn cannot do without, in multicall order. Any of them failing fails the whole read, as before. */
const REQUIRED = ['adapter', 'hasOpenPosition', 'queue', 'balanceOf', 'escrowedAssets', 'totalAssets'] as const;

export async function readEarnState({ client, vault, usdg, now, lastSkimAt }: EarnReadInput): Promise<EarnState> {
  // `deferredAssets()` rides in the same multicall, so it is read at the same block as the wallet it is
  // subtracted from. allowFailure is true for that one read only: an older EarnVault build (the deployed
  // v8 vault) has no such function. Its failure becomes `deferred: null`, which planEarn turns into a skip, never a
  // 0. Every REQUIRED read still throws as before, and the mm bot pages v2_mm_vault_unreadable with nothing sent.
  const results = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: vault, abi: earnVaultAbi, functionName: 'adapter' },
      { address: vault, abi: earnVaultAbi, functionName: 'hasOpenPosition' },
      { address: vault, abi: earnVaultAbi, functionName: 'queue' },
      { address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [vault] },
      { address: vault, abi: earnVaultAbi, functionName: 'escrowedAssets' },
      { address: vault, abi: earnVaultAbi, functionName: 'totalAssets' },
      { address: vault, abi: earnVaultAbi, functionName: 'deferredAssets' },
      // The vault's own answer to "is the venue priced", in the same block (earn/venue.ts).
      { address: vault, abi: earnVaultAbi, functionName: 'convertToAssets', args: [VENUE_PROBE_SHARES] },
    ],
  });
  const [adapter, hasOpenPosition, queue, wallet, escrowed, totalAssets] = REQUIRED.map((name, i) => {
    const r = results[i];
    if (r === undefined || r.status !== 'success') {
      throw new Error(`EarnVault ${vault}: the ${name}() read failed: ${r?.error?.message ?? 'no result'}`);
    }
    return r.result;
  });
  const d = results[REQUIRED.length];
  const deferred = d !== undefined && d.status === 'success' ? (d.result as bigint) : null;
  const probe = results[REQUIRED.length + 1];
  if (probe === undefined) throw new Error(`EarnVault ${vault}: the convertToAssets() read failed: no result`);
  const venueUnreadable = probe.status === 'success' ? false : venueUnpricedFromError(probe.error, vault);
  const adapterAddress = adapter === zeroAddress ? null : (adapter as Address);
  // An adapter the vault cannot read usually cannot answer withdrawable() either. planEarn skips before it reads the
  // figure then, so a failure there is 0 rather than a failed tick that would hide the reason from the stuck page.
  const venueWithdrawable =
    adapterAddress === null
      ? 0n
      : await client
          .readContract({ address: adapterAddress, abi: adapterAbi, functionName: 'withdrawable' })
          .catch((error: unknown) => {
            if (venueUnreadable) return 0n;
            throw error;
          });
  const [queueHead, queueTail] = queue as readonly [bigint, bigint];
  return {
    adapter: adapterAddress,
    hasOpenPosition: hasOpenPosition as boolean,
    venueUnreadable,
    queueHead,
    queueTail,
    wallet: wallet as bigint,
    escrowed: escrowed as bigint,
    deferred,
    totalAssets: totalAssets as bigint,
    venueWithdrawable,
    now,
    lastSkimAt,
  };
}
