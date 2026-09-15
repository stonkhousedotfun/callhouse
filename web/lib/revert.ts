import { decodeErrorResult, type Abi, type Hex } from "viem";

import { usdgErrorsAbi } from "./abi/erc20";
import { seaportAbi } from "./abi/seaport";
import { accountFactoryAbi } from "./abi/accountFactory";
import { vaultAbi } from "./abi/vault";
import { writerAccountAbi } from "./abi/writerAccount";
import { fmtEastern, fmtUsdg, fmtUtc } from "./format";

/**
 * Turn a revert into a sentence a human can act on.
 *
 * The vault ABI (lib/abi/vault.ts) carries every custom error the vault can raise, including the
 * ones raised inside its linked libraries (ValoremLib, SeaportOrderLib, Policy), which solc leaves
 * out of Vault.json and scripts/gen-abis.mjs merges back in. So a revert decodes to a name
 * instead of a bare 4-byte selector, and the names are the product rules: "a redemption while a
 * call is open goes through the queue", "the vault re-priced its floor at today's spot". Showing
 * them is the honest thing, not a leak of internals; EXPLAINED translates the ones a depositor or
 * a buyer can actually hit, with the figures the error carries formatted in their own units.
 *
 * Seaport's own errors are decoded too (lib/abi/seaport.ts), and so are USDG's four
 * (lib/abi/erc20.ts usdgErrorsAbi), so a fill simulation can tell "the vault refused" from
 * "Seaport refused" from "USDG would not move" from "the buyer's USDG approval is short"
 * (lib/fillPreflight.ts). Solidity's `Error(string)` and `Panic(uint256)` are named as such.
 *
 * THE SOURCE IS DECIDED BY SELECTOR, NOT BY WHICH ABI HAPPENS TO DECODE FIRST. viem's
 * `decodeErrorResult` appends `Error(string)` and `Panic(uint256)` to every ABI it is given, so
 * the first ABI in the list would claim a token's `Error("ERC20: insufficient allowance")` as a
 * VAULT revert, and the fill page would then block a fill the vault had already accepted. The
 * two Solidity selectors are matched first and attributed to `solidity`; only a selector that is
 * neither is looked up in the vault's, Seaport's and USDG's ABIs, in that order. No vault or
 * library error shares a selector with a Seaport or a USDG one (each name is unique across the
 * three, and the vault raises only custom errors of its own), so the order between them cannot
 * misattribute anything.
 *
 * DELIBERATELY ABSENT: React, a chain client. Pure over hex, so vitest covers it.
 */

export type RevertSource = "vault" | "seaport" | "token" | "solidity" | "unknown";

export type DecodedRevert = {
  source: RevertSource;
  /** The error's name, when its selector is known; undefined for an unknown selector. */
  name?: string;
  args: readonly unknown[];
  /** The 4-byte selector, for the unknown case and for logs. */
  selector: Hex;
  /** The sentence the UI shows. */
  text: string;
};

const SOLIDITY_ABI = [
  { type: "error", name: "Error", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
] as const;

/** `Error(string)` and `Panic(uint256)`: the two selectors solc itself emits. */
export const SOLIDITY_ERROR_SELECTOR: Hex = "0x08c379a0";
export const SOLIDITY_PANIC_SELECTOR: Hex = "0x4e487b71";

const SOURCES: ReadonlyArray<readonly [RevertSource, Abi]> = [
  ["vault", writerAccountAbi as unknown as Abi],
  ["vault", accountFactoryAbi as unknown as Abi],
  ["vault", vaultAbi as unknown as Abi],
  ["seaport", seaportAbi as unknown as Abi],
  ["token", usdgErrorsAbi as unknown as Abi],
];

const big = (v: unknown): bigint | undefined => (typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : undefined);
const usdg = (v: unknown): string => fmtUsdg(big(v), 6);
const count = (v: unknown): string => String(big(v) ?? "?");

/**
 * Plain-English versions of the reverts a depositor or a buyer can actually hit. A function of
 * the arguments where the error carries figures worth showing; a string where it does not.
 */
export const EXPLAINED: Record<string, string | ((args: readonly unknown[]) => string)> = {
  // Deposits and the queue.
  UseQueue: "A call is open, so this redemption has to go through the queue.",
  DepositCapExceeded: "That is more than this account can hold.",
  InsufficientIdle: "Not enough idle NVDA in the account for that.",
  NotOwner: "Only the account owner can do that.",
  NoWeek: "This week is not open for offers yet.",
  AlreadyListed: "This week's offers are already listed.",
  NothingToList: "Choose how much is for sale first.",
  TooEarly: "The week has not ended yet.",
  TooManyLots: "That is more than this account can offer this week.",
  ZeroAmount: "Enter an amount above zero.",
  AlreadyHasAccount: "This wallet already has an account.",
  Occupied: "That wallet already has an account.",
  NotAuthorized: "Not allowed.",
  NoAccount: "Create an account first.",
  WritesAreHalted: "New sales are paused. Try again later.",
  // Vault._depositRefused, every reason a depositor can meet. "Assignment pending" is left out on
  // purpose: nothing can be assigned before cycleExerciseTs, so it only ever holds alongside the
  // sale window, the settling phase or a stranded claim, which are named. A full deposit cap is
  // not this error (DepositCapExceeded).
  DepositsClosed:
    "Deposits are closed right now: the vault is past this week's sale window, settling, holding a stranded claim, its reserve is unbacked, or the book is worth too little per share to sell new shares. They reopen by themselves when the reason clears.",
  NothingToClaim: "There is no USDG to claim yet.",
  NothingQueued: "Nothing is queued for this address.",
  EpochNotSettled: "This queued redemption settles after the keeper closes the week.",
  InsufficientFreeShares: "Some of those shares are already queued.",
  ZeroAssets: "Enter an amount above zero.",
  ZeroShares: "Enter an amount above zero.",
  WrongPhase: "The vault is not in the phase this action needs right now.",
  UsdgLegBlocked:
    "The Stock Token leg is paid but the USDG leg could not move (USDG paused, or the vault or the receiver frozen). The USDG stays owed; collect it later, or to another receiver.",
  ERC20InsufficientAllowance: "Approve the vault to move your tokens first.",
  ERC20InsufficientBalance: "Not enough tokens in the wallet.",
  // The stranded claim.
  StillStranded:
    "The stranded claim still cannot be redeemed: whatever blocked it (a USDG pause or freeze, a Stock Token blocklist) has not cleared yet. Try again later; anyone can.",
  NotStranded: "No claim is stranded, so there is nothing to retry.",
  // The fill gate (Vault.authorizeOrder, ValoremLib.writeOnFill, Policy).
  NotLiveListing: "That order is no longer for sale.",
  NotSeaport: "Only Seaport may call the vault's fill hooks.",
  WriteWindowClosed: (a) =>
    `This week's sale window closed at ${fmtUtc(big(a[0]))} · ${fmtEastern(big(a[0]))}: the exercise window has opened and nothing more can be written.`,
  PremiumBelowFloorAtFill: (a) =>
    `The vault re-priced its premium floor at today's spot: this fill would pay ${usdg(a[0])} USDG against a floor of ${usdg(a[1])} USDG. The keeper reprices, or spot comes back; until then the vault will not sell.`,
  // No reprice clears this one: the strike is the armed option type's and fixed until the week
  // closes, and approveListing re-checks the same floor, so a relist reverts too. Only spot does.
  StrikeBelowBand: (a) =>
    `After the rally this week's strike (${usdg(a[0])} USDG) is below the vault's minimum of ${usdg(a[1])} USDG at today's spot, so the vault will not sell it. The strike is fixed for the week and a new price cannot change it: the vault sells again only if spot falls back far enough that the strike clears the floor.`,
  StrikeAboveBand: (a) => `This week's strike (${usdg(a[0])} USDG) is above the vault's maximum of ${usdg(a[1])} USDG at today's spot.`,
  PremiumBelowMinimum: (a) => `The premium ${usdg(a[0])} USDG is below the vault's minimum of ${usdg(a[1])} USDG.`,
  ReserveBreached:
    "Writing this many contracts would leave the vault's token balance below what settled redeemers are owed, so the fill was refused.",
  ContractsAboveCap: (a) => `That fill would take the week past the vault's contract cap: ${count(a[0])} written against a cap of ${count(a[1])}.`,
  ContractsAboveUtilization: (a) =>
    `That fill would take the week past what the vault's collateral can back: ${count(a[0])} written against a maximum of ${count(a[1])} right now.`,
  ContractsZero: "A fill of zero contracts is not a fill.",
  OfferExceedsCapacity: (a) => `The listing offers ${count(a[0])} contracts but the vault can only write ${count(a[1])} more this cycle.`,
  InventoryLeftBehind: "The fill would have left option tokens inside the vault, so Seaport rolled it back. Nothing was written.",
  StalePrice: "The price feed is stale, so the vault will not sell until it updates.",
  OraclePaused: "The Stock Token's oracle is paused, so the vault will not sell.",
  ValoremFeeNotAccepted:
    "Valorem has switched its engine fee on and the vault's admin has not accepted paying it, so the vault will not write until that decision is made.",
  SpotZero: "The price feed returned zero, so the vault will not sell.",
  // Seaport.
  InvalidTime: "Seaport: the order is outside its start and end time.",
  OrderIsCancelled: "Seaport: this order has been cancelled.",
  OrderAlreadyFilled: "Seaport: every contract in this order has already been sold.",
  OrderPartiallyFilled: "Seaport: this order cannot be filled in full any more; take fewer contracts.",
  BadFraction: "Seaport: that fraction of the order cannot be filled. Take fewer contracts, or a count that divides the order.",
  InexactFraction: "Seaport: that fraction of the order is not exact.",
  PartialFillsNotEnabledForOrder: "Seaport: this order cannot be partially filled.",
  InvalidRestrictedOrder: "Seaport: the vault's fill hook refused this order without saying why.",
  InvalidSigner: "Seaport: this order is not validated on chain, so it cannot be filled with an empty signature.",
  InvalidSignature: "Seaport: this order is not validated on chain, so it cannot be filled with an empty signature.",
  TokenTransferGenericFailure:
    "Seaport could not move a token. For a buyer that is almost always the USDG approval to Seaport or the wallet's USDG balance.",
  BadReturnValueFromERC20OnTransfer: "Seaport: the token transfer did not return true.",
  ConsiderationNotMet: "Seaport: the payment leg was not fully covered.",
  NoContract: (a) => `Seaport: there is no contract at ${String(a[0])}.`,
  // USDG (Paxos). The names are the token's own; see lib/abi/erc20.ts usdgErrorsAbi.
  ContractPaused: "USDG is paused by its issuer, so no USDG can move: nothing can be bought or paid out until the pause is lifted.",
  AddressFrozen:
    "USDG's issuer has frozen an address in this transfer (the payer, the vault, or Seaport as the spender), so the USDG leg cannot move.",
  InsufficientFunds: "Not enough USDG in the wallet for this fill.",
  InsufficientAllowance: "USDG is not yet approved to Seaport for this amount. The approve step fixes that.",
  // Solidity.
  Error: (a) => `Reverted: ${String(a[0])}`,
  Panic: (a) => `The contract hit an internal error (panic code ${String(a[0])}).`,
};

/** The sentence for a named revert, with a generic fallback that keeps the name and its figures. */
export function explainRevert(name: string, args: readonly unknown[] = []): string {
  const entry = EXPLAINED[name];
  if (typeof entry === "function") return entry(args);
  if (typeof entry === "string") return entry;
  const detail = args.length > 0 ? ` (${args.map((a) => String(a)).join(", ")})` : "";
  return `Reverted: ${name}${detail}`;
}

function decodeWith(source: RevertSource, abi: Abi, data: Hex, selector: Hex): DecodedRevert | undefined {
  try {
    const decoded = decodeErrorResult({ abi, data });
    const args = (decoded.args ?? []) as readonly unknown[];
    return { source, name: decoded.errorName, args, selector, text: explainRevert(decoded.errorName, args) };
  } catch {
    return undefined;
  }
}

/**
 * Decode raw revert data: Solidity's own two by selector first, then the vault's merged ABI, then
 * Seaport's, then USDG's. Undefined for no data at all; an unknown selector comes back named
 * `undefined` with its selector in the text, so a page never prints a bare hex blob and never
 * pretends to know.
 */
export function decodeRevertData(data: Hex | undefined): DecodedRevert | undefined {
  if (data === undefined || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return undefined;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  if (selector === SOLIDITY_ERROR_SELECTOR || selector === SOLIDITY_PANIC_SELECTOR) {
    return decodeWith("solidity", SOLIDITY_ABI as unknown as Abi, data, selector);
  }
  for (const [source, abi] of SOURCES) {
    const decoded = decodeWith(source, abi, data, selector);
    // viem's fallback to Error/Panic cannot fire here: those selectors were handled above.
    if (decoded !== undefined) return decoded;
  }
  return { source: "unknown", args: [], selector, text: `Reverted with an unrecognised error (selector ${selector}).` };
}
