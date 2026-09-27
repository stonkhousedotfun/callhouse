/**
 * House vault discovery and the epoch read behind it.
 *
 * WHAT THIS FILE IS FOR. A House vault is not a second treasury MakerVault: it runs in epochs, and
 * the plan may only open risk that expires inside the current one (mm/epoch.ts). Both facts come off
 * the chain - the vault's own `epochEnd` and `epochId` - and the enumeration of which House vaults
 * exist comes off the factory. This file is the seam where those two chain reads enter the runtime.
 *
 * WHY THE SEAM IS EMPTY TODAY - BLOCKED ON THE ABI EXPORT, NOT FORGOTTEN.
 * `ops/abis/v2` publishes 30 artifacts and the only vault among them is `MakerVault.json`, whose
 * function list has no epoch surface at all. The contracts DO exist - callhouse-contracts
 * `src/v2/periphery/house/HouseVault.sol` and `HouseVaultFactory.sol` - they are simply not named in
 * `script/v2/abi-manifest.txt`, and `export-abis.sh` removes what the manifest does not name. That is
 * The gap, the same one that leaves the splitter, router and buyback executor as I-prefixed
 * interfaces. `keeper/scripts/gen-abis.mjs:1-11` says the keeper has NO hand-written v2 ABIs, so the
 * answer here is to WAIT for the artifact, not to transcribe one.
 *
 * WHEN THE EXPORT LANDS, the whole change is:
 *   1. `abi-manifest.txt` names HouseVault and HouseVaultFactory; `export-abis.sh` writes them.
 *   2. `V2_MODULES` in gen-abis.mjs gains `houseVault` and `houseVaultFactory` (all THREE copies -
 *      keeper, indexer, web - are byte-identical by rule, so all three change together).
 *   3. `chainHouseDiscovery` / `chainEpochReader` below stop returning the unavailable marker and
 *      call `vaults()` and `epochEnd()` / `epochId()`.
 * Everything downstream of this file - selection, wind-down, the unflat alert, /state - is already
 * written and tested against an injected reader.
 *
 * THE FAIL-CLOSED RULE, which is the part that matters if this is read in a hurry:
 * a House vault whose epoch cannot be READ IS NOT QUOTED. It is never quoted with `epoch: null`,
 * because `null` means "treasury MakerVault: unrestricted" to every consumer (mm/epoch.ts), so the
 * fallback would turn a missing read into permission to open unbounded risk in a vault that has to
 * be flat by `epochEnd`. A configured factory the bot cannot enumerate is reported every tick
 * (`v2_mm_house_unavailable`) rather than being silently equivalent to "no House vaults".
 *
 * Getter names below are MIRRORED from HouseVault.sol / HouseVaultFactory.sol,
 * not remembered: `epochEnd` (uint40 public, HouseVault.sol), `epochId` (uint64 public,
 * HouseVault.sol), `quotingPaused` (HouseVault.sol), and `vaults()` (HouseVaultFactory.sol).
 */
import { getAddress, type Address, type PublicClient } from 'viem';

import { houseVaultAbi } from '../abi/houseVault.js';
import { houseVaultFactoryAbi } from '../abi/houseVaultFactory.js';
import type { HouseFactoryEntry, HouseFactoryKind } from '../config.js';
import type { EpochKind, EpochView } from './epoch.js';

/** Why the House path is unavailable, or null when it works. One string, used in the alert and in /state. */
export type HouseUnavailable = string | null;

/**
 * Was false while `ops/abis/v2` published no HouseVault.json / HouseVaultFactory.json. Both artifacts
 * are published now and gen-abis renders both modules, which this file imports at the top -- so if they
 * were missing again this would not compile rather than silently degrade. The flag stays because the
 * `unavailable` path below is still the thing callers branch on, and keeping one named constant is
 * clearer than a bare `true` nobody can search for.
 */
export const HOUSE_ABI_AVAILABLE = true;

/**
 * Why the House path is unavailable when no reader is wired.
 *
 * THIS STRING USED TO BLAME THE MANIFEST and it was correct when written: `script/v2/abi-manifest.txt` did not
 * name the House contracts, so nothing could be exported or generated. A change added all eight periphery names and
 * a change re-exported, so the manifest and `ops/abis/v2` are both right now, and `keeper/src/v2/abi/houseVault.ts`
 * exists. Sending an operator to go fix a file that is already correct is its own small outage, so the reason
 * now says what is actually true: no reader is wired into this process.
 */
export const HOUSE_ABI_MISSING =
  'no House vault reader is wired into this process (mm/house.ts houseSupport returned no discover/readEpoch), ' +
  'so there is nothing to call epochEnd()/epochId()/vaults() with. The ABIs themselves are published: ' +
  'ops/abis/v2 carries HouseVault.json and HouseVaultFactory.json since T-159/T-163, and the keeper module ' +
  'keeper/src/v2/abi/houseVault.ts is generated from them';

/** One House vault as enumerated: the vault, the factory that listed it, and that factory's kind rule. */
export interface DiscoveredHouseVault {
  vault: Address;
  factory: Address;
  factoryKind: HouseFactoryKind;
}

/** Enumerates the House vaults of every configured factory at a block. */
export type HouseDiscovery = (blockNumber: bigint) => Promise<readonly DiscoveredHouseVault[]>;

/**
 * Reads one House vault's epoch AND kind at a block. Null when the vault has no epoch surface or its kind cannot be
 * established; the caller then does not quote it.
 */
export type EpochReader = (found: DiscoveredHouseVault, blockNumber: bigint) => Promise<EpochView | null>;

/**
 * Reads the one Stock Token a House vault trades: `HouseVault.underlying()` (an immutable, HouseVault.sol ~:225).
 * Null when it cannot be read; the caller then does not quote the vault, and never falls back to every market.
 */
export type UnderlyingReader = (vault: Address, blockNumber: bigint) => Promise<Address | null>;

/**
 * The epoch kind of a House vault, decided by the factory that enumerated it -- never by trying the call and
 * reading a revert as "legacy".
 *
 *   legacy-weekly  'weekly', and `readWeekly` is NOT called. The legacy vaults have no `weekly()` getter: the
 *                  call reverts with empty data on both live launch vaults (chain 4663,
 *                  measured live). Asking would turn every live House vault into "kind unreadable, not quoted".
 *   kinded         the vault's immutable `weekly()`: true -> 'weekly', false -> 'daily'. A failed read -> null.
 *   unknown        null, and `readWeekly` is not called: an untagged factory's rule is not known, so neither answer
 *                  may be guessed (config.ts HouseFactoryKind).
 *
 * Why a revert is not taken as "legacy": a kinded vault whose read fails on a flaky RPC would then be quoted as weekly,
 * with the weekly wind-down, on a daily boundary it knows nothing about. Deciding by factory makes that impossible.
 */
export async function readEpochKind(factoryKind: HouseFactoryKind, readWeekly: () => Promise<boolean>): Promise<EpochKind | null> {
  if (factoryKind === 'legacy-weekly') return 'weekly';
  if (factoryKind !== 'kinded') return null;
  try {
    return (await readWeekly()) ? 'weekly' : 'daily';
  } catch {
    return null;
  }
}

export interface HouseSupport {
  /** Enumeration, or null when unavailable. */
  discover: HouseDiscovery | null;
  /** Epoch read, or null when unavailable. */
  readEpoch: EpochReader | null;
  /**
   * The vault's underlying, or null when unavailable. A House vault quotes only its own market's series, so a
   * vault this cannot read is not quoted (quoter.ts vaultTargets).
   */
  readUnderlying: UnderlyingReader | null;
  /** Null when both work; otherwise the reason, verbatim, for the alert. */
  unavailable: HouseUnavailable;
}

/**
 * The support the runtime gets for a configured factory.
 *
 * `injected` exists so the epoch path is exercised by the tests today: the runtime wiring is real and
 * proven, and only the two chain calls are still to come.
 */
/**
 * `HouseVaultFactory.vaults()` of every configured factory at a block, in configuration order. Both factory
 * generations expose `vaults()` with the same signature. One factory that cannot be enumerated fails the whole call,
 * so the House path is reported unavailable rather than quoting a partial set that looks complete.
 */
const chainHouseDiscovery =
  (client: PublicClient, factories: readonly HouseFactoryEntry[]): HouseDiscovery =>
  async (blockNumber) => {
    const out: DiscoveredHouseVault[] = [];
    for (const f of factories) {
      const vaults = (await client.readContract({ address: f.address, abi: houseVaultFactoryAbi, functionName: 'vaults', blockNumber })) as readonly Address[];
      for (const vault of vaults) out.push({ vault, factory: f.address, factoryKind: f.kind });
    }
    return out;
  };

/**
 * `HouseVault.epochEnd()` and `epochId()` at a block, mirrored from HouseVault.sol:191 and :193.
 *
 * RETURNS NULL RATHER THAN THROWING, AND THAT IS THE FAIL-CLOSED HINGE. The caller treats null as
 * "this vault is NOT quoted" (quoter.vaultTargets), which is the only safe reading: quoting it with
 * `epoch: null` would mean "treasury MakerVault, no epoch discipline" to mm/epoch.ts and would be
 * permission to open risk past `epochEnd` in the one kind of vault that must be flat for `rollEpoch`.
 * So a reverting getter, a vault that is not really a HouseVault, or an RPC failure all end in the
 * same place: skipped and alerted, never quoted as unrestricted.
 *
 * `rollDue` is a placeholder here: the caller recomputes it from the head's own timestamp so it cannot
 * be stale or invented (see the note on rollDue below).
 */
const chainEpochReader =
  (client: PublicClient): EpochReader =>
  async (found, blockNumber) => {
    const { vault } = found;
    const kind = await readEpochKind(found.factoryKind, async () =>
      (await client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'weekly', blockNumber })) as boolean,
    );
    if (kind === null) return null;
    try {
      const [epochEnd, index] = await Promise.all([
        client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochEnd', blockNumber }),
        client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochId', blockNumber }),
      ]);
      return { epochEnd: Number(epochEnd), index: index as bigint, rollDue: false, kind };
    } catch {
      return null;
    }
  };

/** `HouseVault.underlying()`, checksummed; a revert or an RPC failure is null (not quoted). */
const chainUnderlyingReader =
  (client: PublicClient): UnderlyingReader =>
  async (vault, blockNumber) => {
    try {
      return getAddress((await client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'underlying', blockNumber })) as string);
    } catch {
      return null;
    }
  };

export function houseSupport(factories: readonly HouseFactoryEntry[], injected?: Partial<HouseSupport>, client?: PublicClient): HouseSupport {
  if (injected?.discover != null || injected?.readEpoch != null) {
    return { discover: injected.discover ?? null, readEpoch: injected.readEpoch ?? null, readUnderlying: injected.readUnderlying ?? null, unavailable: injected.unavailable ?? null };
  }
  if (factories.length === 0) return { discover: null, readEpoch: null, readUnderlying: null, unavailable: null };
  const named = factories.map((f) => f.address).join(', ');
  if (!HOUSE_ABI_AVAILABLE) {
    return { discover: null, readEpoch: null, readUnderlying: null, unavailable: `MM_HOUSE_FACTORY is set to ${named} but ${HOUSE_ABI_MISSING}` };
  }
  if (client === undefined) {
    // Fail closed rather than quote without epoch discipline: no client means no read, not "no epochs".
    return { discover: null, readEpoch: null, readUnderlying: null, unavailable: `MM_HOUSE_FACTORY is set to ${named} but houseSupport got no RPC client` };
  }
  return { discover: chainHouseDiscovery(client, factories), readEpoch: chainEpochReader(client), readUnderlying: chainUnderlyingReader(client), unavailable: null };
}

/**
 * (wind the weekly House vaults down once the daily vaults are live).
 *
 * True when a vault of THIS factory must only close, never open: the factory is the legacy weekly one and at least one
 * `kinded` (daily-capable) factory is configured beside it. The kinded factory being configured IS the signal
 * that the daily vaults are live -- the registry tags `daily` factories `kinded` (config.ts houseFactoriesFromRegistry)
 * and an operator adds one to MM_HOUSE_FACTORY only for the daily deploy -- so no separate switch exists
 * that could be left off while the daily vaults quote, or left on while they do not.
 *
 * The legacy factory is NOT removed from the list, and must not be: the cranker reads the same list (config.ts, the
 * CRANKER_HOUSE_FACTORY fallback) and keeps rolling and settling its vaults until the last epoch closes, and the bot
 * still needs the vault in view to cancel and close what it already rests there. Pure.
 */
export function legacyWeeklyWindingDown(factoryKind: HouseFactoryKind, factories: readonly HouseFactoryEntry[]): boolean {
  return factoryKind === 'legacy-weekly' && factories.some((f) => f.kind === 'kinded');
}

/**
 * `rollEpoch` is due once the chain's own head timestamp has reached the vault's `epochEnd`.
 * BOTH sides are chain values: `epochEnd` is read from the vault and `now` is the head's timestamp.
 * Nothing here consults a local clock, a weekday or an assumed epoch length.
 */
export function rollDue(epochEnd: number, nowFromHead: number): boolean {
  return nowFromHead >= epochEnd;
}
