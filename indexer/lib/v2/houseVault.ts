import type { Address, Hex } from "viem";

/** Lower-cased for the same reason src/v2/treasury.ts does it: addresses are compared as text. */
export const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

const ZERO = "0x0000000000000000000000000000000000000000";

export function meta(event: {
  block: { timestamp: bigint; number: bigint };
  log: { logIndex: number; address: Address };
  transaction: { hash: Hex };
}) {
  return {
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    sourceAddress: lower(event.log.address),
    ts: event.block.timestamp,
    block: event.block.number,
    logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  };
}

export function epochRowId(vault: string, epochId: bigint): string {
  return `${lower(vault)}-${epochId.toString()}`;
}

export function shareBalanceId(vault: string, account: string): string {
  return `${lower(vault)}-${lower(account)}`;
}

export function queueId(vault: string, account: string): string {
  return `${lower(vault)}-${lower(account)}`;
}

export type HouseLimits = {
  maxSeriesUnits: bigint;
  maxTotalNotional: bigint;
  askToleranceBps: number;
  maxBidBpsOfSpot: number;
  maxOrderLifetime: number;
  maxDailyOutflow: bigint;
};

/** LimitsSet.args.limits may be a named object or a 6-tuple depending on the decoder. */
export function decodeLimits(raw: unknown): HouseLimits {
  if (Array.isArray(raw) && raw.length >= 6) {
    return {
      maxSeriesUnits: BigInt(raw[0]),
      maxTotalNotional: BigInt(raw[1]),
      askToleranceBps: Number(raw[2]),
      maxBidBpsOfSpot: Number(raw[3]),
      maxOrderLifetime: Number(raw[4]),
      maxDailyOutflow: BigInt(raw[5]),
    };
  }
  const o = raw as Record<string, unknown>;
  return {
    maxSeriesUnits: BigInt(o.maxSeriesUnits as bigint | number | string),
    maxTotalNotional: BigInt(o.maxTotalNotional as bigint | number | string),
    askToleranceBps: Number(o.askToleranceBps),
    maxBidBpsOfSpot: Number(o.maxBidBpsOfSpot),
    maxOrderLifetime: Number(o.maxOrderLifetime),
    maxDailyOutflow: BigInt(o.maxDailyOutflow as bigint | number | string),
  };
}

export function nextShareBalance(previous: bigint | undefined, delta: bigint): bigint {
  const next = (previous ?? 0n) + delta;
  if (next < 0n) throw new Error("house vault share balance went negative");
  return next;
}

export function applyTransferSupply(previous: bigint | undefined, from: string, to: string, value: bigint): bigint {
  const start = previous ?? 0n;
  const mint = lower(from) === ZERO;
  const burn = lower(to) === ZERO;
  if (mint && burn) return start + value;
  if (mint) return start + value;
  if (burn) {
    const next = start - value;
    if (next < 0n) throw new Error("house vault share supply went negative");
    return next;
  }
  return start;
}

export type HouseFillArgs = {
  orderId: bigint;
  longId: bigint;
  maker: Address;
  taker: Address;
  units: bigint;
  price: bigint;
  premium: bigint;
  sellerFee: bigint;
  makerRebate: bigint;
};

export function houseFillRows(
  event: Parameters<typeof meta>[0] & { args: HouseFillArgs },
  vaults: Set<string>,
) {
  const provenance = meta(event);
  const maker = lower(event.args.maker);
  const taker = lower(event.args.taker);
  const rows: Array<Record<string, unknown>> = [];
  const push = (vault: string, side: string) => {
    rows.push({
      id: `${provenance.id}-${side}`,
      vault,
      side,
      orderId: event.args.orderId,
      longId: event.args.longId,
      maker,
      taker,
      units: event.args.units,
      price: event.args.price,
      premium: event.args.premium,
      sellerFee: event.args.sellerFee,
      makerRebate: event.args.makerRebate,
      ts: provenance.ts,
      block: provenance.block,
      logIndex: provenance.logIndex,
      tx: provenance.tx,
    });
  };
  if (vaults.has(maker)) push(maker, "maker");
  if (vaults.has(taker) && taker !== maker) push(taker, "taker");
  return rows;
}
