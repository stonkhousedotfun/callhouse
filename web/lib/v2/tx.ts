import { parseEventLogs, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";

import { erc20Abi } from "../abi/erc20";
import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { orderBookAbi } from "../abi/v2/orderBook";
import { publicClient, robinhoodChain } from "../chain";
import { requireV2Address } from "./config";
import { explainV2Error } from "./errors";
import { feeBoundTakeDeadline } from "./feeDeadline";
import { V2ReceiptUnknownError, waitForV2Receipt } from "./txStatus";

export type WriteContext = {
  account: Address;
  wallet: WalletClient;
  client?: PublicClient;
  onConfirmed?: (hash: Hex) => void | Promise<void>;
};

export class V2WriteError extends Error {
  constructor(cause: unknown) {
    super(explainV2Error(cause), { cause });
    this.name = "V2WriteError";
  }
}

/** Simulate every write against the current chain state, then await inclusion. */
async function simulatedWrite(
  context: WriteContext, address: Address, abi: Abi, functionName: string, args: readonly unknown[],
  onMined?: (receipt: TransactionReceipt) => void,
): Promise<Hex> {
  const client = context.client ?? publicClient;
  if (await context.wallet.getChainId() !== robinhoodChain.id) throw new Error("Switch to Robinhood Chain to continue.");
  try {
    const { request } = await client.simulateContract({
      account: context.account, address, abi, functionName, args,
    });
    const hash = await context.wallet.writeContract({ ...request, account: context.account, chain: robinhoodChain });
    const receipt = await waitForV2Receipt(client, hash, functionName);
    // Receipt processing cannot turn a confirmed write into a retryable error.
    try { onMined?.(receipt); } catch { /* caller treats an unreadable result as unknown */ }
    // A UI refresh failure after a confirmed tx must never invite a duplicate fill.
    try { await context.onConfirmed?.(hash); } catch { /* receipt is still final */ }
    return hash;
  } catch (error) {
    if (error instanceof V2ReceiptUnknownError) throw error;
    throw new V2WriteError(error);
  }
}

/** ERC-20 approval amount is the exact shortfall target, never an unlimited allowance. */
export function exactApprovalAmount(allowance: bigint, required: bigint): bigint {
  if (required <= 0n) throw new RangeError("Approval amount must be positive");
  return allowance >= required ? 0n : required;
}

export async function approveExact(
  context: WriteContext, asset: Address, spender: Address, required: bigint,
): Promise<Hex | null> {
  const client = context.client ?? publicClient;
  const [balance, allowance] = await client.multicall({ allowFailure: false, contracts: [
    { address: asset, abi: erc20Abi, functionName: "balanceOf", args: [context.account] },
    { address: asset, abi: erc20Abi, functionName: "allowance", args: [context.account, spender] },
  ] });
  if (balance < required) throw new Error("Your wallet does not have enough of this token.");
  const amount = exactApprovalAmount(allowance, required);
  if (amount === 0n) return null;
  return simulatedWrite(context, asset, erc20Abi, "approve", [spender, amount]);
}

export type TakeParams = {
  longId: bigint;
  buying: boolean;
  orderIds: bigint[];
  units: bigint;
  minUnits: bigint;
  limitPrice: bigint;
  writeToSell: boolean;
  recipient: Address;
  deadline: number;
};

export type ExpectedTakeQuote = {
  filled: bigint;
  premium: bigint;
  fee: bigint;
  resaleFeeBps?: number;
};

/** Read the quote and fee schedule at one chain block, then expire the take before any fee activation. */
export async function recheckTakeQuote(
  context: WriteContext, paramsWithoutDeadline: Omit<TakeParams, "deadline">, expected: ExpectedTakeQuote,
): Promise<TakeParams> {
  const client = context.client ?? publicClient;
  const address = requireV2Address("orderBook");
  const block = await client.getBlock({ blockTag: "latest" });
  const now = Number(block.timestamp);
  const [pending, effectiveFees] = await Promise.all([
    client.readContract({ address, abi: orderBookAbi, functionName: "pendingFeeParams", blockNumber: block.number }),
    expected.resaleFeeBps === undefined ? Promise.resolve(null) :
      client.readContract({ address, abi: orderBookAbi, functionName: "feeParams", blockNumber: block.number }),
  ]);
  const deadline = feeBoundTakeDeadline(now, BigInt(pending[1]));
  if (deadline <= now) throw new Error("A fee change is too close to this trade. Refresh the quote after it activates.");
  const params = { ...paramsWithoutDeadline, deadline };
  const [filled, premium, fee] = await client.readContract({ account: context.account, address,
    abi: orderBookAbi, functionName: "quoteTake", args: [params], blockNumber: block.number });
  if (effectiveFees && effectiveFees.resaleFeeBps !== expected.resaleFeeBps)
    throw new Error("The resale fee changed. Refresh the quote and review the new proceeds.");
  if (filled !== expected.filled || premium !== expected.premium || fee !== expected.fee)
    throw new Error("The on-chain quote changed. Refresh and review the trade before continuing.");
  if (filled < params.minUnits) throw new Error("There is not enough depth for this fill. Choose a smaller size.");
  return params;
}

export type TakeResult = { hash: Hex; unitsFilled: bigint | null };

export async function take(context: WriteContext, params: TakeParams): Promise<TakeResult> {
  if (params.units <= 0n || params.minUnits <= 0n || params.minUnits > params.units || !params.orderIds.length)
    throw new RangeError("Select a positive quantity and at least one order.");
  if (!Number.isSafeInteger(params.deadline) || params.deadline <= 0) throw new RangeError("Refresh this expired quote.");
  const address = requireV2Address("orderBook");
  let unitsFilled: bigint | null = null;
  const hash = await simulatedWrite(context, address, orderBookAbi, "take", [params], (receipt) => {
    const taken = parseEventLogs({ abi: orderBookAbi, logs: receipt.logs, eventName: "Taken", strict: true })
      .filter((log) => log.address.toLowerCase() === address.toLowerCase() &&
        log.args.taker.toLowerCase() === context.account.toLowerCase() &&
        log.args.longId === params.longId && log.args.buying === params.buying);
    if (taken.length === 1) unitsFilled = taken[0]!.args.units;
  });
  return { hash, unitsFilled };
}

export async function place(context: WriteContext, longId: bigint, kind: 0 | 1 | 2, price: bigint, units: bigint, validUntil: number) {
  if (price <= 0n || units <= 0n || validUntil <= Math.floor(Date.now() / 1000))
    throw new RangeError("Enter a positive price, quantity and future expiry.");
  return simulatedWrite(context, requireV2Address("orderBook"), orderBookAbi, "place", [longId, kind, price, units, validUntil]);
}

export function cancel(context: WriteContext, orderIds: bigint[]) {
  if (!orderIds.length) throw new RangeError("Choose an order to cancel.");
  return simulatedWrite(context, requireV2Address("orderBook"), orderBookAbi, "cancel", [orderIds]);
}

export function replace(context: WriteContext, orderId: bigint, price: bigint, units: bigint) {
  if (price <= 0n || price % 100n !== 0n || units <= 0n)
    throw new RangeError("Choose a positive tick price and size to replace this order.");
  return simulatedWrite(context, requireV2Address("orderBook"), orderBookAbi, "replace", [orderId, price, units]);
}

export function redeem(context: WriteContext, tokenId: bigint, holder: Address = context.account) {
  return simulatedWrite(context, requireV2Address("clearinghouse"), clearinghouseAbi, "redeem", [tokenId, holder]);
}

/** Burns matched long and short units held by the same wallet, releasing collateral. */
export function close(context: WriteContext, longId: bigint, units: bigint) {
  if (units <= 0n) throw new RangeError("Close size must be positive.");
  return simulatedWrite(context, requireV2Address("clearinghouse"), clearinghouseAbi, "close", [longId, units]);
}

export function deposit(context: WriteContext, asset: Address, amount: bigint) {
  if (amount <= 0n) throw new RangeError("Enter a positive deposit.");
  return simulatedWrite(context, requireV2Address("clearinghouse"), clearinghouseAbi, "deposit", [asset, amount, context.account]);
}

export function withdraw(context: WriteContext, asset: Address, amount: bigint) {
  if (amount <= 0n) throw new RangeError("Enter a positive withdrawal.");
  return simulatedWrite(context, requireV2Address("clearinghouse"), clearinghouseAbi, "withdraw", [asset, amount, context.account]);
}

export function setOperator(context: WriteContext, operator: Address, approved: boolean) {
  return simulatedWrite(context, requireV2Address("clearinghouse"), clearinghouseAbi, "setOperator", [operator, approved]);
}

export function setTokenApproval(context: WriteContext, operator: Address, approved: boolean) {
  return simulatedWrite(context, requireV2Address("clearinghouse"), clearinghouseAbi, "setApprovalForAll", [operator, approved]);
}

export function setPayoutInKind(context: WriteContext, enabled: boolean) {
  return simulatedWrite(context, requireV2Address("clearinghouse"), clearinghouseAbi, "setPayoutInKind", [enabled]);
}

export function setPayoutToLedger(context: WriteContext, enabled: boolean) {
  return simulatedWrite(context, requireV2Address("clearinghouse"), clearinghouseAbi, "setPayoutToLedger", [enabled]);
}
