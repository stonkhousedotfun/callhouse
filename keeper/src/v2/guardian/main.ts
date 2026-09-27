/**
 * V2_MODE=guardian: the settlement guardian watch. GUARDIAN_PK is the guardian bot's key, which holds the
 * AccessManager's GUARDIAN role and nothing else. Every tick it
 * pages each uncorroborated settlement candidate and, with GUARDIAN_AUTO_VETO on (the default), vetoes one that is a
 * scale fault, or that came from a stale feed round the pool disagrees with (planner.ts), before it finalizes.
 *
 *
 * WHAT THE KEY CAN DO. GUARDIAN has no execution delay. On the SettlementOracle it can `veto` and `unveto`. Elsewhere
 * it holds the pauses, and the HouseVault limits too (callhouse-contracts script/v2/roles.v8.json).
 * This mode sends `veto` only. Through this contract, a compromised key could Hold every uncorroborated
 * expiry, and adminResolve (CONFIG_ADMIN, from expiry + 48 h) settles those. It cannot choose a price.
 *
 * BOOT REFUSES ANY OTHER KEY. Before the loop, the AccessManager is asked `canCall(signer, oracle, veto)`. Anything but
 * an immediate yes stops the boot: a key without GUARDIAN (the cranker's, say), or one whose calls must be scheduled.
 * A watch that cannot veto would page scale faults while reporting healthy, with nothing behind the page.
 *
 * AFTER THE LOCK. The one-transaction lock revokes the
 * guardian key's GUARDIAN: from then on ONLY the Admin Safe can veto or pause. That is the planned end state, not a
 * wrong key, so it must not crash-loop the service or page as a fault. It is told apart by the chain, not by a flag:
 * the signer IS the registry's `v2.bots.guardian`, the AccessManager says it cannot call `veto` (no delay either), AND
 * it says the registry's Admin Safe (`shared.safes.admin`) can, at once. Then the mode boots WATCH-ONLY: it logs once
 * that pausing and vetoing are the Admin Safe's, finds and pages every candidate as before, sends nothing, and each page
 * that would have vetoed names the Admin Safe (watch.ts). Any other key without GUARDIAN is still refused.
 */
import { toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';
import { accessManagerAbi } from '../abi/accessManager.js';
import type { GuardianConfig } from '../config.js';
import type { RunningMode } from '../mode.js';
import { createModeRuntime, runSigningMode, type ModeRuntime, type RuntimeSeams } from '../runtime.js';
import { GuardianWatch, viemGuardianChain, type GuardianChain } from './watch.js';

/** SettlementOracle.veto(address,uint40): derived from the signature, never pasted as hex. */
export const VETO_SELECTOR: Hex = toFunctionSelector('veto(address,uint40)');

export class GuardianRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardianRoleError';
  }
}

/** `canCall(caller, target, selector)` on the AccessManager: (immediate, delay seconds). */
export type CanCall = (caller: Address, target: Address, selector: Hex) => Promise<readonly [boolean, number]>;

export function viemCanCall(client: Pick<PublicClient, 'readContract'>, accessManager: Address): CanCall {
  return async (caller, target, selector) => {
    const [immediate, delay] = (await client.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: 'canCall',
      args: [caller, target, selector],
    } as never)) as readonly [boolean, number | bigint];
    return [immediate, Number(delay)] as const;
  };
}

/** Who vetoes for this mode: the guardian key itself, or (after the lock) the Admin Safe, the mode watch-only. */
export type GuardianRole = { vetoBy: 'key' } | { vetoBy: 'admin-safe'; adminSafe: Address };

/**
 * The boot check. An immediate GUARDIAN: `key`. The post-lock state (above): `admin-safe`. Anything else throws
 * GuardianRoleError, by name: a scheduled GUARDIAN, or a key without it that is not the registry's guardian key after
 * the lock (the message says which of the three conditions failed).
 */
export async function resolveGuardianRole(
  canCall: CanCall,
  signer: Address,
  oracle: Address,
  keyEnv: string,
  registry: { adminSafe?: Address | null; guardianBot?: Address | null },
): Promise<GuardianRole> {
  const [immediate, delay] = await canCall(signer, oracle, VETO_SELECTOR);
  if (immediate) return { vetoBy: 'key' };
  if (delay > 0) {
    throw new GuardianRoleError(`${keyEnv} ${signer} may call veto on ${oracle} only after a ${delay} s schedule; the guardian watch needs GUARDIAN with no delay`);
  }
  const bot = registry.guardianBot ?? null;
  const safe = registry.adminSafe ?? null;
  const isBot = bot !== null && bot.toLowerCase() === signer.toLowerCase();
  const safeCan = isBot && safe !== null ? (await canCall(safe, oracle, VETO_SELECTOR))[0] : false;
  if (isBot && safe !== null && safeCan) return { vetoBy: 'admin-safe', adminSafe: safe };
  const why = !isBot
    ? `it is not the registry's guardian key v2.bots.guardian (${bot ?? 'not named'})`
    : safe === null
      ? 'the registry names no Admin Safe (shared.safes.admin)'
      : `the Admin Safe ${safe} cannot call veto at once either`;
  throw new GuardianRoleError(
    `${keyEnv} ${signer} is not a GUARDIAN on ${oracle}: V2_MODE=guardian runs under the guardian key only. After the lock (owner R4) it runs watch-only, but not here: ${why}`,
  );
}

export interface GuardianSeams extends RuntimeSeams {
  /** Replaces the chain reads and logs (tests). */
  guardianChain?: GuardianChain;
  /** Replaces the AccessManager read of the boot check (tests). */
  canCall?: CanCall;
}

export function createGuardianWatch(runtime: ModeRuntime<GuardianConfig>, seams: GuardianSeams = {}, role: GuardianRole = { vetoBy: 'key' }): GuardianWatch {
  const { config } = runtime;
  const oracle = config.contracts.settlementOracle;
  return new GuardianWatch({
    chain: seams.guardianChain ?? viemGuardianChain(runtime.clients.publicClient, runtime.clients.logClient, oracle),
    sender: runtime.sender,
    alerter: runtime.alerter,
    log: runtime.log.child({ mod: 'guardian' }),
    oracle,
    fromBlock: config.registry.deployBlock ?? 0n,
    chunkBlocks: config.tuning.logChunkBlocks,
    chunksPerTick: config.tuning.logChunksPerTick,
    thresholds: {
      scaleFactor: config.tuning.scaleFactor,
      autoVeto: config.tuning.autoVeto,
      staleRoundAfterS: config.tuning.feedHeartbeatS + config.tuning.feedStaleMarginS,
    },
    adminSafe: role.vetoBy === 'admin-safe' ? role.adminSafe : null,
  });
}

export async function startGuardian(config: GuardianConfig, seams: GuardianSeams = {}): Promise<RunningMode> {
  const runtime = createModeRuntime(config, seams);
  const canCall = seams.canCall ?? viemCanCall(runtime.clients.publicClient, config.contracts.accessManager);
  let role: GuardianRole;
  try {
    role = await resolveGuardianRole(canCall, runtime.signer.account.address, config.contracts.settlementOracle, config.keyEnv, config.registry);
  } catch (error) {
    runtime.store.close();
    throw error;
  }
  if (role.vetoBy === 'admin-safe') {
    runtime.log.info(
      { mod: 'guardian', adminSafe: role.adminSafe, signer: runtime.signer.account.address },
      `the guardian key holds no GUARDIAN: the lock is done (owner R4) and pausing and vetoing are the Admin Safe ${role.adminSafe}'s. Watching and paging only; nothing is sent`,
    );
  }
  const watch = createGuardianWatch(runtime, seams, role);
  return runSigningMode(runtime, {
    tick: async () => {
      await watch.tick();
    },
    state: () => (watch.ticks === 0 ? null : { ...watch.state(), vetoBy: role.vetoBy === 'admin-safe' ? `Admin Safe ${role.adminSafe}` : 'guardian key' }),
  });
}
