import { BaseError, ContractFunctionRevertedError, RawContractError, decodeErrorResult, formatUnits, type Abi, type Address, type Hex } from "viem";

import { clearExerciseErrorsAbi } from "./abi/clear";
import { fmtEastern, fmtUsdg, fmtUtc } from "./format";
import { SOLIDITY_ERROR_SELECTOR, SOLIDITY_PANIC_SELECTOR, decodeRevertData, type DecodedRevert, type RevertSource } from "./revert";

/**
 * Exercising this week's option from the cycle page (components/ExercisePanel.tsx): the window, the
 * amounts, the fee, the spot check, what a simulation means, and when the button is live.
 *
 * WHAT THE CLEARINGHOUSE DOES. `exercise(optionId, amount)` on the Valorem clearinghouse
 * (valorem-core 6436c823, ValoremOptionsClearinghouse.sol) checks, in this order:
 *   1. the id is an option, not a claim                    else InvalidOption
 *   2. `expiryTimestamp <= block.timestamp`                 → ExpiredOption
 *   3. `exerciseTimestamp > block.timestamp`                → ExerciseTooEarly
 *   4. `balanceOf[msg.sender][optionId] < amount`           → CallerHoldsInsufficientOptions
 * then assigns the exercise to writers, charges a fee if its fee switch is on
 * (`fee = exerciseAmount × amount × feeBps / 10_000`, floored, and 1 base unit when that floors to
 * zero), burns the options, pulls `exerciseAmount × amount + fee` of the exercise asset (USDG) with
 * solmate's safeTransferFrom, and pushes `underlyingAmount × amount` of the underlying (the Stock
 * Token) with safeTransfer. Solmate swallows a token's own revert: a failed USDG pull is
 * Error("TRANSFER_FROM_FAILED") and a failed Stock Token push is Error("TRANSFER_FAILED"), whatever
 * the token said. Everything below mirrors that, to the base unit.
 *
 * THE CLOCK IS THE CHAIN'S. The window is `exerciseTimestamp <= t < expiryTimestamp` where `t` is
 * the timestamp of the chain's latest block, never the device's clock: a device that runs a few
 * seconds fast would otherwise enable the button before the clearinghouse accepts it, and on the
 * W-13 fork the chain is warped days ahead of the wall. A block's timestamp is never later than
 * the next block's, so the opening edge cannot be early. At the closing edge the latest block can
 * be up to one block interval behind, so the button can stay live for that interval after expiry;
 * the simulation (which runs against the same latest block) and the one run again right before
 * sending are what catch that, and the worst case is a reverted exercise that moved no tokens.
 *
 * EXACT FIGURES. USDG is shown to all 6 decimals and the Stock Token to its full 18, trailing zeros trimmed:
 * no figure on the card is rounded, so no cost is ever shown lower than what the clearinghouse
 * pulls. The spot check compares by cross-multiplication in integers, never through a rounded
 * value. No percentages.
 *
 * DELIBERATELY ABSENT: React and the RPC. The panel reads the chain and hands the results here, so
 * vitest covers every branch with plain values and encoded revert data.
 */

/** One lot, and the scale the vault's spot is quoted against: USDG base units per 1e18 of the Stock Token. */
const WAD = 10n ** 18n;
const BPS = 10_000n;

/* ------------------------------------------------------------------------------ window --- */

export type ExerciseWindow = "unknown" | "before" | "open" | "expired";

/**
 * Where the chain's clock sits against the option's own window, checked in the clearinghouse's
 * order (expiry first). `chainNow` is the latest block's timestamp; undefined until it has been
 * read, and so is the window.
 */
export function exerciseWindow(
  option: { exerciseTs?: number; expiryTs?: number } | undefined,
  chainNow: number | undefined,
): ExerciseWindow {
  if (option === undefined || chainNow === undefined || !(chainNow > 0)) return "unknown";
  const { exerciseTs, expiryTs } = option;
  if (exerciseTs === undefined || expiryTs === undefined || !(expiryTs > 0)) return "unknown";
  if (expiryTs <= chainNow) return "expired";
  if (exerciseTs > chainNow) return "before";
  return "open";
}

/* ----------------------------------------------------------------------------- amounts --- */

/** Largest amount `exercise` accepts: its `amount` argument is a uint112. */
export const MAX_EXERCISE_AMOUNT = (1n << 112n) - 1n;

/** A whole number of contracts typed into the field, or undefined for anything else (or zero). */
export function parseContracts(input: string): bigint | undefined {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = BigInt(trimmed);
  if (value === 0n || value > MAX_EXERCISE_AMOUNT) return undefined;
  return value;
}

/** The clearinghouse's fee on an exercise, ValoremOptionsClearinghouse._calculateRecordAndEmitFee. */
export function clearFee(strikeCost: bigint, feesEnabled: boolean, feeBps: number): bigint {
  if (!feesEnabled) return 0n;
  const fee = (strikeCost * BigInt(feeBps)) / BPS;
  return fee === 0n ? 1n : fee;
}

export type ExerciseAmounts = {
  /** `exerciseAmount × amount`, USDG base units. */
  strikeCost: bigint;
  /** The clearinghouse's fee on it; 0 while its fee switch is off. */
  fee: bigint;
  /** What the clearinghouse pulls, and exactly what the approval is for. */
  total: bigint;
  /** `underlyingAmount × amount`, Stock Token base units, sent to the exerciser. */
  underlyingOut: bigint;
};

/**
 * The USDG and Stock Token legs of exercising `amount` contracts, exactly as the clearinghouse computes
 * them. Undefined until the tuple and the fee switch have both been read: a total without the fee
 * would be a total the clearinghouse might pull more than.
 */
export function exerciseAmounts(args: {
  amount: bigint | undefined;
  strikeUsdg: bigint | undefined;
  underlyingAmount: bigint | undefined;
  feesEnabled: boolean | undefined;
  feeBps: number | undefined;
}): ExerciseAmounts | undefined {
  const { amount, strikeUsdg, underlyingAmount, feesEnabled, feeBps } = args;
  if (amount === undefined || strikeUsdg === undefined || underlyingAmount === undefined || feesEnabled === undefined) return undefined;
  if (feesEnabled && feeBps === undefined) return undefined;
  const strikeCost = strikeUsdg * amount;
  const fee = clearFee(strikeCost, feesEnabled, feeBps ?? 0);
  return { strikeCost, fee, total: strikeCost + fee, underlyingOut: underlyingAmount * amount };
}

/**
 * Whether an approval must be sent first, and for how much. The approval is EXACTLY the total,
 * never more and never unlimited, and none is sent when the allowance already covers it.
 * Undefined while the allowance is unread.
 */
export function approvalFor(allowance: bigint | undefined, total: bigint): bigint | undefined {
  if (allowance === undefined) return undefined;
  return allowance >= total ? 0n : total;
}

/* --------------------------------------------------------------------------------- spot --- */

/**
 * Is exercising worth it at the vault's spot? `spotUsdg` is the vault's `spotUsdg()`: USDG base
 * units for one whole Stock Token (1e18 base units).
 *
 *   "worth"      the underlying received is worth more than the USDG paid, at that spot
 *   "notWorth"   it is worth the same or less: spot is at or below the strike (plus the
 *                clearinghouse's fee, when that is on), so exercising costs more than the underlying
 *   "unknown"    spot could not be read (the feed is stale and `spotUsdg()` reverts, or it has
 *                not answered): the page cannot tell, and treats it as a warning too
 *
 * `spot × underlyingOut ≤ total × 1e18`, in integers: nothing is rounded before the comparison.
 */
export type SpotCheck = "worth" | "notWorth" | "unknown";

export function spotCheck(spotUsdg: bigint | undefined, amounts: Pick<ExerciseAmounts, "underlyingOut" | "total"> | undefined): SpotCheck {
  if (spotUsdg === undefined || spotUsdg <= 0n || amounts === undefined) return "unknown";
  return spotUsdg * amounts.underlyingOut <= amounts.total * WAD ? "notWorth" : "worth";
}

/** The spot check warns, and asks for an explicit confirmation, unless it says "worth". */
export function spotNeedsConfirmation(check: SpotCheck): boolean {
  return check !== "worth";
}

/* ------------------------------------------------------------------------------ assets --- */

/**
 * The tuple names the tokens the page approves and expects: USDG in, the Stock Token out. The vault checked
 * both at rollOpen; checked again here because the approval goes to the USDG constant.
 */
export function exerciseAssetsMatch(
  option: { underlyingAsset?: Address; exerciseAsset?: Address } | undefined,
  expected: { usdg: Address; asset: Address },
): boolean | undefined {
  if (option?.underlyingAsset === undefined || option.exerciseAsset === undefined) return undefined;
  return (
    option.exerciseAsset.toLowerCase() === expected.usdg.toLowerCase() &&
    option.underlyingAsset.toLowerCase() === expected.asset.toLowerCase()
  );
}

/* ---------------------------------------------------------------------------- formatting --- */

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** USDG to all 6 decimals: "400.000000". Never rounded. */
export function fmtUsdgExact(value: bigint | undefined): string {
  return fmtUsdg(value, 6);
}

/** The Stock Token to full precision with trailing zeros trimmed: 1e18 → "1", 25e17 → "2.5", 1 → "0.000000000000000001". */
export function fmtNvdaExact(value: bigint | undefined): string {
  if (value === undefined) return "—";
  const negative = value < 0n;
  const [whole, frac] = formatUnits(negative ? -value : value, 18).split(".");
  const out = frac === undefined ? group(whole ?? "0") : `${group(whole ?? "0")}.${frac}`;
  return negative ? `-${out}` : out;
}

/* --------------------------------------------------------------------------- reverts --- */

export type ExerciseRevert = {
  source: RevertSource | "clear";
  name?: string;
  args: readonly unknown[];
  selector: Hex;
  text: string;
};

const big = (v: unknown): bigint | undefined => (typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : undefined);

/** solmate SafeTransferLib's two strings, as the clearinghouse raises them inside exercise. */
export const USDG_PULL_FAILED = "TRANSFER_FROM_FAILED";
export const UNDERLYING_PUSH_FAILED = "TRANSFER_FAILED";

/** Plain-English versions of what exercise can raise. */
export function explainExerciseRevert(name: string, args: readonly unknown[]): string | undefined {
  switch (name) {
    case "ExerciseTooEarly":
      return `The clearinghouse does not accept exercise yet: it opens at ${fmtUtc(big(args[1]))} · ${fmtEastern(big(args[1]))}.`;
    case "ExpiredOption":
      return `These options expired at ${fmtUtc(big(args[1]))} · ${fmtEastern(big(args[1]))}, so the clearinghouse no longer exercises them.`;
    case "CallerHoldsInsufficientOptions":
      return `This wallet holds fewer than ${String(big(args[1]) ?? "?")} of this option, so the clearinghouse will not exercise that many.`;
    case "InvalidOption":
      return "That id is not an option on the clearinghouse, so it cannot be exercised.";
    default:
      return undefined;
  }
}

function explainSolidityString(reason: string): string | undefined {
  if (reason === USDG_PULL_FAILED) {
    return "The clearinghouse could not take the USDG for the strike: the wallet's USDG approval to the clearinghouse or its USDG balance is short, or USDG is paused or an address in the transfer is frozen by its issuer.";
  }
  if (reason === UNDERLYING_PUSH_FAILED) {
    return "The clearinghouse could not send the Stock Token to this wallet: the token may be paused, or this address may not be allowed to receive it.";
  }
  return undefined;
}

/**
 * Decode revert data from an exercise: Solidity's Error/Panic by selector first (through
 * lib/revert.ts, with solmate's two strings given their meaning here), then the clearinghouse's own
 * errors, then everything lib/revert.ts knows (the vault's, Seaport's and USDG's). Undefined for no
 * data at all.
 */
export function decodeExerciseRevert(data: Hex | undefined): ExerciseRevert | undefined {
  if (data === undefined || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return undefined;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  if (selector !== SOLIDITY_ERROR_SELECTOR && selector !== SOLIDITY_PANIC_SELECTOR) {
    try {
      const decoded = decodeErrorResult({ abi: clearExerciseErrorsAbi as unknown as Abi, data });
      const args = (decoded.args ?? []) as readonly unknown[];
      const text = explainExerciseRevert(decoded.errorName, args);
      if (text !== undefined) return { source: "clear", name: decoded.errorName, args, selector, text };
    } catch {
      /* not the clearinghouse's; fall through */
    }
  }
  const general: DecodedRevert | undefined = decodeRevertData(data);
  if (general === undefined) return undefined;
  if (general.source === "solidity" && general.name === "Error") {
    const text = explainSolidityString(String(general.args[0]));
    if (text !== undefined) return { ...general, text };
  }
  return general;
}

/** The raw revert bytes inside a viem error, when there are any. */
export function revertDataOf(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
  const raw = err.walk((e) => e instanceof RawContractError);
  if (raw instanceof RawContractError) {
    const d = raw.data as Hex | { data?: Hex } | undefined;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof d.data === "string") return d.data;
  }
  return undefined;
}

/**
 * A sentence for a failed exercise transaction, when the failure is one this file explains: a
 * clearinghouse error or solmate's two strings. Undefined otherwise, so the toast's own
 * description (a wallet rejection, a network error) stands.
 */
export function describeExerciseError(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    const name = reverted.data?.errorName;
    const args = (reverted.data?.args ?? []) as readonly unknown[];
    if (name === "Error") {
      const text = explainSolidityString(String(args[0]));
      if (text !== undefined) return text;
    } else if (name !== undefined) {
      const text = explainExerciseRevert(name, args);
      if (text !== undefined) return text;
    }
  }
  const decoded = decodeExerciseRevert(revertDataOf(err));
  if (decoded?.source === "clear") return decoded.text;
  if (decoded?.source === "solidity" && decoded.name === "Error") return explainSolidityString(String(decoded.args[0]));
  return undefined;
}

/* ------------------------------------------------------------------------ simulation --- */

export type ExerciseSimulation = { ok: true } | { ok: false; revertData?: Hex; message?: string };

/**
 * What a simulated `exercise(optionId, amount)` from the holder's address means.
 *
 * The clearinghouse's own checks (window, balance, id) run BEFORE any token moves, so a
 * clearinghouse error is a refusal whatever the holder does: blocked. The USDG pull runs after
 * them, so a failed pull means those checks passed, and what failed is the holder's side. Solmate
 * does not say why, so the reason is read off the figures the page has: a balance below the total
 * is `usdgShort` (blocked: an approval would not help), an allowance below the total is
 * `needsApproval` (allowed: the button's first step is the exact approval, and the exercise is
 * simulated again after it), and with both covered the token itself refused (paused or frozen):
 * blocked. A failed push of the underlying is the Stock Token refusing to deliver: blocked. USDG's own named
 * errors, if a build of the clearinghouse ever bubbles them, map the same way. Anything else is
 * inconclusive: the page says so and leaves the wallet to show the outcome.
 */
export type ExerciseVerdict =
  | { kind: "ok" }
  | { kind: "needsApproval"; decoded?: ExerciseRevert }
  | { kind: "clearRefused"; decoded: ExerciseRevert }
  | { kind: "usdgShort"; decoded?: ExerciseRevert }
  | { kind: "tokenRefused"; decoded: ExerciseRevert }
  | { kind: "inconclusive"; text: string };

const USDG_SHORTFALL_ALLOWANCE = "InsufficientAllowance";
const USDG_SHORTFALL_FUNDS = "InsufficientFunds";
const USDG_REFUSAL = new Set(["ContractPaused", "AddressFrozen"]);

export function classifyExerciseSimulation(
  sim: ExerciseSimulation,
  ctx: { total: bigint; usdgBalance: bigint | undefined; allowance: bigint | undefined },
): ExerciseVerdict {
  if (sim.ok) return { kind: "ok" };
  const decoded = decodeExerciseRevert(sim.revertData);
  if (decoded === undefined) {
    return { kind: "inconclusive", text: sim.message?.trim() || "The simulation failed without a revert reason." };
  }
  if (decoded.source === "clear") return { kind: "clearRefused", decoded };

  const usdgPull = decoded.source === "solidity" && decoded.name === "Error" && decoded.args[0] === USDG_PULL_FAILED;
  if (usdgPull) {
    if (ctx.usdgBalance !== undefined && ctx.usdgBalance < ctx.total) return { kind: "usdgShort", decoded };
    if (ctx.allowance === undefined || ctx.allowance < ctx.total) return { kind: "needsApproval", decoded };
    return { kind: "tokenRefused", decoded };
  }
  if (decoded.source === "solidity" && decoded.name === "Error" && decoded.args[0] === UNDERLYING_PUSH_FAILED) {
    return { kind: "tokenRefused", decoded };
  }
  if (decoded.source === "token") {
    if (decoded.name === USDG_SHORTFALL_FUNDS) return { kind: "usdgShort", decoded };
    if (decoded.name === USDG_SHORTFALL_ALLOWANCE) return { kind: "needsApproval", decoded };
    if (decoded.name !== undefined && USDG_REFUSAL.has(decoded.name)) return { kind: "tokenRefused", decoded };
  }
  return { kind: "inconclusive", text: decoded.text };
}

/**
 * Whether the verdict lets the button go ahead. No verdict is not a pass: the button waits for the
 * simulation of THIS amount from THIS address.
 */
export function exerciseAllowed(verdict: ExerciseVerdict | undefined): boolean {
  if (verdict === undefined) return false;
  return verdict.kind === "ok" || verdict.kind === "needsApproval" || verdict.kind === "inconclusive";
}

/**
 * Whether the exercise may be SENT on a simulation taken after the approval step. An approval has
 * already gone out, so a shortfall it should have fixed is no longer "needs approval": only a pass
 * (or an inconclusive result, left to the wallet as before) sends.
 */
export function exerciseSendable(verdict: ExerciseVerdict | undefined): boolean {
  if (verdict === undefined) return false;
  return verdict.kind === "ok" || verdict.kind === "inconclusive";
}

/* ------------------------------------------------------------------------------ button --- */

export type ExerciseBlocker =
  | "busy"
  | "notConnected"
  | "wrongNetwork"
  | "window"
  | "assets"
  | "reading"
  | "noAmount"
  | "overBalance"
  | "usdgShort"
  | "simulating"
  | "refused"
  | "confirm";

export type ExerciseButtonState = { enabled: boolean; label: string; blocker?: ExerciseBlocker };

/**
 * The button, in one predicate. Its label names the amount ("Exercise 2 contracts"), so the ARIA
 * name says exactly what a click sends. It is live only when every one of these holds: a wallet,
 * on this app's chain (both writes are pinned to it), the window open by the chain's clock, the tuple's tokens are USDG and the Stock Token, the option balance,
 * the amounts (with the fee switch) and the allowance read, a whole amount of at least one and no
 * more than the balance, enough USDG for the total, a simulation verdict for this exact exercise
 * that allows it, and, when spot does not show the exercise is worth it, the holder's explicit
 * confirmation.
 */
export function exerciseButton(s: {
  busy: boolean;
  connected: boolean;
  /** The wallet's current chain is the app's chain. */
  onChain: boolean;
  window: ExerciseWindow;
  assetsMatch: boolean | undefined;
  optionBalance: bigint | undefined;
  amount: bigint | undefined;
  amounts: ExerciseAmounts | undefined;
  usdgBalance: bigint | undefined;
  allowance: bigint | undefined;
  verdict: ExerciseVerdict | undefined;
  needsConfirmation: boolean;
  confirmed: boolean;
}): ExerciseButtonState {
  const label = s.busy
    ? "Working…"
    : s.amount === undefined
      ? "Exercise"
      : `Exercise ${s.amount.toString()} contract${s.amount === 1n ? "" : "s"}`;
  const off = (blocker: ExerciseBlocker): ExerciseButtonState => ({ enabled: false, label, blocker });
  if (s.busy) return off("busy");
  if (!s.connected) return off("notConnected");
  if (!s.onChain) return off("wrongNetwork");
  if (s.window !== "open") return off("window");
  if (s.assetsMatch === false) return off("assets");
  if (s.optionBalance === undefined || s.assetsMatch === undefined) return off("reading");
  if (s.amount === undefined) return off("noAmount");
  if (s.amount > s.optionBalance) return off("overBalance");
  if (s.amounts === undefined || s.usdgBalance === undefined || s.allowance === undefined) return off("reading");
  if (s.usdgBalance < s.amounts.total) return off("usdgShort");
  if (s.verdict === undefined) return off("simulating");
  if (!exerciseAllowed(s.verdict)) return off(s.verdict.kind === "usdgShort" ? "usdgShort" : "refused");
  if (s.needsConfirmation && !s.confirmed) return off("confirm");
  return { enabled: true, label };
}
