/** Match one ERC-1155 delivery to each fill, and the preceding burn/mint to its receipt.
 * The contract's event order is frozen in interfaces §1.8: delivery, then OrderFilled;
 * Taken follows the full loop. Order placement and cancellation escrow moves are never sales. */
export type IndexedTransfer = {
  id: string; tx: string; longId: bigint; from: string; to: string; units: bigint; logIndex: number;
};
export type IndexedFill = {
  id: string; tx: string; longId: bigint; buyer: string; seller: string;
  takerIsBuyer: boolean; units: bigint; logIndex: number; primary: boolean;
};
export type IndexedMint = {
  id: string; tx: string; longId: bigint; longTo: string; units: bigint; logIndex: number;
};
export type IndexedExit = {
  id: string; tx: string; longId: bigint; holder: string; units: bigint; logIndex: number;
};

const ZERO = "0x0000000000000000000000000000000000000000";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function matchDeliveries(
  transfers: readonly IndexedTransfer[],
  fills: readonly IndexedFill[],
  mints: readonly IndexedMint[],
  exits: readonly IndexedExit[],
  book: string,
): { matchedTransfers: Set<string>; matchedMints: Set<string> } {
  const matchedTransfers = new Set<string>();
  const matchedMints = new Set<string>();

  function preceding(input: { tx: string; longId: bigint; units: bigint; logIndex: number },
    predicate: (transfer: IndexedTransfer) => boolean): IndexedTransfer | undefined {
    return transfers.filter((transfer) =>
      !matchedTransfers.has(transfer.id) && same(transfer.tx, input.tx) &&
      transfer.longId === input.longId && transfer.units === input.units &&
      transfer.logIndex < input.logIndex && predicate(transfer))
      .sort((a, b) => b.logIndex - a.logIndex)[0];
  }

  for (const fill of [...fills].sort((a, b) => a.logIndex - b.logIndex)) {
    const delivery = preceding(fill, (transfer) => same(transfer.to, fill.buyer) &&
      (fill.primary ? same(transfer.from, ZERO) :
        fill.takerIsBuyer ? same(transfer.from, book) : same(transfer.from, fill.seller)));
    if (delivery === undefined) throw new Error(`Fill ${fill.id} has no preceding long delivery`);
    matchedTransfers.add(delivery.id);
    if (fill.primary) {
      const mint = mints.filter((item) => !matchedMints.has(item.id) &&
        same(item.tx, fill.tx) && item.longId === fill.longId && item.units === fill.units &&
        same(item.longTo, fill.buyer) && item.logIndex < fill.logIndex)
        .sort((a, b) => b.logIndex - a.logIndex)[0];
      if (mint === undefined) throw new Error(`Primary fill ${fill.id} has no preceding Minted`);
      matchedMints.add(mint.id);
    }
  }

  for (const mint of mints) {
    if (matchedMints.has(mint.id)) continue;
    const delivery = preceding(mint, (transfer) => same(transfer.from, ZERO) && same(transfer.to, mint.longTo));
    if (delivery === undefined) throw new Error(`Mint ${mint.id} has no preceding long delivery`);
    matchedTransfers.add(delivery.id);
  }

  for (const exit of exits) {
    const burn = preceding(exit, (transfer) => same(transfer.from, exit.holder) && same(transfer.to, ZERO));
    if (burn === undefined) throw new Error(`Exit ${exit.id} has no preceding long burn`);
    matchedTransfers.add(burn.id);
  }
  return { matchedTransfers, matchedMints };
}

export type FeeFill = { id: string; tx: string; longId: bigint; taker: string; takerIsBuyer: boolean;
  units: bigint; premium: bigint; logIndex: number };
export type TakenCall = { tx: string; longId: bigint; taker: string; buying: boolean;
  units: bigint; premium: bigint; takerFee: bigint; logIndex: number };

/** Taken is last for a call; walk its immediately preceding, still-unassigned maker fills. */
export function matchTakeFees(fills: readonly FeeFill[], calls: readonly TakenCall[]): Map<string, bigint> {
  const fees = new Map<string, bigint>();
  const assigned = new Set<string>();
  for (const call of [...calls].sort((a, b) => a.logIndex - b.logIndex)) {
    let missing = call.units;
    const matched: FeeFill[] = [];
    const candidates = fills.filter((fill) => !assigned.has(fill.id) && same(fill.tx, call.tx) &&
      fill.longId === call.longId && same(fill.taker, call.taker) &&
      fill.takerIsBuyer === call.buying && fill.logIndex < call.logIndex)
      .sort((a, b) => b.logIndex - a.logIndex);
    for (const fill of candidates) {
      if (missing === 0n) break;
      if (fill.units > missing) throw new Error("Taken spans part of an OrderFilled");
      matched.push(fill);
      missing -= fill.units;
    }
    if (missing !== 0n) throw new Error(`Taken ${call.tx}-${call.logIndex} missing ${missing} fill units`);
    const inLogOrder = matched.reverse();
    const premium = inLogOrder.reduce((sum, fill) => sum + fill.premium, 0n);
    if (premium !== call.premium) throw new Error(`Taken ${call.tx}-${call.logIndex} premium mismatch`);
    if (premium === 0n && call.takerFee !== 0n) throw new Error("taker fee without premium");
    let allocated = 0n;
    inLogOrder.forEach((fill, i) => {
      const fee = i === inLogOrder.length - 1 ? call.takerFee - allocated : call.takerFee * fill.premium / premium;
      fees.set(fill.id, fee);
      allocated += fee;
      assigned.add(fill.id);
    });
  }
  if (assigned.size !== fills.length) throw new Error("OrderFilled without matching Taken");
  return fees;
}
