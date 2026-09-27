/**
 * Payments the lending vault HELD for the connected wallet, and the claim that pays one out.
 *
 * WHY A PAYMENT IS HELD (callhouse-contracts src/v2/periphery/earn/EarnVault.sol `_payOrDefer`).
 * `processQueue` no longer reverts when the asset refuses a transfer (USDG can freeze an address): the request
 * completes, and the amount is kept in the vault against its request id until the request's OWNER or its RECEIVER
 * calls `claimDeferred(id, to)`, to ANY non-zero `to`. That covers a queued withdrawal paid in full or in part, and a
 * queued deposit the vault refunded. Nothing is paid "automatically" once it is held.
 *
 * WHERE THE LIST COMES FROM: THE CHAIN, NOT THE INDEXER. `/v2/earn` lists only a wallet's still-queued requests
 * (indexer/src/api/v2/earn.ts), so a served request, the only kind that can be held, never reaches the app. And the
 * indexer's held rows miss a hold that predates its start block. So this file reads the
 * vault itself: `deferredAssets()` first, and only when something is held anywhere, `deferred(id)` for the request
 * ids `1..tail` (`queue()`), newest first, capped at HELD_SCAN_MAX. What it returns is the chain at the block it read,
 * not an index that may lag; a read that fails says "could not be checked", never "nothing held".
 */
import { useQuery } from "@tanstack/react-query";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";

import { earnVaultAbi } from "../abi/v2/earnVault";
import { publicClient } from "../chain";
import { fmtUsdg } from "../format";

/** How many request ids one read checks, newest first. A vault with more requests says the list may be incomplete. */
export const HELD_SCAN_MAX = 2_000;
/** `deferred(id)` calls per multicall. */
const CHUNK = 250;
const ZERO = "0x0000000000000000000000000000000000000000";

export type HeldPayment = {
  vault: Address;
  /** The request id the payment is held against: the `claimDeferred` argument. */
  id: bigint;
  /** The request's owner and receiver: the only two addresses the vault lets claim it (`NotAuthorized` otherwise). */
  owner: Address;
  receiver: Address;
  /** Asset base units held (USDG, 6 dp). */
  assets: bigint;
};

export type HeldPaymentsRead =
  | { status: "ok"; items: HeldPayment[]; complete: boolean; checked: number }
  | { status: "unavailable"; reason: string };

type Reader = Pick<PublicClient, "readContract" | "multicall">;

/**
 * The payments `vault` holds that `wallet` may claim (owner or receiver), newest request first.
 * Never throws: a failed read is `unavailable`, so the page says it could not check rather than "nothing held".
 */
export async function readHeldPayments(vault: Address, wallet: Address, client: Reader = publicClient): Promise<HeldPaymentsRead> {
  try {
    const [total, queue] = await Promise.all([
      client.readContract({ address: vault, abi: earnVaultAbi, functionName: "deferredAssets" }) as Promise<bigint>,
      client.readContract({ address: vault, abi: earnVaultAbi, functionName: "queue" }) as Promise<readonly [bigint, bigint]>,
    ]);
    // Nothing held for anyone: no per-id reads at all.
    if (total === 0n) return { status: "ok", items: [], complete: true, checked: 0 };
    const tail = queue[1];
    const ids: bigint[] = [];
    for (let id = tail; id >= 1n && ids.length < HELD_SCAN_MAX; id -= 1n) ids.push(id);
    const me = wallet.toLowerCase();
    const items: HeldPayment[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const results = await client.multicall({
        allowFailure: true,
        contracts: slice.map((id) => ({ address: vault, abi: earnVaultAbi, functionName: "deferred", args: [id] }) as const),
      });
      results.forEach((result, k) => {
        if (result.status !== "success") throw new Error(`deferred(${slice[k]}) could not be read`);
        const [owner, receiver, assets] = result.result as readonly [Address, Address, bigint];
        if (assets === 0n) return;
        if (owner.toLowerCase() !== me && receiver.toLowerCase() !== me) return;
        items.push({ vault, id: slice[k]!, owner: getAddress(owner), receiver: getAddress(receiver), assets });
      });
    }
    return { status: "ok", items, complete: tail <= BigInt(HELD_SCAN_MAX), checked: ids.length };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
}

/** Under the `v2` key prefix, so the invalidation after any write (a claim included) re-reads it. */
export function useHeldPayments(vault: Address | null | undefined, wallet: Address | undefined) {
  return useQuery({
    queryKey: ["v2", "earnHeldPayments", vault?.toLowerCase(), wallet?.toLowerCase()],
    queryFn: () => readHeldPayments(vault!, wallet!),
    enabled: Boolean(vault && wallet),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/*//////////////////////////////////////////////////////////////
                           THE RECEIVER
//////////////////////////////////////////////////////////////*/

export type ReceiverCheck = { ok: true; address: Address } | { ok: false; reason: string };

/**
 * A receiver typed by the user, accepted only in its canonical (EIP-55 checksummed) form. viem's
 * `isAddress(x, { strict: true })` still accepts an all-lowercase address, which carries no checksum, so the rule here
 * is canonical equality: `x === getAddress(x)`. A typo in a checksummed address fails the checksum instead of sending
 * the payment to a stranger. The zero address is refused, as `claimDeferred` refuses it on chain.
 */
export function parseReceiver(text: string): ReceiverCheck {
  const value = text.trim();
  if (value === "") return { ok: false, reason: "Enter the address to pay." };
  if (!isAddress(value, { strict: false })) return { ok: false, reason: "That is not an address." };
  const canonical = getAddress(value);
  if (!isAddress(value, { strict: true }) || value !== canonical) {
    return { ok: false, reason: "Paste the address exactly as your wallet shows it, with its mixed-case checksum." };
  }
  if (canonical === ZERO) return { ok: false, reason: "The zero address cannot receive a payment." };
  return { ok: true, address: canonical };
}

/*//////////////////////////////////////////////////////////////
                             THE CLAIM
//////////////////////////////////////////////////////////////*/

/**
 * The `claimDeferred(id, to)` call for one held payment, after the checks the vault makes: the caller must be the
 * request's owner or receiver (`NotAuthorized`), something must be held (`BadUnits`), and `to` must be a canonical,
 * non-zero address. Throws the reason instead of building a call the chain would refuse.
 */
export function claimDeferredCall(held: Pick<HeldPayment, "vault" | "id" | "owner" | "receiver" | "assets">, caller: Address, to: string) {
  const me = caller.toLowerCase();
  if (me !== held.owner.toLowerCase() && me !== held.receiver.toLowerCase()) {
    throw new Error(`Only the request's owner or its receiver can claim held payment #${held.id}.`);
  }
  if (held.assets <= 0n) throw new Error(`Nothing is held for request #${held.id} any more.`);
  const receiver = parseReceiver(to);
  if (!receiver.ok) throw new Error(receiver.reason);
  return { address: held.vault, abi: earnVaultAbi, functionName: "claimDeferred" as const, args: [held.id, receiver.address] as const };
}

/*//////////////////////////////////////////////////////////////
                             THE CARDS
//////////////////////////////////////////////////////////////*/

export type HeldPaymentCard = {
  key: string;
  held: HeldPayment;
  title: string;
  amount: string;
  /** Why it is held and who may claim it. */
  why: string;
  /** Present when the wallet's own address is the one the vault could not pay. */
  receiverWarning: string | null;
  /** The receiver field's starting value: the connected wallet, canonical. */
  defaultReceiver: Address;
  claimLabel: string;
};

export type HeldPaymentsView = {
  cards: HeldPaymentCard[];
  /** A line under the list: the read failed, or it could not check every request. Null when there is nothing to say. */
  status: string | null;
};

/** The section's title, which the queue notes (lib/v2/earnQueue.ts) name as the place to claim. */
export const HELD_SECTION_TITLE = "Payments held for you";

export const HELD_EXPLAINER =
  "The vault served these requests but could not deliver the payment, usually because the receiving address cannot "
  + "receive USDG right now. The money is held for you in the vault. Claim it to any address you choose; the list is "
  + "read from the chain, not from the indexer.";

export function heldPaymentsView(read: HeldPaymentsRead | undefined, wallet: Address | undefined): HeldPaymentsView {
  if (!wallet || read === undefined) return { cards: [], status: null };
  if (read.status === "unavailable") {
    return { cards: [], status: "Payments held for you by the lending vault could not be checked right now." };
  }
  const me = getAddress(wallet);
  const cards = read.items.map((held): HeldPaymentCard => {
    const role = held.owner.toLowerCase() === me.toLowerCase()
      ? (held.receiver.toLowerCase() === me.toLowerCase() ? "you made the request and were to receive it" : "you made the request")
      : "you were to receive it";
    return {
      key: `${held.vault.toLowerCase()}-${held.id}`,
      held,
      title: `Held payment for request #${held.id}`,
      amount: `${fmtUsdg(held.assets, 2)} USDG`,
      why: `The vault could not pay ${held.receiver}, so it is holding the payment. You can claim it because ${role}.`,
      receiverWarning: held.receiver.toLowerCase() === me.toLowerCase()
        ? "This wallet is the address the vault could not pay. If USDG cannot be sent to it, claim to another address you control."
        : null,
      defaultReceiver: me,
      claimLabel: "Claim",
    };
  });
  const status = read.complete ? null
    : `Only the latest ${read.checked.toLocaleString("en-US")} requests were checked; an older held payment may not be listed.`;
  return { cards, status };
}
