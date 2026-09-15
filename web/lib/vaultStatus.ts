/**
 * The vault's state chips, decided as pure functions of the snapshot and the clock:
 * what the week is doing (the fill-state badge) and what is stopping the vault from selling (the
 * guard badges). components/PhaseBadge.tsx renders these and nothing else decides them.
 *
 * WHY THE FILL STATE TAKES A CLOCK. `lockBook` is permissionless and nobody is obliged to call it,
 * so the vault can sit in phase Listed through the exercise window (a keeper outage, for up to a
 * day or more). From `cycleExerciseTs` every fill is refused (ValoremLib.writeOnFill,
 * `WriteWindowClosed`) and deposits close (Vault._depositRefused reason 2) whatever the phase
 * says, and buyers can exercise on Clear, so `contractsAssigned()` can already be non-zero. A badge
 * that read the phase alone kept saying "Selling · 3 sold" next to a tape that said "sale window
 * closed", after those 3 were assigned. Past the exercise time a Listed vault is labelled exactly as
 * an Exercisable one. Before the clock has started (`nowSeconds == 0`, the first client frame)
 * nothing is inferred from it, so the server and the first client render agree.
 *
 * WHY THE GUARDS READ CLEAR'S FEE SWITCH. Valorem's engine fee stops the vault only when it is ON
 * and the admin has NOT accepted it: `clear.feesEnabled() && !valoremFeeAccepted` reverts
 * `ValoremFeeNotAccepted` at `rollOpen` and at every fill (ValoremLib.open, writeOnFill). An
 * accepted fee stops nothing; it only raises the fill's floor by the fee valued at spot. The
 * earlier chip showed "Valorem fee accepted" in amber as if it were a stop, and never showed the
 * state that is one, because the page did not read `feesEnabled()` at all.
 *
 * DELIBERATELY ABSENT: React, wagmi. vitest covers every branch (lib/vaultStatus.test.ts).
 */

/**
 * What the week is actually doing, in the product's own words. This is the state the site
 * promises to publish honestly — "unfilled" included, because it is the most likely one.
 *
 * Under write on fill nothing is written until a buyer fills, and each fill writes exactly what
 * it sold. So there is no "listed but unsold" inventory: contracts written IS contracts sold, and
 * the interesting number while Listed is how many have been sold against how many the vault can
 * still write (its capacity).
 */
export type FillState =
  | "unknown" // nothing read yet, or no vault configured
  | "flat" // Idle, nothing armed; the vault is holding spot
  | "stranded" // Idle, but rollClose could not redeem the claim; deposits and instant redemption shut
  | "armed" // Listed, an option type armed, nothing sold yet
  | "selling" // Listed, some sold, capacity left
  | "filled" // Listed, sold to capacity
  | "locked" // past the sale window (Exercisable, or Listed past the exercise time), calls sold
  | "settling" // past expiry, reclaiming
  | "assigned" // past the sale window and part of the claim has been assigned
  | "unfilled"; // past the sale window with nothing sold: no premium

export const FILL_STATE_COPY: Record<FillState, string> = {
  unknown: "State unavailable",
  flat: "Flat — no call armed",
  stranded: "Stranded claim",
  armed: "Armed — nothing sold yet",
  selling: "Selling",
  filled: "Sold to capacity",
  locked: "Sale window closed",
  settling: "Settling",
  assigned: "Assigned",
  unfilled: "Window closed, unsold",
};

export function deriveFillState(
  v: {
    phase?: number;
    claimKey?: bigint;
    contractsWritten?: bigint;
    contractsAssigned?: bigint;
    capacity?: bigint;
    cycleExerciseTs?: number;
  },
  nowSeconds: number,
): FillState {
  // No phase means no answer yet (or no vault configured). Saying "flat" would be asserting
  // something about a vault we have not read.
  if (v.phase === undefined) return "unknown";
  const sold = v.contractsWritten ?? 0n;
  const assigned = v.contractsAssigned ?? 0n;
  const pastSaleWindow = (): FillState => {
    // The claim is still open, so assignment is readable. rollClose zeroes contractsWritten and the
    // claim key, which makes every Idle read "flat"; the closed week's result comes from history
    // (the "Result" row), never from this badge.
    if (assigned > 0n) return "assigned";
    return sold === 0n ? "unfilled" : "locked";
  };
  switch (v.phase) {
    case 1:
      // Listed past the exercise time with nobody having called lockBook: closed, whatever the
      // phase says. The fill hook refuses from this instant (WriteWindowClosed).
      if (nowSeconds > 0 && v.cycleExerciseTs !== undefined && v.cycleExerciseTs > 0 && nowSeconds >= v.cycleExerciseTs) {
        return pastSaleWindow();
      }
      if (sold === 0n) return "armed";
      return v.capacity !== undefined && v.capacity === 0n ? "filled" : "selling";
    case 2:
      return pastSaleWindow();
    case 3:
      return "settling";
    case 0:
    default:
      // Idle with a claim is the one state only a failed redeem produces (Vault.isStranded).
      return (v.claimKey ?? 0n) !== 0n ? "stranded" : "flat";
  }
}

export type GuardTone = "bad" | "warn" | "info";
export type Guard = { key: string; tone: GuardTone; label: string; title: string };

/**
 * The guard chips, most severe first. Every "bad" or "warn" chip is a condition that stops the
 * vault arming or selling; the one "info" chip is an accepted Valorem fee, which stops nothing.
 */
export function vaultGuards(v: {
  isStranded?: boolean;
  writesHalted?: boolean;
  oraclePaused?: boolean;
  spotStale?: boolean;
  clearFeesEnabled?: boolean;
  valoremFeeAccepted?: boolean;
}): Guard[] {
  const guards: Guard[] = [];
  if (v.isStranded) {
    guards.push({ key: "stranded", tone: "bad", label: "Claim stranded", title: "rollClose could not redeem the claim; no new week can be armed until retryStrandedClaim succeeds." });
  }
  if (v.writesHalted) {
    guards.push({ key: "halt", tone: "bad", label: "Writes halted", title: "The guardian halted writes: no arm and no fill until the admin lifts it." });
  }
  if (v.oraclePaused) {
    guards.push({ key: "oracle", tone: "bad", label: "Token oracle paused", title: "The Stock Token's oracle is paused, so the vault will not arm or sell." });
  }
  if (v.clearFeesEnabled === true && v.valoremFeeAccepted === false) {
    guards.push({
      key: "fee",
      tone: "bad",
      label: "Valorem fee on, not accepted: no arm, no fill",
      title: "The clearinghouse's engine fee is switched on and the vault's admin has not accepted paying it, so rollOpen and every fill revert ValoremFeeNotAccepted.",
    });
  }
  if (v.spotStale) {
    guards.push({ key: "spot", tone: "warn", label: "Price feed stale", title: "The price feed is older than the vault accepts, so it will not arm or sell until it updates." });
  }
  if (v.valoremFeeAccepted === true) {
    guards.push({
      key: "fee",
      tone: "info",
      label: v.clearFeesEnabled === true ? "Valorem fee on, accepted" : "Valorem fee accepted",
      title:
        v.clearFeesEnabled === true
          ? "The clearinghouse's engine fee is on and accepted: the vault keeps selling, and every fill's floor includes the fee valued at spot."
          : "The admin has accepted Valorem's engine fee should it be switched on; it is off now, so nothing changes.",
    });
  }
  return guards;
}
