import type { Address } from "viem";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** ERC-1155 ids use the low bit for the short side. */
export function positionId(tokenId: bigint) {
  return {
    longId: tokenId & ~1n,
    side: (tokenId & 1n) === 0n ? "long" as const : "short" as const,
  };
}

export function balanceId(tokenId: bigint, holder: Address): string {
  return `${tokenId}-${holder.toLowerCase()}`;
}

export function ledgerId(account: Address, asset: Address): string {
  return `${account.toLowerCase()}-${asset.toLowerCase()}`;
}

export function isWallet(address: Address, escrow: Address): boolean {
  const lower = address.toLowerCase();
  return lower !== ZERO_ADDRESS && lower !== escrow.toLowerCase();
}

export type TokenTransfer = {
  from: Address;
  to: Address;
  tokenId: bigint;
  units: bigint;
};

/**
 * The OrderBook holds resale inventory in escrow. Only wallet balances are stored here;
 * the live AskResale order records name the maker who still owns that inventory for PnL.
 */
export function walletDeltas(transfer: TokenTransfer, escrow: Address) {
  if (transfer.units < 0n) throw new Error("negative ERC-1155 transfer");
  if (transfer.from.toLowerCase() === transfer.to.toLowerCase()) return [];
  const deltas: { holder: Address; delta: bigint }[] = [];
  if (isWallet(transfer.from, escrow)) deltas.push({ holder: transfer.from, delta: -transfer.units });
  if (isWallet(transfer.to, escrow)) deltas.push({ holder: transfer.to, delta: transfer.units });
  return deltas;
}

/** Count only long mint/burn; every mint also moves an equal number of short tokens. */
export function openInterestDelta(transfer: TokenTransfer): bigint {
  if (positionId(transfer.tokenId).side === "short") return 0n;
  if (transfer.from.toLowerCase() === ZERO_ADDRESS && transfer.to.toLowerCase() !== ZERO_ADDRESS) {
    return transfer.units;
  }
  if (transfer.to.toLowerCase() === ZERO_ADDRESS && transfer.from.toLowerCase() !== ZERO_ADDRESS) {
    return -transfer.units;
  }
  return 0n;
}

/** Negative balances or open interest mean a log was missed; fail the replay visibly. */
export function addNonnegative(current: bigint, delta: bigint, label: string): bigint {
  const next = current + delta;
  if (next < 0n) throw new Error(`${label} underflow: ${current} + ${delta}`);
  return next;
}

export function marketStatus(enabled: boolean): "live" | "paused" {
  return enabled ? "live" : "paused";
}

export function tickerFromSymbol(symbol: string): string {
  const ticker = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.]{1,12}$/.test(ticker)) throw new Error(`invalid market ticker from ERC-20 symbol: ${symbol}`);
  return ticker;
}

export function setAddressFlag(json: string, address: Address, value: boolean): string {
  const flags = JSON.parse(json) as Record<string, boolean>;
  flags[address.toLowerCase()] = value;
  return JSON.stringify(Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))));
}

export function tenorFromWeekly(weekly: boolean): "weekly" | "daily" {
  return weekly ? "weekly" : "daily";
}
