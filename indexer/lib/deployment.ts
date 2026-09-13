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
