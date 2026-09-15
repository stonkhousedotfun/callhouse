import { isAddress, type Address } from "viem";

/**
 * Vault settings the constructor sets WITHOUT an event. Pure: no Ponder, no database.
 *
 * `Vault`'s constructor assigns `feeRecipient`, `depositCap` and `policy` (from
 * `Policy.launchDefaults()`) directly. `FeeRecipientUpdated`, `DepositCapUpdated` and
 * `PolicyUpdated` fire only on later governance calls, so an index built from events alone
 * published `protocolFeeBps: 0`, `feeRecipient: null` and `depositCap: 0` for a vault charging
 * 5% to a real recipient under a 50-token cap — found by the X-11 fork sync. (`maxPriceAge` is
 * set through `_setMaxPriceAge`, which does emit, and needs nothing here.)
 *
 * The `Vault:setup` handler reads the three views at START_BLOCK and patches whatever answered;
 * a later governance event then overwrites them as before. A view that did not answer (START_BLOCK
 * before the deployment, an RPC failure) is left at the schema default rather than guessed.
 */

/** `Vault.policy()` as viem decodes it: minOtm, maxOtm, minPremium, maxUtilization, protocolFeeBps, maxContractsCap. */
export type PolicyTuple = readonly [number, number, number, number, number, bigint];

export type ConstructorReads = {
  policy: PolicyTuple | null;
  feeRecipient: Address | null;
  depositCap: bigint | null;
};

export type ConstructorSettings = {
  protocolFeeBps?: number;
  feeRecipient?: Address;
  depositCap?: bigint;
};

const ZERO = "0x0000000000000000000000000000000000000000";

export function constructorSettings(reads: ConstructorReads): ConstructorSettings {
  const out: ConstructorSettings = {};
  if (reads.policy !== null) out.protocolFeeBps = Number(reads.policy[4]);
  // The constructor reverts on a zero recipient, so a zero answer is not a setting: it is a
  // read against an address with no vault at that block.
  if (reads.feeRecipient !== null && isAddress(reads.feeRecipient) && reads.feeRecipient.toLowerCase() !== ZERO) {
    out.feeRecipient = reads.feeRecipient;
  }
  if (reads.depositCap !== null) out.depositCap = reads.depositCap;
  return out;
}

/*//////////////////////////////////////////////////////////////
                              WIRING
//////////////////////////////////////////////////////////////*/

/**
 * The four contracts the vault was constructed against, as its immutable views name them, next to
 * the addresses this process was configured with. Pure, like everything above.
 *
 * WHY THE INDEXER REFUSES A MISMATCH. The Clear is a deploy-time choice (decision D16: the
 * upstream build, or our own `DeployClear.s.sol` instance), and so, on a fork or a rehearsal, are
 * Seaport and the two tokens. Every Ponder source is an address from lib/env.ts, and two handlers
 * filter on them: `Seaport:OrderFulfilled` counts only offer items whose token equals
 * CLEARINGHOUSE, and the token handlers track balances on USDG and ASSET. With the default
 * CLEARINGHOUSE left in place on a vault built over a different Clear, every fill would count 0
 * contracts, the Clear source would watch a contract the vault never touches, and
 * `/v1/vault.phase.clearFeesEnabled` would report the wrong switch, with nothing louder than a
 * warning at each close. The keeper refuses to boot on the same mismatch (keeper/src/roll.ts
 * `assertWiring`); the indexer is a separate service with separate env, so it checks for itself.
 *
 * A view that did not answer (START_BLOCK before the deployment, an RPC failure) is not a
 * mismatch: it is reported as unverified and checked again at the first `RollOpen`, when the
 * vault demonstrably exists.
 */
export type WiringReads = {
  clear: Address | null;
  seaport: Address | null;
  usdg: Address | null;
  asset: Address | null;
};

export type WiringEnv = {
  CLEARINGHOUSE: Address;
  SEAPORT: Address;
  USDG: Address;
  ASSET: Address;
};

export type WiringCheck = {
  /** One line per view that answered with a different address than the env var names. */
  mismatches: string[];
  /** Views that did not answer, so could not be compared. */
  unverified: Array<keyof WiringReads>;
};

const WIRING: ReadonlyArray<readonly [keyof WiringReads, keyof WiringEnv]> = [
  ["clear", "CLEARINGHOUSE"],
  ["seaport", "SEAPORT"],
  ["usdg", "USDG"],
  ["asset", "ASSET"],
];

export function checkWiring(reads: WiringReads, env: WiringEnv): WiringCheck {
  const mismatches: string[] = [];
  const unverified: Array<keyof WiringReads> = [];
  for (const [view, name] of WIRING) {
    const onChain = reads[view];
    if (onChain === null || !isAddress(onChain)) {
      unverified.push(view);
      continue;
    }
    if (onChain.toLowerCase() !== env[name].toLowerCase()) {
      mismatches.push(`${name}=${env[name]} but vault.${view}() = ${onChain}`);
    }
  }
  return { mismatches, unverified };
}

/** The error the handlers throw on a mismatch: every wrong address in one message, and the fix. */
export function wiringError(vault: Address, mismatches: readonly string[]): Error {
  return new Error(
    `[callhouse/indexer] vault ${vault} was not built against the contracts this indexer is configured for: ` +
      `${mismatches.join("; ")}. Set each env var to the address the vault's own view names ` +
      `(ops/addresses.json records the deployment) and re-sync from START_BLOCK.`,
  );
}
