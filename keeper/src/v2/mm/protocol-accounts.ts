/**
 * Protocol-owned maker predicates for the MM quote plan (K8-05).
 *
 * THE HAZARD IS RESTING, NOT TAKING. Two protocol vaults quoting the same series
 * (vault A bidding 100 while vault B asks 99) lets any outside account take B then
 * hit A for a riskless 1 paid by depositors. Do not rest a quote that crosses a
 * protocol-owned maker's resting order on the same longId; skip that slot.
 *
 * There is no taker path here. `MmTx` and `quoter.ts callOf` have no `take`;
 * v8-plan/06-QUIRKS.md says the production bot never takes.
 *
 * Address compare is lower-case, matching `mm/mm-store.ts` `lc()`. Never checksum
 * equality (a stubbed viem identity `checksumAddress` made that class of test green).
 *
 * No viem, no chain read.
 */

export const lc = (a: string): string => a.toLowerCase();

export function isProtocolOwned(addr: string, set: ReadonlySet<string>): boolean {
  const want = lc(addr);
  if (set.has(want)) return true;
  for (const s of set) if (lc(s) === want) return true;
  return false;
}

export type ProtocolKind = 'Bid' | 'AskWrite' | 'AskResale';

export interface ProtocolResting {
  longId: bigint;
  maker: string;
  kind: ProtocolKind;
  price: bigint;
}

export interface ProtocolTarget {
  longId: bigint;
  side: 'bid' | 'ask';
  price: bigint;
}

export interface ProtocolBook {
  protocolAccounts: ReadonlySet<string>;
  resting: readonly ProtocolResting[];
}

const isAsk = (kind: ProtocolKind): boolean => kind === 'AskWrite' || kind === 'AskResale';
const isBid = (kind: ProtocolKind): boolean => kind === 'Bid';

/**
 * True when a bid we are about to rest at P is at or above a protocol-owned ask
 * on the same longId, or an ask we are about to rest is at or below a protocol-owned bid.
 */
export function crossesProtocol(target: ProtocolTarget, book: ProtocolBook): boolean {
  for (const o of book.resting) {
    if (o.longId !== target.longId) continue;
    if (!isProtocolOwned(o.maker, book.protocolAccounts)) continue;
    const crosses =
      (target.side === 'bid' && isAsk(o.kind) && target.price >= o.price) ||
      (target.side === 'ask' && isBid(o.kind) && target.price <= o.price);
    if (crosses) return true;
  }
  return false;
}
