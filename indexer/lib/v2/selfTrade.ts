/** Deterministic, database-free reduction for the measured linked-wallet resale pattern. */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PRICE_TICK = 100n; // mirrors callhouse-contracts src/v2/interfaces/V2Constants.sol:32 (PRICE_TICK)

/** One tick is the minimum legal price; the band measures only that floor-priced primary leg. */
export const SELF_TRADE_MIN_PRICE_TICKS = 1n;

/**
 * The band that is SUSPECTED but not counted. D18 accepted the self-trade loophole on condition
 * that the indexer flags the pattern, and the counted band alone does not satisfy that: the
 * attribution below fires only on the conjunction `takerIsBuyer && minimumPrice && linked`, so
 * the two cheapest evasions both produce a counted total of exactly 0 -
 *
 *   (a) price the primary leg at TWO ticks instead of one - still trivially below fair, and
 *       `minimumPrice` goes false, so nothing is counted;
 *   (b) fund the second wallet from OFF chain, so no cash-flow / operator / approval / delegate
 *       edge exists, `linked` goes false, and again nothing is counted.
 *
 * A bare 0 cannot be told apart from "nobody is self-trading", which is the false-green shape
 * this codebase keeps hitting. SELF_TRADE_MIN_PRICE_TICKS is deliberately LEFT AT 1n so the
 * counted number does not silently change meaning for anything already consuming it; this wider
 * band feeds `unseen` instead, which records what the detector can see the shape of but cannot
 * adjudicate.
 */
export const SELF_TRADE_SUSPECT_PRICE_TICKS = 10n;

type Position = { block: bigint; logIndex: number; ts: bigint };

export type SelfTradeFillEvent = Position & {
  kind: "fill";
  id: string;
  longId: bigint;
  maker: string;
  taker: string;
  recipient: string;
  buyer: string;
  seller: string;
  units: bigint;
  price: bigint;
  primary: boolean;
  takerIsBuyer: boolean;
  /** Deliberately not used as the mandatory trigger; pricing can be unavailable. */
  fairAtFill: bigint | null;
};

export type SelfTradeTransferEvent = Position & {
  kind: "transfer";
  id: string;
  longId: bigint;
  from: string;
  to: string;
  units: bigint;
};

/** Only unmatched/direct Minted rows belong here; fill-associated mints are represented by the fill. */
export type SelfTradeMintEvent = Position & {
  kind: "mint";
  id: string;
  longId: bigint;
  holder: string;
  units: bigint;
};

export type SelfTradeExitEvent = Position & {
  kind: "close" | "redemption";
  id: string;
  longId: bigint;
  holder: string;
  units: bigint;
};

export type SelfTradeEvent = SelfTradeFillEvent | SelfTradeTransferEvent | SelfTradeMintEvent | SelfTradeExitEvent;

export type SelfTradeLinkEvidence = {
  left: string;
  right: string;
  source: "cash-flow" | "operator" | "approval" | "delegate";
};

export type SelfTradeAccountLinks = {
  account: string;
  operators: string;
  approvals: string;
  delegates: string;
};

export type SelfTradeCashFlow = { account: string; actor: string };

export type SelfTradeLink = { id: string; left: string; right: string };

/** A null writer is ordinary inventory. Zero-remaining rows stay in state for durable assignment. */
export type SelfTradeLot = {
  id: string;
  longId: bigint;
  holder: string;
  writer: string | null;
  primaryFillId: string | null;
  units: bigint;
  remaining: bigint;
  createdBlock: bigint;
  createdLogIndex: number;
  sourceId: string;
};

export type SelfTradeMaker = { writer: string; units: bigint };

/**
 * Why a primary leg that LOOKS like the pattern was not counted. These are the detector's blind
 * spots stated as data, so a consumer can distinguish "no self-trading was detected" from "the
 * detector could not see it" without reading a comment.
 */
export type SelfTradeUnseenReason =
  /** Linked wallets, taker-is-buyer, but the price sits above the counted floor band. Evasion (a). */
  | "price-above-counted-band"
  /** Floor-priced, taker-is-buyer, but no indexed edge joins the two wallets. Evasion (b). */
  | "no-link-evidence";

export type SelfTradeUnseen = { reason: SelfTradeUnseenReason; units: bigint; fills: number };

export type SelfTradeState = {
  /** Last complete block reduced; applying that block again is a no-op. */
  cursor: bigint;
  links: SelfTradeLink[];
  lots: SelfTradeLot[];
  makers: SelfTradeMaker[];
  /**
   * Primary legs shaped like the pattern that the conjunction refused to attribute. Never merged
   * into `makers`: a suspicion is not a measurement, and counting it would overstate the metric
   * exactly as surely as dropping it understates the detector's blindness.
   *
   * OPTIONAL ON INPUT, ALWAYS PRESENT ON OUTPUT, and the reason is a gap this row could not close:
   * the persistence layer rebuilds this state from the v2SelfTrade* tables (indexer/src/v2/pnl.ts,
   * the object literal passed to `reduceSelfTrade`), and THERE IS NO TABLE FOR THIS FIELD. So a
   * reduction accumulates it within a run and the next run starts from undefined. Making it
   * required here would not fix that - it would only fail to compile at that call site, which is
   * outside this task's fence. Until a table and an API field exist, treat this as within-run
   * evidence, not a durable metric.
   */
  unseen?: SelfTradeUnseen[];
};

export type SelfTradeBatch = {
  through: bigint;
  throughTimestamp: bigint;
  events: readonly SelfTradeEvent[];
  linkEvidence: readonly SelfTradeLinkEvidence[];
  seriesExpiries: readonly { longId: bigint; expiry: bigint }[];
  /** `matchDeliveries(...).matchedTransfers`; sale delivery, mint, burn, and escrow legs are not links. */
  matchedTransferIds: ReadonlySet<string>;
  /** Construct this from the V2_* addresses in indexer/lib/env.ts, never from registry placeholders. */
  protocolAddresses: readonly (string | null | undefined)[];
};

const key = (value: string): string => value.toLowerCase();

function flags(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Invalid account link map");
  return Object.entries(parsed).filter(([, enabled]) => enabled === true).map(([address]) => address);
}

/** Convert exactly the persistent indexed relationship facts into reducer evidence. */
export function indexedSelfTradeLinks(
  accounts: readonly SelfTradeAccountLinks[],
  cashFlows: readonly SelfTradeCashFlow[],
): SelfTradeLinkEvidence[] {
  const evidence: SelfTradeLinkEvidence[] = [];
  for (const flow of cashFlows) {
    if (key(flow.account) !== key(flow.actor)) evidence.push({ left: flow.account, right: flow.actor, source: "cash-flow" });
  }
  for (const account of accounts) {
    for (const operator of flags(account.operators)) evidence.push({ left: account.account, right: operator, source: "operator" });
    for (const approval of flags(account.approvals)) evidence.push({ left: account.account, right: approval, source: "approval" });
    for (const delegate of flags(account.delegates)) evidence.push({ left: account.account, right: delegate, source: "delegate" });
  }
  return evidence;
}

export function emptySelfTradeState(cursor = -1n): SelfTradeState {
  return { cursor, links: [], lots: [], makers: [], unseen: [] };
}

class Links {
  readonly edges = new Map<string, SelfTradeLink>();
  private readonly parent = new Map<string, string>();

  constructor(private readonly excluded: ReadonlySet<string>) {}

  private find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) {
      this.parent.set(value, value);
      return value;
    }
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  add(leftRaw: string, rightRaw: string): void {
    const left = key(leftRaw);
    const right = key(rightRaw);
    if (left === right || this.excluded.has(left) || this.excluded.has(right)) return;
    const [first, second] = left < right ? [left, right] : [right, left];
    this.edges.set(`${first}:${second}`, { id: `${first}:${second}`, left: first, right: second });
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot !== secondRoot) this.parent.set(secondRoot, firstRoot);
  }

  connected(leftRaw: string, rightRaw: string): boolean {
    const left = key(leftRaw);
    const right = key(rightRaw);
    if (this.excluded.has(left) || this.excluded.has(right)) return false;
    if (left === right) return true;
    return this.parent.has(left) && this.parent.has(right) && this.find(left) === this.find(right);
  }
}

function comparePosition(left: SelfTradeEvent, right: SelfTradeEvent): number {
  return left.block < right.block ? -1 : left.block > right.block ? 1 :
    left.logIndex - right.logIndex || left.id.localeCompare(right.id);
}

function compareLots(left: SelfTradeLot, right: SelfTradeLot): number {
  return left.createdBlock < right.createdBlock ? -1 : left.createdBlock > right.createdBlock ? 1 :
    left.createdLogIndex - right.createdLogIndex || left.id.localeCompare(right.id);
}

type Portion = Pick<SelfTradeLot, "writer" | "primaryFillId"> & { units: bigint };

/** Incrementally reduce one complete block range. All output arrays are stable and directly assignable. */
export function reduceSelfTrade(state: Readonly<SelfTradeState>, batch: SelfTradeBatch): SelfTradeState {
  if (batch.through <= state.cursor) return state as SelfTradeState;

  const excluded = new Set(batch.protocolAddresses.filter((value): value is string => Boolean(value)).map(key));
  excluded.add(ZERO_ADDRESS);
  const graph = new Links(excluded);
  for (const link of state.links) graph.add(link.left, link.right);
  for (const evidence of batch.linkEvidence) graph.add(evidence.left, evidence.right);

  const events = batch.events.filter((event) => event.block > state.cursor && event.block <= batch.through).sort(comparePosition);
  // Recipient choices and genuine wallet transfers are indexed linkage facts too. Build the range's
  // graph before attribution so input ordering cannot change the result.
  for (const event of events) {
    if (event.kind === "fill") graph.add(event.taker, event.recipient);
    if (event.kind === "transfer" && !batch.matchedTransferIds.has(event.id)) graph.add(event.from, event.to);
  }

  const lots = state.lots.map((lot) => ({ ...lot, holder: key(lot.holder), writer: lot.writer === null ? null : key(lot.writer) }));
  const makers = new Map<string, bigint>();
  for (const maker of state.makers) makers.set(key(maker.writer), (makers.get(key(maker.writer)) ?? 0n) + maker.units);
  const unseen = new Map<SelfTradeUnseenReason, { units: bigint; fills: number }>();
  for (const row of state.unseen ?? []) {
    const carried = unseen.get(row.reason) ?? { units: 0n, fills: 0 };
    unseen.set(row.reason, { units: carried.units + row.units, fills: carried.fills + row.fills });
  }
  function recordUnseen(reason: SelfTradeUnseenReason, units: bigint): void {
    if (units <= 0n) return;
    const carried = unseen.get(reason) ?? { units: 0n, fills: 0 };
    unseen.set(reason, { units: carried.units + units, fills: carried.fills + 1 });
  }
  const expiries = new Map(batch.seriesExpiries.map((row) => [row.longId, row.expiry]));

  function expire(at: bigint, onlyLongId?: bigint): void {
    for (const lot of lots) {
      if (lot.remaining === 0n || (onlyLongId !== undefined && lot.longId !== onlyLongId)) continue;
      const expiry = expiries.get(lot.longId);
      if (expiry !== undefined && at >= expiry) lot.remaining = 0n;
    }
  }

  function addLot(lot: SelfTradeLot): void {
    if (lot.units <= 0n) return;
    lots.push({ ...lot, holder: key(lot.holder), writer: lot.writer === null ? null : key(lot.writer) });
  }

  function consume(longId: bigint, holderRaw: string, units: bigint): Portion[] {
    if (units < 0n) throw new RangeError("Self-trade lot consumption cannot be negative");
    const holder = key(holderRaw);
    let missing = units;
    const portions: Portion[] = [];
    const open = lots.filter((lot) => lot.longId === longId && lot.holder === holder && lot.remaining > 0n).sort(compareLots);
    for (const lot of open) {
      if (missing === 0n) break;
      const taken = lot.remaining < missing ? lot.remaining : missing;
      lot.remaining -= taken;
      missing -= taken;
      portions.push({ writer: lot.writer, primaryFillId: lot.primaryFillId, units: taken });
    }
    if (missing > 0n) portions.push({ writer: null, primaryFillId: null, units: missing });
    return portions;
  }

  for (const event of events) {
    if (event.units < 0n) throw new RangeError(`Negative units in ${event.id}`);
    expire(event.ts, event.longId);
    if ((expiries.get(event.longId) ?? (event.ts + 1n)) <= event.ts || event.units === 0n) continue;

    if (event.kind === "mint") {
      addLot({ id: `mint:${event.id}`, longId: event.longId, holder: event.holder, writer: null,
        primaryFillId: null, units: event.units, remaining: event.units, createdBlock: event.block,
        createdLogIndex: event.logIndex, sourceId: event.id });
      continue;
    }

    if (event.kind === "transfer") {
      const from = key(event.from);
      const to = key(event.to);
      if (batch.matchedTransferIds.has(event.id) || excluded.has(from) || excluded.has(to) || from === to) continue;
      const portions = consume(event.longId, from, event.units);
      portions.forEach((portion, index) => addLot({
        id: `transfer:${event.id}:${index}`, longId: event.longId, holder: to,
        writer: graph.connected(from, to) ? portion.writer : null,
        primaryFillId: graph.connected(from, to) ? portion.primaryFillId : null,
        units: portion.units, remaining: portion.units, createdBlock: event.block,
        createdLogIndex: event.logIndex, sourceId: event.id,
      }));
      continue;
    }

    // Mint and transfer are handled above, so a non-fill event here is a close or a redemption.
    // The check is written against `fill` rather than against the two exit literals because
    // `SelfTradeExitEvent` declares `kind` as a TWO-literal union: excluding it by those literals
    // leaves the arm in the residual type, and every Fill-only read below then fails to compile.
    // Excluding the single `"fill"` literal narrows in both directions, so the compiler proves the
    // remainder of this body only ever sees a fill.
    if (event.kind !== "fill") {
      consume(event.longId, event.holder, event.units);
      continue;
    }

    if (event.primary) {
      const minimumPrice = event.price > 0n && event.price <= SELF_TRADE_MIN_PRICE_TICKS * PRICE_TICK;
      const suspectPrice = event.price > 0n && event.price <= SELF_TRADE_SUSPECT_PRICE_TICKS * PRICE_TICK;
      const linked = graph.connected(event.seller, event.buyer) || graph.connected(event.seller, event.recipient);
      const writer = event.takerIsBuyer && minimumPrice && linked ? key(event.seller) : null;
      // Record what the conjunction REFUSED, and why, so a 0 total is readable. Each arm drops
      // exactly one of the three conditions; a leg failing `takerIsBuyer` is an ordinary sale and
      // is not a blind spot, so it is deliberately not recorded.
      if (writer === null && event.takerIsBuyer) {
        if (linked && !minimumPrice && suspectPrice) recordUnseen("price-above-counted-band", event.units);
        else if (minimumPrice && !linked) recordUnseen("no-link-evidence", event.units);
      }
      addLot({ id: `fill:${event.id}`, longId: event.longId, holder: event.buyer, writer,
        primaryFillId: writer === null ? null : event.id, units: event.units, remaining: event.units,
        createdBlock: event.block, createdLogIndex: event.logIndex, sourceId: event.id });
      continue;
    }

    const portions = consume(event.longId, event.seller, event.units);
    for (const portion of portions) {
      if (portion.writer === null) continue;
      makers.set(portion.writer, (makers.get(portion.writer) ?? 0n) + portion.units);
    }
    // A counted primary unit is deliberately not propagated through a second resale.
    addLot({ id: `fill:${event.id}`, longId: event.longId, holder: event.buyer, writer: null,
      primaryFillId: null, units: event.units, remaining: event.units, createdBlock: event.block,
      createdLogIndex: event.logIndex, sourceId: event.id });
  }

  expire(batch.throughTimestamp);
  return {
    cursor: batch.through,
    links: [...graph.edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    lots: lots.sort(compareLots),
    makers: [...makers.entries()].map(([writer, units]) => ({ writer, units }))
      .sort((left, right) => left.writer.localeCompare(right.writer)),
    unseen: [...unseen.entries()].map(([reason, row]) => ({ reason, units: row.units, fills: row.fills }))
      .sort((left, right) => left.reason.localeCompare(right.reason)),
  };
}

export function selfTradeUnitsFor(state: Readonly<SelfTradeState>, writer: string): bigint {
  return state.makers.find((row) => row.writer === key(writer))?.units ?? 0n;
}

export function totalSelfTradeUnits(state: Readonly<SelfTradeState>): bigint {
  return state.makers.reduce((sum, row) => sum + row.units, 0n);
}

export function totalSelfTradeUnseenUnits(state: Readonly<SelfTradeState>): bigint {
  return (state.unseen ?? []).reduce((sum, row) => sum + row.units, 0n);
}

/**
 * THE THREE-STATE ANSWER, which is the whole point of this module now.
 *
 * `detected` - units were attributed; the number means what it says.
 * `clean`    - nothing attributed AND nothing shaped like the pattern was refused. A real zero.
 * `blind`    - nothing attributed, but legs WERE refused for a reason that an evader controls.
 *              The zero is an artefact of the detector, not a statement about the market.
 *
 * A caller that renders `units` without consulting this is publishing "no self-trading" on
 * evidence that cannot distinguish absence from blindness. That is the condition D18 attached to
 * leaving the loophole open, so it is returned as data rather than described in a comment.
 */
export function selfTradeCoverage(state: Readonly<SelfTradeState>): {
  status: "detected" | "clean" | "blind";
  units: bigint;
  unseenUnits: bigint;
  unseen: readonly SelfTradeUnseen[];
} {
  const units = totalSelfTradeUnits(state);
  const rows = state.unseen ?? [];
  const unseenUnits = totalSelfTradeUnseenUnits(state);
  const status = units > 0n ? "detected" : unseenUnits > 0n ? "blind" : "clean";
  return { status, units, unseenUnits, unseen: rows };
}
