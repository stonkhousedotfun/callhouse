/**
 * earn/venue.ts: the vault's own convertToAssets(1) answer, read as "is the venue
 * unpriced". The reverts come back through a real viem client over a custom transport, so the error is decoded by
 * name from the generated ABI exactly as it is on chain; an ABI without VenueUnreadable() fails the first case.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPublicClient, custom, encodeErrorResult, type Hex } from 'viem';

import { earnVaultAbi } from '../abi/earnVault.js';
import { readVenueUnpriced, revertErrorName, VENUE_PROBE_SHARES } from './venue.js';

const VAULT = '0x00000000000000000000000000000000000ea4a1';

/** A client whose every eth_call reverts with `data`, or answers `ok` (an ABI-encoded uint256) when data is null. */
function client(data: Hex | null, calls: Array<{ to: string; data: string }> = []) {
  return createPublicClient({
    transport: custom({
      request: async ({ method, params }) => {
        assert.equal(method, 'eth_call');
        const [tx] = params as [{ to: string; data: string }];
        calls.push(tx);
        if (data === null) return `0x${'0'.repeat(63)}1`;
        throw Object.assign(new Error('execution reverted'), { code: 3, data });
      },
    }, { retryCount: 0 }),
  });
}

const revert = (errorName: 'VenueUnreadable' | 'PositionOpen') => encodeErrorResult({ abi: earnVaultAbi, errorName });

test('VenueUnreadable() (selector 0x5e6660df) is in the generated EarnVault ABI and reads as unpriced', async () => {
  assert.equal(revert('VenueUnreadable'), '0x5e6660df', 'cast sig "VenueUnreadable()"');
  const calls: Array<{ to: string; data: string }> = [];
  assert.equal(await readVenueUnpriced(client(revert('VenueUnreadable'), calls), VAULT), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to.toLowerCase(), VAULT, 'the vault itself is asked, not the adapter');
  assert.equal(VENUE_PROBE_SHARES, 1n);
});

test('a vault that prices answers false', async () => {
  assert.equal(await readVenueUnpriced(client(null), VAULT), false);
});

test('PositionOpen comes first in the contract and reads as false: callers gate on hasOpenPosition()', async () => {
  assert.equal(await readVenueUnpriced(client(revert('PositionOpen')), VAULT), false);
});

test('any other failure throws: an unknown answer is never "priced"', async () => {
  await assert.rejects(readVenueUnpriced(client('0x'), VAULT), /convertToAssets\(1\) failed and did not say why/);
  await assert.rejects(readVenueUnpriced(client(encodeErrorResult({ abi: earnVaultAbi, errorName: 'NotAuthorized' })), VAULT), /did not say why/);
  const down = createPublicClient({ transport: custom({ request: async () => { throw new Error('rpc down'); } }, { retryCount: 0 }) });
  await assert.rejects(readVenueUnpriced(down, VAULT), /did not say why/);
});

test('revertErrorName is null for anything that is not a decoded contract revert', () => {
  assert.equal(revertErrorName(new Error('plain')), null);
  assert.equal(revertErrorName('string'), null);
  assert.equal(revertErrorName(undefined), null);
});
