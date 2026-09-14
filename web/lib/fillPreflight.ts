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
 * the vault, the USDG out of the buyer), then calls `validateOrder`. So:
 *   - a VAULT error means the hook refused: the fill is not possible right now, whatever the buyer
 *     does. Blocked, with the vault's own reason.
 *   - a Seaport error from BEFORE the hook (SEAPORT_PRE_HOOK_ERRORS) means the order itself is not
 *     fillable: cancelled, out of time, a bad fraction. Blocked, with Seaport's reason.
 *   - a Seaport error from the TRANSFER step (SEAPORT_TRANSFER_ERRORS), or a plain
 *     `Error(string)` from a token, means the hook has already passed and a token would not move.
 *     For a buyer that is the USDG approval or balance: the fill is allowed, and the approve step
 *     the page runs first is what fixes it.
 *   - `InvalidRestrictedOrder` is Seaport saying the zone reverted with no data: a vault refusal
 *     whose reason was lost. Blocked.
 *   - anything else (no revert data, an unknown selector, a panic) is inconclusive: the page says
 *     so and lets the wallet try, because refusing on a guess would be a false statement about
 *     the vault.
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
  /** The hook passed; a token transfer failed. The buyer's approval or balance. Allowed. */
  | { kind: "buyerSide"; decoded: DecodedRevert }
  /** Nothing can be said about the vault from this result. Allowed, with a warning. */
  | { kind: "inconclusive"; text: string };

export function classifyFillSimulation(sim: FillSimulation, decode: (data: Hex | undefined) => DecodedRevert | undefined = decodeRevertData): PreflightVerdict {
  if (sim.ok) return { kind: "ok" };
  const decoded = decode(sim.revertData);
  if (decoded === undefined) {
    return { kind: "inconclusive", text: sim.message?.trim() || "The simulation failed without a revert reason." };
  }
  if (decoded.source === "vault") return { kind: "vaultRefused", decoded };
  if (decoded.source === "seaport") {
    if (decoded.name !== undefined && SEAPORT_TRANSFER_ERRORS.has(decoded.name)) return { kind: "buyerSide", decoded };
    if (decoded.name === "InvalidRestrictedOrder") return { kind: "vaultRefused", decoded };
    if (decoded.name !== undefined && SEAPORT_PRE_HOOK_ERRORS.has(decoded.name)) return { kind: "seaportRefused", decoded };
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
 * Gas a fill needs, as the contracts repo measured it on the redesign (REDESIGN-REPORT
 * 2026-09-13, spike figures): the first fill of a cycle opens the Valorem claim and costs the
 * most; a later fill tops the claim up. Both are re-measured on the live week; the simulation
 * runs with SIMULATION_GAS so a genuine first fill is never mistaken for an out-of-gas.
 */
export const FILL_GAS = {
  firstFill: { low: 400_000, high: 500_000 },
  topUp: { low: 160_000, high: 250_000 },
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
