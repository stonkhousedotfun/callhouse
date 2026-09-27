/**
 * mm/house.ts: the epoch KIND of a House vault is decided by the factory that enumerated it.
 *
 * The case that matters most is the first one. The launch vaults (0xfb5CcB9C... NVDA, 0x53eF3ff5... SPCX) come from
 * the legacy factory and have NO `weekly()` getter: `cast call <vault> 'weekly()(bool)'` reverts with empty
 * data on chain 4663 while `epochEnd()` answers on the same addresses. A reader
 * that asked them would mark both "kind unreadable" and the bot would stop quoting the live House vaults.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress, type Address } from 'viem';

import { houseSupport, legacyWeeklyWindingDown, readEpochKind, type DiscoveredHouseVault } from './house.js';

const VAULT = '0x00000000000000000000000000000000000000fb' as Address;
const LEGACY = '0x0000000000000000000000000000000000000f00' as Address;
const KINDED = '0x0000000000000000000000000000000000000f01' as Address;

test('readEpochKind: legacy-weekly is weekly and weekly() is never asked', async () => {
  let asked = 0;
  assert.equal(await readEpochKind('legacy-weekly', async () => ((asked += 1), false)), 'weekly');
  assert.equal(asked, 0);
});

test('readEpochKind: a kinded vault answers from weekly(): true is weekly, false is daily', async () => {
  assert.equal(await readEpochKind('kinded', async () => true), 'weekly');
  assert.equal(await readEpochKind('kinded', async () => false), 'daily');
});

test('readEpochKind: a kinded vault whose weekly() fails has NO kind -- a revert is never read as "legacy"', async () => {
  assert.equal(await readEpochKind('kinded', async () => { throw new Error('execution reverted'); }), null);
});

test('readEpochKind: an unknown (untagged) factory has no kind and is never asked', async () => {
  let asked = 0;
  assert.equal(await readEpochKind('unknown', async () => ((asked += 1), true)), null);
  assert.equal(asked, 0);
});

/**
 * The real chain reader, against a client that behaves like chain 4663: `weekly()` reverts on the legacy vault and
 * answers `false` on the kinded one. Records every function each read asks for.
 */
function chainLike(): { client: never; calls: Array<[Address, string]> } {
  const calls: Array<[Address, string]> = [];
  const client = {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      calls.push([address, functionName]);
      if (functionName === 'weekly') {
        if (address === VAULT) throw new Error('execution reverted, data: "0x"');
        return false;
      }
      if (functionName === 'epochEnd') return 1_790_366_400;
      if (functionName === 'epochId') return 4n;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  return { client: client as never, calls };
}

test('chain reader: a legacy vault is read for epochEnd/epochId only, labelled weekly, and its reverting weekly() is never called', async () => {
  const { client, calls } = chainLike();
  const support = houseSupport([{ address: LEGACY, kind: 'legacy-weekly' }], undefined, client);
  const found: DiscoveredHouseVault = { vault: VAULT, factory: LEGACY, factoryKind: 'legacy-weekly' };
  const view = await support.readEpoch!(found, 1n);
  assert.deepEqual(view, { epochEnd: 1_790_366_400, index: 4n, rollDue: false, kind: 'weekly' });
  assert.deepEqual(calls.map(([, f]) => f).sort(), ['epochEnd', 'epochId']);
});

test('chain reader: the same revert on a vault from a kinded factory makes it unreadable (not quoted), not weekly', async () => {
  const { client } = chainLike();
  const support = houseSupport([{ address: KINDED, kind: 'kinded' }], undefined, client);
  assert.equal(await support.readEpoch!({ vault: VAULT, factory: KINDED, factoryKind: 'kinded' }, 1n), null);
});

test('chain reader: a kinded daily vault is labelled daily from weekly() == false', async () => {
  const { client, calls } = chainLike();
  const DAILY = '0x00000000000000000000000000000000000000fd' as Address;
  const support = houseSupport([{ address: KINDED, kind: 'kinded' }], undefined, client);
  const view = await support.readEpoch!({ vault: DAILY, factory: KINDED, factoryKind: 'kinded' }, 1n);
  assert.equal(view?.kind, 'daily');
  assert.ok(calls.some(([a, f]) => a === DAILY && f === 'weekly'), 'the kinded vault IS asked');
});

test('chain reader: underlying() is the vault\'s own immutable, checksummed; a revert is null (the vault is not quoted)', async () => {
  const SPCX = '0xc1d6fb1f6fc6e2bd2a6fdd57b8e9b1ad1c6d9ea3';
  const client = {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      assert.equal(functionName, 'underlying');
      if (address === VAULT) throw new Error('execution reverted, data: "0x"');
      return SPCX;
    },
  } as never;
  const support = houseSupport([{ address: KINDED, kind: 'kinded' }], undefined, client);
  assert.equal(await support.readUnderlying!('0x00000000000000000000000000000000000000fd', 1n), getAddress(SPCX));
  assert.equal(await support.readUnderlying!(VAULT, 1n), null, 'a revert is unreadable, never "every market"');
});

test('discovery: every configured factory is enumerated in order and each vault carries its factory and kind rule', async () => {
  const enumerated: Address[] = [];
  const client = {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      assert.equal(functionName, 'vaults');
      enumerated.push(address);
      return address === LEGACY ? [VAULT] : ['0x00000000000000000000000000000000000000fd'];
    },
  } as never;
  const support = houseSupport([{ address: LEGACY, kind: 'legacy-weekly' }, { address: KINDED, kind: 'kinded' }], undefined, client);
  const found = await support.discover!(1n);
  assert.deepEqual(enumerated, [LEGACY, KINDED]);
  assert.deepEqual(found.map((f) => [f.vault, f.factory, f.factoryKind]), [
    [VAULT, LEGACY, 'legacy-weekly'],
    ['0x00000000000000000000000000000000000000fd', KINDED, 'kinded'],
  ]);
});

test('houseSupport: no factory configured is not an outage; a factory without a client is', () => {
  assert.deepEqual(houseSupport([]), { discover: null, readEpoch: null, readUnderlying: null, unavailable: null });
  assert.match(String(houseSupport([{ address: LEGACY, kind: 'legacy-weekly' }]).unavailable), /no RPC client/);
});

test('legacyWeeklyWindingDown: a legacy weekly vault winds down only once a kinded (daily) factory is configured', () => {
  const legacyOnly = [{ address: LEGACY, kind: 'legacy-weekly' as const }];
  const both = [...legacyOnly, { address: KINDED, kind: 'kinded' as const }];
  // Before the daily deploy: the weekly vaults keep quoting exactly as today.
  assert.equal(legacyWeeklyWindingDown('legacy-weekly', legacyOnly), false);
  // After it: the legacy factory's vaults close only.
  assert.equal(legacyWeeklyWindingDown('legacy-weekly', both), true);
  // The kinded factory's own vaults (daily, or a weekly) are never wound down by this rule.
  assert.equal(legacyWeeklyWindingDown('kinded', both), false);
  // An untagged factory is not "daily": it neither triggers the wind-down nor is wound down (it is not quoted at all).
  assert.equal(legacyWeeklyWindingDown('legacy-weekly', [...legacyOnly, { address: KINDED, kind: 'unknown' as const }]), false);
  assert.equal(legacyWeeklyWindingDown('unknown', both), false);
  // Order does not matter, and no factories at all means nothing to wind down.
  assert.equal(legacyWeeklyWindingDown('legacy-weekly', [...both].reverse()), true);
  assert.equal(legacyWeeklyWindingDown('legacy-weekly', []), false);
});
