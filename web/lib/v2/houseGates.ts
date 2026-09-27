/**
 * Which House deposit and withdrawal buttons can succeed, from the vault's own request state, and the line
 * that says why when one cannot. The claim button has its own module (houseClaim.ts).
 *
 * MIRROR, DO NOT RE-REASON. callhouse-contracts src/v2/periphery/house/HouseVault.sol:
 *   THE QUEUE CUTOFF       `_requireBeforeCutoff`: PastCutoff once `block.timestamp + SETTLEMENT_WINDOW >= epochEnd`, i.e.
 *                          from `epochEnd - SETTLEMENT_WINDOW` until rollEpoch moves `epochEnd`. The four queue calls
 *                          below use it. The window is read from the chain (`SETTLEMENT_WINDOW()`), never typed here.
 *   requestDeposit         the queue cutoff; TooEarly while a deposit from an OLDER epoch is unclaimed.
 *   depositNow             PastCutoff at or after `epochEnd` (`_instantQuote`), NOT the queue cutoff. It never touches
 *                          the queue: no TooEarly.
 *   cancelDepositRequest   TooEarly when the request is from an older epoch; BadUnits when nothing is queued; the queue
 *                          cutoff.
 *   requestWithdraw        the queue cutoff; TooEarly while a withdrawal from an older epoch is unclaimed; the shares
 *                          leave the wallet, so more than the balance reverts in the token.
 *   cancelWithdrawRequest  BadUnits when nothing is queued; TooEarly when the request is from an older epoch; the queue
 *                          cutoff.
 * Without these gates the page offered every button always, and the chain's refusal came back as the shared copy:
 * BadUnits reads "Enter a positive quantity in 0.01 share steps." for a Cancel with nothing queued.
 *
 * UNKNOWN IS NOT "NOTHING". A Cancel opens only on a read that shows something cancellable; an unread or failed read
 * keeps it shut and says so, as the claim button does. A new request is NOT shut by an unread or failed read: getting
 * money out never waits on a read, and deposits are already shut by the arming read of the same multicall. The chain
 * still refuses what these gates let through, and the click re-reads the chain first (readHouseGateState).
 */
import type { Address, PublicClient } from "viem";

import { houseVaultAbi } from "../abi/v2/houseVault";
import { settlementOracleAbi } from "../abi/v2/settlementOracle";
import { publicClient } from "../chain";
import { requireV2Address } from "./config";
import { houseWindowWords } from "./houseEpoch";
import type { HouseVaultReads } from "./chainReads";

/**
 * `quiet`: the page shows no line under the button for this reason (nothing queued, or the read not back yet), because
 * a disabled Cancel with nothing to cancel explains itself. The click still throws the reason.
 */
export type HouseGate = { open: true } | { open: false; reason: string; quiet?: boolean };

/** The reads every gate below takes: the vault multicall's request fields plus the cutoff and a clock. */
export type HouseGateState = Pick<HouseVaultReads, "epochId" | "withdrawRequest" | "depositRequest"> & {
  /** The wallet's shares (`balanceOf`). Undefined while unread, null when the read failed. */
  balance?: bigint | null;
  /** The running epoch's end (`epochEnd()`), seconds. Null when unknown. */
  epochEnd: number | null;
  /** The chain's clock, seconds. Null when unknown. */
  now: number | null;
  /**
   * `SETTLEMENT_WINDOW()` in seconds, read from the chain (the queue cutoff is `epochEnd` minus it). Null when
   * unknown: then only the close itself is known to shut the queue, and the chain refuses the rest.
   */
  settlementWindow: number | null;
};

const OPEN: HouseGate = { open: true };
const shut = (reason: string, quiet = false): HouseGate => (quiet ? { open: false, reason, quiet } : { open: false, reason });

export const HOUSE_DEPOSITS_CLOSED = "Deposits are closed until the vault starts its next epoch.";
export const HOUSE_DEPOSIT_TO_CLAIM = "A deposit from an earlier epoch is waiting to be claimed. Claim it before queuing another.";
export const HOUSE_WITHDRAWAL_TO_CLAIM = "A withdrawal from an earlier epoch is waiting to be claimed. Claim it before requesting another.";
export const HOUSE_NO_DEPOSIT_QUEUED = "No deposit is queued this epoch.";
export const HOUSE_NO_WITHDRAWAL_QUEUED = "No withdrawal is queued this epoch.";
export const HOUSE_DEPOSIT_PRICED = "Your queued deposit was priced at the last close. Claim it instead.";
export const HOUSE_WITHDRAWAL_PRICED = "Your queued withdrawal was processed at the last close. Claim it instead.";
export const HOUSE_DEPOSIT_CANCEL_CLOSED = "This epoch has closed, so its queued deposit is priced at the close and can no longer be cancelled.";
export const HOUSE_WITHDRAWALS_CLOSED = "Withdrawal requests are closed until the vault starts its next epoch.";
export const HOUSE_WITHDRAWAL_CANCEL_CLOSED = "This epoch has closed, so its queued withdrawal is processed at the close and can no longer be cancelled.";
export const HOUSE_REQUESTS_UNREAD = "Checking your queued requests.";
export const HOUSE_REQUESTS_UNKNOWN = "Could not read your queued requests from the vault. Refresh to check again.";

/** The lines for a queue call shut by cutoff, inside the window (the close has not passed yet). */
export const houseDepositQueueClosed = (windowS: number) =>
  `Queued deposits stop ${houseWindowWords(windowS)} before the close and reopen when the vault starts its next epoch.`;
export const houseWithdrawQueueClosed = (windowS: number) =>
  `Withdrawal requests stop ${houseWindowWords(windowS)} before the close and reopen when the vault starts its next epoch.`;
export const houseDepositCancelQueueClosed = (windowS: number) =>
  `Cancels stop ${houseWindowWords(windowS)} before the close, so this deposit is priced at the close.`;
export const houseWithdrawCancelQueueClosed = (windowS: number) =>
  `Cancels stop ${houseWindowWords(windowS)} before the close, so this withdrawal is processed at the close.`;

/** depositNow's cutoff: at or after `epochEnd`. */
const pastClose = (s: HouseGateState) => s.epochEnd !== null && s.now !== null && s.now >= s.epochEnd;
/** The queue's cutoff (`_requireBeforeCutoff`): `now + SETTLEMENT_WINDOW >= epochEnd`, written as the contract adds it. */
const inWindow = (s: HouseGateState) => s.epochEnd !== null && s.now !== null && s.settlementWindow !== null
  && s.now + s.settlementWindow >= s.epochEnd;

/** The shut gate for a queue call past the cutoff, or null: the close's line once it has passed, else the window's. */
function queueCutoff(s: HouseGateState, closed: string, windowLine: (windowS: number) => string): HouseGate | null {
  if (pastClose(s)) return shut(closed);
  return inWindow(s) ? shut(windowLine(s.settlementWindow!)) : null;
}
const depositQueued = (r: NonNullable<HouseVaultReads["depositRequest"]>) => r.usdg !== 0n || r.stock !== 0n;

/** The shut gate for a Cancel that cannot read the request, or null when it can. */
function unreadable(s: HouseGateState, request: unknown): HouseGate | null {
  if (s.epochId === undefined || request === undefined) return shut(HOUSE_REQUESTS_UNREAD, true);
  if (s.epochId === null || request === null) return shut(HOUSE_REQUESTS_UNKNOWN);
  return null;
}

/** A new deposit: `instant` for depositNow, false for requestDeposit (the queue). */
export function houseDepositGate(s: HouseGateState, instant: boolean): HouseGate {
  if (instant && pastClose(s)) return shut(HOUSE_DEPOSITS_CLOSED);
  const cutoff = instant ? null : queueCutoff(s, HOUSE_DEPOSITS_CLOSED, houseDepositQueueClosed);
  if (cutoff) return cutoff;
  const r = s.depositRequest;
  if (!instant && r && typeof s.epochId === "bigint" && depositQueued(r) && r.epochId !== s.epochId)
    return shut(HOUSE_DEPOSIT_TO_CLAIM);
  return OPEN;
}

export function houseCancelDepositGate(s: HouseGateState): HouseGate {
  const unread = unreadable(s, s.depositRequest);
  if (unread) return unread;
  const r = s.depositRequest!;
  if (!depositQueued(r)) return shut(HOUSE_NO_DEPOSIT_QUEUED, true);
  if (r.epochId !== s.epochId) return shut(HOUSE_DEPOSIT_PRICED);
  return queueCutoff(s, HOUSE_DEPOSIT_CANCEL_CLOSED, houseDepositCancelQueueClosed) ?? OPEN;
}

/** A new withdrawal of `shares` (null when nothing valid is entered yet). `format` renders a raw share amount. */
export function houseWithdrawGate(s: HouseGateState, shares: bigint | null, format: (raw: bigint) => string): HouseGate {
  const cutoff = queueCutoff(s, HOUSE_WITHDRAWALS_CLOSED, houseWithdrawQueueClosed);
  if (cutoff) return cutoff;
  const r = s.withdrawRequest;
  if (r && typeof s.epochId === "bigint" && r.shares !== 0n && r.epochId !== s.epochId) return shut(HOUSE_WITHDRAWAL_TO_CLAIM);
  if (shares !== null && typeof s.balance === "bigint" && shares > s.balance)
    return shut(`You hold ${format(s.balance)} shares. Enter that many or fewer.`);
  return OPEN;
}

export function houseCancelWithdrawGate(s: HouseGateState): HouseGate {
  const unread = unreadable(s, s.withdrawRequest);
  if (unread) return unread;
  const r = s.withdrawRequest!;
  if (r.shares === 0n) return shut(HOUSE_NO_WITHDRAWAL_QUEUED, true);
  if (r.epochId !== s.epochId) return shut(HOUSE_WITHDRAWAL_PRICED);
  return queueCutoff(s, HOUSE_WITHDRAWAL_CANCEL_CLOSED, houseWithdrawCancelQueueClosed) ?? OPEN;
}

/** The line under a button: its gate's reason when shut and not quiet, else null. */
export function houseGateLine(gate: HouseGate): string | null {
  return gate.open || gate.quiet ? null : gate.reason;
}

/** Throws the gate's line when it is shut. For the click, after {readHouseGateState}. */
export function assertHouseGate(gate: HouseGate): void {
  if (!gate.open) throw new Error(gate.reason);
}

/**
 * The same state read fresh from the chain at one block, for the click: the page's reads can be thirty seconds old and
 * its clock is the browser's. `now` is that block's timestamp. A failed read throws; the click does not guess.
 */
export async function readHouseGateState(vault: Address, account: Address, client: PublicClient = publicClient): Promise<HouseGateState> {
  try {
    const block = await client.getBlock({ blockTag: "latest" });
    const blockNumber = block.number;
    // SETTLEMENT_WINDOW is V2Constants' compiled constant, the one HouseVault._requireBeforeCutoff subtracts; the
    // SettlementOracle exposes it (every oracle a vault can point at must answer it: HouseVault.setOracle probes it).
    const [epochId, epochEnd, withdraw, deposit, balance, settlementWindow] = await Promise.all([
      client.readContract({ address: vault, abi: houseVaultAbi, functionName: "epochId", blockNumber }),
      client.readContract({ address: vault, abi: houseVaultAbi, functionName: "epochEnd", blockNumber }),
      client.readContract({ address: vault, abi: houseVaultAbi, functionName: "withdrawRequestOf", args: [account], blockNumber }),
      client.readContract({ address: vault, abi: houseVaultAbi, functionName: "depositRequestOf", args: [account], blockNumber }),
      client.readContract({ address: vault, abi: houseVaultAbi, functionName: "balanceOf", args: [account], blockNumber }),
      client.readContract({ address: requireV2Address("settlementOracle"), abi: settlementOracleAbi, functionName: "SETTLEMENT_WINDOW", blockNumber }),
    ]);
    return {
      epochId, epochEnd: Number(epochEnd), balance, now: Number(block.timestamp), settlementWindow: Number(settlementWindow),
      withdrawRequest: { epochId: withdraw[0], shares: withdraw[1] },
      depositRequest: { epochId: deposit[0], usdg: deposit[1], stock: deposit[2] },
    };
  } catch (error) {
    throw new Error("Could not check the vault before sending. Try again.", { cause: error });
  }
}
