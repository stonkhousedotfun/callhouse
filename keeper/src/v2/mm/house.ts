/**
 * House vault discovery and the epoch read behind it (K8-05 / T-124).
 *
 * WHAT THIS FILE IS FOR. A House vault is not a second treasury MakerVault: it runs in epochs, and
 * the plan may only open risk that expires inside the current one (mm/epoch.ts). Both facts come off
 * the chain - the vault's own `epochEnd` and `epochId` - and the enumeration of which House vaults
 * exist comes off the factory. This file is the seam where those two chain reads enter the runtime.
 *
 * WHY THE SEAM IS EMPTY TODAY - BLOCKED ON T-78, NOT FORGOTTEN.
 * `ops/abis/v2` publishes 30 artifacts and the only vault among them is `MakerVault.json`, whose
 * function list has no epoch surface at all. The contracts DO exist - callhouse-contracts
 * `src/v2/periphery/house/HouseVault.sol` and `HouseVaultFactory.sol` - they are simply not named in
 * `script/v2/abi-manifest.txt`, and `export-abis.sh` removes what the manifest does not name. That is
 * T-78's gap, the same one that leaves the splitter, router and buyback executor as I-prefixed
 * interfaces. `keeper/scripts/gen-abis.mjs:1-11` says the keeper has NO hand-written v2 ABIs, so the
 * answer here is to WAIT for the artifact, not to transcribe one.
 *
 * WHEN T-78 LANDS, the whole change is:
 *   1. `abi-manifest.txt` names HouseVault and HouseVaultFactory; `export-abis.sh` writes them.
 *   2. `V2_MODULES` in gen-abis.mjs gains `houseVault` and `houseVaultFactory` (all THREE copies -
 *      keeper, indexer, web - are byte-identical by rule; only the keeper copy is this lane's).
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
 * Getter names below are MIRRORED from HouseVault.sol / HouseVaultFactory.sol at wt/v8-contracts
 * 62e43250, not remembered: `epochEnd` (uint40 public, HouseVault.sol:191), `epochId` (uint64 public,
 * :193), `quotingPaused` (:203), and `vaults()` (HouseVaultFactory.sol:90).
 */
import type { Address, PublicClient } from 'viem';

import { houseVaultAbi } from '../abi/houseVault.js';
import { houseVaultFactoryAbi } from '../abi/houseVaultFactory.js';
import type { EpochView } from './epoch.js';

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
 * name the House contracts, so nothing could be exported or generated. T-159 added all eight periphery names and
 * T-163 re-exported, so the manifest and `ops/abis/v2` are both right now, and `keeper/src/v2/abi/houseVault.ts`
 * exists. Sending an operator to go fix a file that is already correct is its own small outage, so the reason
 * now says what is actually true: no reader is wired into this process.
 */
export const HOUSE_ABI_MISSING =
  'no House vault reader is wired into this process (mm/house.ts houseSupport returned no discover/readEpoch), ' +
  'so there is nothing to call epochEnd()/epochId()/vaults() with. The ABIs themselves are published: ' +
  'ops/abis/v2 carries HouseVault.json and HouseVaultFactory.json since T-159/T-163, and the keeper module ' +
  'keeper/src/v2/abi/houseVault.ts is generated from them';

/** Enumerates the House vaults of a factory at a block. */
export type HouseDiscovery = (blockNumber: bigint) => Promise<readonly Address[]>;

/** Reads one House vault's epoch at a block. Null when this vault has no epoch surface. */
export type EpochReader = (vault: Address, blockNumber: bigint) => Promise<EpochView | null>;

export interface HouseSupport {
  /** Enumeration, or null when unavailable. */
  discover: HouseDiscovery | null;
  /** Epoch read, or null when unavailable. */
  readEpoch: EpochReader | null;
  /** Null when both work; otherwise the reason, verbatim, for the alert. */
  unavailable: HouseUnavailable;
}

/**
 * The support the runtime gets for a configured factory.
 *
 * `injected` exists so the epoch path is exercised by the tests today: the runtime wiring is real and
 * proven, and only the two chain calls are waiting on T-78.
 */
/** `HouseVaultFactory.vaults()` at a block. Name mirrored from HouseVaultFactory.sol:90. */
const chainHouseDiscovery =
  (client: PublicClient, factory: Address): HouseDiscovery =>
  async (blockNumber) =>
    (await client.readContract({ address: factory, abi: houseVaultFactoryAbi, functionName: 'vaults', blockNumber })) as readonly Address[];

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
  async (vault, blockNumber) => {
    try {
      const [epochEnd, index] = await Promise.all([
        client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochEnd', blockNumber }),
        client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochId', blockNumber }),
      ]);
      return { epochEnd: Number(epochEnd), index: index as bigint, rollDue: false };
    } catch {
      return null;
    }
  };

export function houseSupport(factory: Address | null, injected?: Partial<HouseSupport>, client?: PublicClient): HouseSupport {
  if (injected?.discover != null || injected?.readEpoch != null) {
    return { discover: injected.discover ?? null, readEpoch: injected.readEpoch ?? null, unavailable: injected.unavailable ?? null };
  }
  if (factory === null) return { discover: null, readEpoch: null, unavailable: null };
  if (!HOUSE_ABI_AVAILABLE) {
    return { discover: null, readEpoch: null, unavailable: `MM_HOUSE_FACTORY is set to ${factory} but ${HOUSE_ABI_MISSING}` };
  }
  if (client === undefined) {
    // Fail closed rather than quote without epoch discipline: no client means no read, not "no epochs".
    return { discover: null, readEpoch: null, unavailable: `MM_HOUSE_FACTORY is set to ${factory} but houseSupport got no RPC client` };
  }
  return { discover: chainHouseDiscovery(client, factory), readEpoch: chainEpochReader(client), unavailable: null };
}

/**
 * `rollEpoch` is due once the chain's own head timestamp has reached the vault's `epochEnd`.
 * BOTH sides are chain values: `epochEnd` is read from the vault and `now` is the head's timestamp.
 * Nothing here consults a local clock, a weekday or an assumed epoch length.
 */
export function rollDue(epochEnd: number, nowFromHead: number): boolean {
  return nowFromHead >= epochEnd;
}
