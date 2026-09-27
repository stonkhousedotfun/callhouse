import { parseEventLogs, parseUnits, type Abi, type Address, type Hex, type Log, type TransactionReceipt } from "viem";

import { earnVaultAbi } from "../abi/v2/earnVault";
import { publicClient, robinhoodChain } from "../chain";
import { displayQuantity } from "../numberFormat";
import { resolveV2Address, requireV2Address } from "./config";
import { claimDeferredCall } from "./earnDeferred";
import { explainV2Error } from "./errors";
import type { WriteContext } from "./tx";
import { V2ReceiptUnknownError, waitForV2Receipt } from "./txStatus";

/**
 * THE VAULT ADDRESS IS RESOLVED, NOT HARDCODED. It used to `return null` unconditionally, with a
 * comment saying the vault must be "never an env var, never an API-only address". That
 * was reversed for the env-var half (the lending vault deploys soon and `/lend` must be able
 * to see it); the API half stands and is unchanged — an address still never comes from `/v2/config`
 * or from an epoch file, only from the generated registry or a validated build-time override.
 *
 * `resolveV2Address` (`config.ts:123-130`) reads the registry FIRST: `earnVault` is an external key
 * that the generated `V2_CONTRACTS` copies through from `v2.contracts` (`config.ts:52-57`), so a
 * deployed vault resolves from the registry and `NEXT_PUBLIC_V2_EARN_VAULT` cannot shadow it. The
 * override is read only while the registry is silent, else this resolves to nothing. Either way the
 * value goes through the same `getAddress` validator as every registry address, so a malformed
 * variable becomes `null` here rather than an unchecked cast reaching `simulateContract`.
 */
export function earnVaultAddress(): Address | null {
  return resolveV2Address("earnVault").address;
}

export function requireEarnVaultAddress(): Address {
  return requireV2Address("earnVault");
}

async function write(context: WriteContext, address: Address, abi: Abi, functionName: string, args: readonly unknown[],
  onMined?: (receipt: TransactionReceipt) => void): Promise<Hex> {
  const client = context.client ?? publicClient;
  if (await context.wallet.getChainId() !== robinhoodChain.id) throw new Error("Switch to Robinhood Chain to continue.");
  try {
    const { request } = await client.simulateContract({ account: context.account, address, abi, functionName, args });
    const hash = await context.wallet.writeContract({ ...request, account: context.account, chain: robinhoodChain });
    const receipt = await waitForV2Receipt(client, hash, functionName);
    // Reading the receipt can never turn a confirmed write into a retryable error.
    try { onMined?.(receipt); } catch { /* the id is then simply not reported */ }
    try { await context.onConfirmed?.(hash); } catch { /* A confirmed write remains final. */ }
    return hash;
  } catch (error) {
    if (error instanceof V2ReceiptUnknownError) throw error;
    throw new Error(explainV2Error(error), { cause: error });
  }
}

export async function depositToVault(context: WriteContext, assets: bigint): Promise<Hex> {
  if (assets <= 0n) throw new Error("Enter a positive deposit.");
  const vault = requireEarnVaultAddress();
  return write(context, vault, earnVaultAbi, "deposit", [assets, context.account]);
}

export async function redeemFromVault(context: WriteContext, shares: bigint): Promise<Hex> {
  if (shares <= 0n) throw new Error("Enter a positive share amount.");
  const vault = requireEarnVaultAddress();
  return write(context, vault, earnVaultAbi, "redeem", [shares, context.account]);
}

/**
 * MIRROR, DO NOT RE-REASON: EarnVault.redeem takes the shares from the caller on every path -- `_burn` when it
 * pays now, `_enqueue`'s `_transfer(msg.sender, ...)` when it queues -- so more than the wallet holds reverts in the share
 * token (ERC20InsufficientBalance). The same cap as the House withdrawal (houseGates.ts houseWithdrawGate). Returns the
 * line for the redeem button, or null when the amount fits, nothing valid is entered, or the balance is not read (an
 * unread balance refuses nothing; the simulation still does).
 */
export function lendRedeemOverBalance(shares: bigint | null, balance: bigint | null | undefined,
  format: (raw: bigint) => string): string | null {
  if (shares === null || typeof balance !== "bigint" || shares <= balance) return null;
  return `You hold ${format(balance)} shares. Enter that many or fewer.`;
}

/**
 * The redeem box: the typed amount in whole shares at the vault's own decimals() and the
 * over-balance line at the same decimals. Null shares while decimals() is unread (no redeem on a guessed unit) or the
 * text is not a positive amount; the balance is shown as the hero shows it (displayQuantity, 4 places).
 */
export function lendRedeemInput(raw: string, shareDecimals: number | null, balance: bigint | null | undefined):
  { shares: bigint | null; over: string | null } {
  let shares: bigint | null = null;
  if (shareDecimals !== null) {
    try {
      const amount = parseUnits(raw, shareDecimals);
      shares = amount > 0n ? amount : null;
    } catch { shares = null; }
  }
  const over = shareDecimals === null ? null
    : lendRedeemOverBalance(shares, balance, (value) => displayQuantity(value, shareDecimals, { maxDecimals: 4 }));
  return { shares, over };
}

/**
 * `redeemFromVault`, plus the queue id when the vault queued the redemption rather than paying it. The id
 * is read from THIS vault's `WithdrawalQueued` log in the receipt, as `depositQueuedIdFrom` does for deposits; null
 * when the redemption was paid now or the receipt could not be read.
 */
export async function redeemFromVaultTracked(context: WriteContext, shares: bigint): Promise<{ hash: Hex; queuedId: bigint | null }> {
  if (shares <= 0n) throw new Error("Enter a positive share amount.");
  const vault = requireEarnVaultAddress();
  let queuedId: bigint | null = null;
  const hash = await write(context, vault, earnVaultAbi, "redeem", [shares, context.account],
    (receipt) => { queuedId = withdrawalQueuedIdFrom(receipt, vault); });
  return { hash, queuedId };
}

/**
 * Takes a queued request back: a withdrawal returns its escrowed shares, a deposit its escrowed USDG. The
 * contract lets only the request's it (`NotAuthorized` otherwise), and the simulation says so before any
 * wallet prompt.
 */
export async function cancelQueuedRequest(context: WriteContext, id: bigint): Promise<Hex> {
  if (id <= 0n) throw new Error("This request has no queue id to cancel.");
  const vault = requireEarnVaultAddress();
  return write(context, vault, earnVaultAbi, "cancelQueued", [id]);
}

/**
 * Pays out a payment the vault HELD for request `id` (lib/v2/earnDeferred.ts), to `to`. Sent only to the
 * registry vault. The request's owner and receiver and the amount are RE-READ from `deferred(id)` right before the
 * call, so the owner-or-receiver check `claimDeferredCall` makes (the one the contract enforces) runs on the chain's
 * answer, not on a list read a minute ago; the simulation then checks it once more before any wallet prompt.
 */
export async function claimDeferredPayment(context: WriteContext, id: bigint, to: string): Promise<Hex> {
  if (id <= 0n) throw new Error("This held payment has no request id.");
  const vault = requireEarnVaultAddress();
  const client = context.client ?? publicClient;
  const [owner, receiver, assets] = await client.readContract({ address: vault, abi: earnVaultAbi, functionName: "deferred", args: [id] });
  // The checks (owner or receiver, something held, a canonical non-zero `to`); the write site names the generated ABI and
  // the function literally, so lib/v2/wiring.test.ts can judge it against the role manifest (claimDeferred is unrestricted).
  const call = claimDeferredCall({ vault, id, owner, receiver, assets }, context.account, to);
  return write(context, vault, earnVaultAbi, "claimDeferred", call.args);
}

export async function processVaultQueue(context: WriteContext, maxEntries: bigint): Promise<Hex> {
  const vault = requireEarnVaultAddress();
  return write(context, vault, earnVaultAbi, "processQueue", [maxEntries]);
}

/**
 * While a position or a queue is open, `deposit` returns 0 and emits
 * `DepositQueued(id, owner, ...)` instead of minting. The notice after a queued deposit quotes that id, read from
 * THIS vault's log in the receipt -- never from another contract's event with the same shape. Null when the deposit
 * was instant (no such log) or the receipt could not be read.
 */
export function depositQueuedIdFrom(receipt: { logs: Log[] }, vault: Address): bigint | null {
  const events = parseEventLogs({ abi: earnVaultAbi, eventName: "DepositQueued", logs: receipt.logs, strict: false });
  const mine = events.find((e) => e.address.toLowerCase() === vault.toLowerCase());
  const id = mine?.args && "id" in mine.args ? mine.args.id : undefined;
  return typeof id === "bigint" ? id : null;
}

/** The `WithdrawalQueued` id from THIS vault's log in a redeem receipt; null when it was paid now. */
export function withdrawalQueuedIdFrom(receipt: { logs: Log[] }, vault: Address): bigint | null {
  const events = parseEventLogs({ abi: earnVaultAbi, eventName: "WithdrawalQueued", logs: receipt.logs, strict: false });
  const mine = events.find((e) => e.address.toLowerCase() === vault.toLowerCase());
  const id = mine?.args && "id" in mine.args ? mine.args.id : undefined;
  return typeof id === "bigint" ? id : null;
}

/** `depositToVault`, plus the queue id when the deposit was queued rather than minted. */
export async function depositToVaultTracked(context: WriteContext, assets: bigint): Promise<{ hash: Hex; queuedId: bigint | null }> {
  if (assets <= 0n) throw new Error("Enter a positive deposit.");
  const vault = requireEarnVaultAddress();
  let queuedId: bigint | null = null;
  const hash = await write(context, vault, earnVaultAbi, "deposit", [assets, context.account],
    (receipt) => { queuedId = depositQueuedIdFrom(receipt, vault); });
  return { hash, queuedId };
}
