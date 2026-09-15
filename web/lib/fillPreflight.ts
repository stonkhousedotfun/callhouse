import type { Hex } from "viem";

import { SEAPORT_PRE_HOOK_ERRORS, SEAPORT_TRANSFER_ERRORS } from "./abi/seaport";
import { decodeRevertData, type DecodedRevert } from "./revert";

/**
 * What a simulated fill (an `eth_call` of Seaport.fulfillAdvancedOrder) means for the buyer.
 *
 * WHY THIS EXISTS. Under write on fill nothing is written until a buyer fills, and the vault's
 * `authorizeOrder` re-runs its gate at fill time against TODAY's spot: the band floor, the premium
 * floor with Valorem's fee valued at spot, the size on the cycle's total, the clock, the halt, the
 * oracle, the reserve. A listing that was fine on Monday can be refused on Friday after a rally
 * (PremiumBelowFloorAtFill, StrikeBelowBand), and a buyer who only learns that from a reverted
 * transaction has paid gas and approved USDG for nothing. So the page simulates the exact fill it
 * would send, from the buyer's address, before the button is live, and this file says what the
 * result means.
 *
 * SEAPORT'S ORDER OF OPERATIONS is what makes the classification honest. For a restricted order
 * Seaport 1.6 validates the order (time, cancellation, fraction, signature or on-chain
 * validation), then calls the zone's `authorizeOrder`, then moves the tokens (the option out of
 * the vault, the USDG out of the buyer), then calls `validateOrder`. A revert inside the zone or
 * inside a token is bubbled up by Seaport with its data intact. So:
 *   - a VAULT error means the hook refused: the fill is not possible right now, whatever the buyer
 *     does. Blocked, with the vault's own reason. Two names in the vault's ABI are the exception:
 *     OpenZeppelin's `ERC20InsufficientAllowance` / `ERC20InsufficientBalance` are there because
 *     the vault IS an ERC-20 (its shares), but no share moves during a fill and the vault never
 *     calls its own transfer path from the hook, so through a fill they can only be a token's, and
 *     a token that reverts with them does so at the TRANSFER step, after the hook. Buyer-side.
 *   - a Seaport error from BEFORE the hook (SEAPORT_PRE_HOOK_ERRORS) means the order itself is not
 *     fillable: cancelled, out of time, a bad fraction. Blocked, with Seaport's reason.
 *   - a Seaport error from the TRANSFER step (SEAPORT_TRANSFER_ERRORS), or a plain
 *     `Error(string)` from a token, means the hook has already passed and a token would not move.
 *     For a buyer that is the USDG approval or balance: the fill is allowed, and the approve step
 *     the page runs first is what fixes it.
 *   - USDG's own `InsufficientAllowance` / `InsufficientFunds` (lib/abi/erc20.ts usdgErrorsAbi)
 *     are the same thing said by the real token on this chain: buyer-side, allowed. USDG's
 *     `ContractPaused` / `AddressFrozen` are not the buyer's to fix and not the vault's refusal:
 *     the stablecoin will not move for anyone in this transfer. Blocked, as a token refusal.
 *   - `InvalidRestrictedOrder` is Seaport saying the zone reverted with no data: a vault refusal
 *     whose reason was lost. Blocked.
 *   - anything else (no revert data, an unknown selector, a panic) is inconclusive: the page says
 *     so and lets the wallet try, because refusing on a guess would be a false statement about
 *     the vault. An unknown selector cannot be the vault's (its merged ABI is complete) but it
 *     can be the clearinghouse's or the Stock Token's from INSIDE the hook, so it proves nothing
 *     about which side of the hook the revert came from.
 *
 * DELIBERATELY ABSENT: the RPC call. The page makes it (wagmi's public client) and hands the
 * outcome here, so vitest covers every branch with encoded revert data and no node.
 */

export type FillSimulation = { ok: true } | { ok: false; revertData?: Hex; message?: string };

export type PreflightVerdict =
  | { kind: "ok" }
  /** The vault's fill hook refused. `decoded` names why. Blocked. */
  | { kind: "vaultRefused"; decoded: DecodedRevert }
  /** Seaport refused before the hook ran: the order is not fillable as asked. Blocked. */
  | { kind: "seaportRefused"; decoded: DecodedRevert }
  /** USDG will not move for anyone in this transfer (paused, or an address frozen). Blocked. */
  | { kind: "tokenRefused"; decoded: DecodedRevert }
  /** The hook passed; a token transfer failed. The buyer's approval or balance. Allowed. */
  | { kind: "buyerSide"; decoded: DecodedRevert }
  /** Nothing can be said about the vault from this result. Allowed, with a warning. */
  | { kind: "inconclusive"; text: string };

/** OpenZeppelin's two ERC-20 shortfall errors: in the vault's ABI, but a token's through a fill. */
const TOKEN_SHORTFALL_IN_VAULT_ABI = new Set(["ERC20InsufficientAllowance", "ERC20InsufficientBalance"]);
/** USDG's own shortfall errors: the buyer's approval or balance. */
const USDG_SHORTFALL = new Set(["InsufficientAllowance", "InsufficientFunds"]);
/** USDG's issuer actions: nobody's USDG moves in this transfer. */
const USDG_REFUSAL = new Set(["ContractPaused", "AddressFrozen"]);

export function classifyFillSimulation(sim: FillSimulation, decode: (data: Hex | undefined) => DecodedRevert | undefined = decodeRevertData): PreflightVerdict {
  if (sim.ok) return { kind: "ok" };
  const decoded = decode(sim.revertData);
  if (decoded === undefined) {
    return { kind: "inconclusive", text: sim.message?.trim() || "The simulation failed without a revert reason." };
  }
  if (decoded.source === "vault") {
    if (decoded.name !== undefined && TOKEN_SHORTFALL_IN_VAULT_ABI.has(decoded.name)) return { kind: "buyerSide", decoded };
    return { kind: "vaultRefused", decoded };
  }
  if (decoded.source === "seaport") {
    if (decoded.name !== undefined && SEAPORT_TRANSFER_ERRORS.has(decoded.name)) return { kind: "buyerSide", decoded };
    if (decoded.name === "InvalidRestrictedOrder") return { kind: "vaultRefused", decoded };
    if (decoded.name !== undefined && SEAPORT_PRE_HOOK_ERRORS.has(decoded.name)) return { kind: "seaportRefused", decoded };
    return { kind: "inconclusive", text: decoded.text };
  }
  if (decoded.source === "token") {
    if (decoded.name !== undefined && USDG_SHORTFALL.has(decoded.name)) return { kind: "buyerSide", decoded };
    if (decoded.name !== undefined && USDG_REFUSAL.has(decoded.name)) return { kind: "tokenRefused", decoded };
    return { kind: "inconclusive", text: decoded.text };
  }
  // A token's own `Error(string)` surfaces through Seaport's transfer step, after the hook.
  if (decoded.source === "solidity" && decoded.name === "Error") return { kind: "buyerSide", decoded };
  return { kind: "inconclusive", text: decoded.text };
}

/** Whether the page may enable the fill button on this verdict. */
export function preflightAllowsFill(verdict: PreflightVerdict | undefined): boolean {
  return verdict === undefined || verdict.kind === "ok" || verdict.kind === "buyerSide" || verdict.kind === "inconclusive";
}

/**
 * Gas a fill needs. The contracts' fork suite measured a first fill (which opens the cycle's
 * Valorem claim inside the hook) at 386k and a top-up at 156k on the live Seaport 1.6 and Clear
 * of chain 4663 (HANDOFF-2026-09-14 §4); the redesign report's spike figures were 470k and 245k.
 * The ranges cover both readings; both are re-measured on the live week. The simulation runs
 * with SIMULATION_GAS, well above the highest reading, so a genuine first fill is never mistaken
 * for an out-of-gas.
 */
export const FILL_GAS = {
  firstFill: { low: 380_000, high: 500_000 },
  topUp: { low: 150_000, high: 250_000 },
} as const;

export const SIMULATION_GAS = 800_000n;

/** The sentence under the fill button. `firstFill` is true while the cycle's claim does not exist yet. */
export function fillGasSentence(firstFill: boolean): string {
  const g = firstFill ? FILL_GAS.firstFill : FILL_GAS.topUp;
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return firstFill
    ? `Expect roughly ${k(g.low)}–${k(g.high)} gas: this is the first fill of the cycle, so the vault opens its Valorem claim inside your transaction. Later fills cost about ${k(FILL_GAS.topUp.low)}–${k(FILL_GAS.topUp.high)}.`
    : `Expect roughly ${k(g.low)}–${k(g.high)} gas: the vault tops up this cycle's Valorem claim inside your transaction.`;
}
