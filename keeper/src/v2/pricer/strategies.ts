/**
 * Which (writer, underlying) pairs have an AutoRoller strategy: the list the pricer walks each tick.
 *
 * TWO SOURCES, unioned (as the cranker's rolls step does):
 *   indexer    GET /v2/strategies?active=1 (X2-04), paged by cranker/indexer-client.ts;
 *   log scan   AutoRoller `StrategySet` events from the registry's deploy block, into the pricer's
 *              SQLite file (table v2_pricer_strategies, cursor in v2_meta), so the list survives the
 *              indexer being down and a restart does not rescan from the deploy block.
 * Both give CANDIDATES only: strategy(), position() and the ask are always read from chain before
 * anything is decided (a stopped strategy, one without smartPricing, is skipped there).
 *
 * The scan is StrategySet on the roller alone: one eth_getLogs per range on the log client (pinned
 * to RH_RPC, chain.ts, and never past that client's own head: cranker/scanner.ts THE HEAD), `chunkBlocks` a range and
 * at most `maxChunks` per tick, a refused range halved
 * down to 100 blocks, REORG_OVERLAP blocks re-read below the cursor (inserts are idempotent). Rows
 * and cursor are keyed by the roller address, so a registry switched to another deployment starts
 * its own list instead of reading the old one's. Another deployment at the SAME roller address (a
 * fresh devnet: up.sh deploys from a pinned nonce) is told apart by the deployment anchor
 * (bindAnchor, ../anchor.ts), which resets that roller's rows, cursor and evaluation marks.
 */
import { getAbiItem, getAddress, type AbiEvent, type Address, type PublicClient } from 'viem';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { anchorResets, compareAnchor, type AnchorCheck } from '../anchor.js';
import type { IndexerClient } from '../cranker/indexer-client.js';
import type { V2Store } from '../store.js';

export const REORG_OVERLAP = 100n;
const MIN_CHUNK = 100n;
const STRATEGY_SET = getAbiItem({ abi: autoRollerAbi, name: 'StrategySet' }) as AbiEvent;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS v2_pricer_strategies (
  roller     TEXT NOT NULL,
  writer     TEXT NOT NULL,
  underlying TEXT NOT NULL,
  block      TEXT NOT NULL,
  PRIMARY KEY (roller, writer, underlying)
);
`;

export const cursorMetaKey = (roller: string) => `pricer:strategies:${roller.toLowerCase()}:scannedTo`;
export const anchorMetaKey = (roller: string) => `pricer:anchor:${roller.toLowerCase()}`;
/** Every pricer mark of one roller in v2_meta: the scan cursor, and pricer.ts's evaluation and missing-fair marks. */
export const rollerMetaPrefixes = (roller: string): string[] => ['strategies', 'evaluated', 'fair-missing'].map((what) => `pricer:${what}:${roller.toLowerCase()}:`);

export type LogClient = Pick<PublicClient, 'getLogs' | 'getBlockNumber'>;

export interface StrategyPair {
  writer: Address;
  underlying: Address;
}

export interface ScanResult {
  fromBlock: bigint | null;
  toBlock: bigint | null;
  ranges: number;
  logs: number;
  caughtUp: boolean;
}

type DecodedLog = { address: string; blockNumber: bigint | null; eventName?: string; args?: Record<string, unknown> };

/** The pairs a batch of decoded logs names, for `roller` only. Pure; exported for tests. */
export function pairsFromLogs(logs: readonly DecodedLog[], roller: string): Array<StrategyPair & { block: bigint }> {
  const out: Array<StrategyPair & { block: bigint }> = [];
  for (const log of logs) {
    if (log.eventName !== 'StrategySet' || log.address.toLowerCase() !== roller.toLowerCase()) continue;
    const writer = log.args?.writer;
    const underlying = log.args?.underlying;
    if (typeof writer !== 'string' || typeof underlying !== 'string') continue;
    out.push({ writer: getAddress(writer), underlying: getAddress(underlying), block: log.blockNumber ?? 0n });
  }
  return out;
}

export class StrategyIndex {
  constructor(
    private readonly store: V2Store,
    readonly roller: Address,
  ) {
    store.db.exec(SCHEMA);
  }

  /**
   * Check the deployment anchor of the chain the pricer reads against the one recorded for this roller. Another
   * deployment at the same address, or state recorded before anchors, deletes the roller's rows and every mark under
   * rollerMetaPrefixes, and marks the journal's pending transactions dropped. Call before the first tick reads.
   */
  bindAnchor(anchor: string | null): AnchorCheck {
    const roller = this.roller.toLowerCase();
    const recorded = this.store.getMeta(anchorMetaKey(roller));
    const prefixes = rollerMetaPrefixes(roller);
    const marks = prefixes.reduce((n, p) => n + (this.store.db.prepare('SELECT COUNT(*) AS n FROM v2_meta WHERE substr(key, 1, ?) = ?').get(p.length, p) as { n: number }).n, 0);
    const rows = (this.store.db.prepare('SELECT COUNT(*) AS n FROM v2_pricer_strategies WHERE roller = ?').get(roller) as { n: number }).n;
    const check = compareAnchor(recorded, anchor, marks + rows > 0);
    this.store.db.transaction(() => {
      if (anchorResets(check)) {
        this.store.db.prepare('DELETE FROM v2_pricer_strategies WHERE roller = ?').run(roller);
        for (const p of prefixes) this.store.deleteMetaWithPrefix(p);
        this.store.dropPendingTxs(`the pricer store was reset for another deployment (anchor ${anchor})`);
      }
      if (anchor !== null && check !== 'same') this.store.setMeta(anchorMetaKey(roller), anchor);
    })();
    return check;
  }

  anchor(): string | null {
    return this.store.getMeta(anchorMetaKey(this.roller));
  }

  scannedTo(): bigint | null {
    const raw = this.store.getMeta(cursorMetaKey(this.roller));
    return raw === null ? null : BigInt(raw);
  }

  /** One scanned range, atomically: its rows and the cursor move together. */
  applyRange(pairs: ReadonlyArray<StrategyPair & { block: bigint }>, toBlock: bigint): void {
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO v2_pricer_strategies (roller, writer, underlying, block) VALUES (?, ?, ?, ?)');
    this.store.db.transaction(() => {
      for (const p of pairs) insert.run(this.roller.toLowerCase(), p.writer.toLowerCase(), p.underlying.toLowerCase(), p.block.toString());
      this.store.setMeta(cursorMetaKey(this.roller), toBlock.toString());
    })();
  }

  pairs(): StrategyPair[] {
    const rows = this.store.db.prepare('SELECT writer, underlying FROM v2_pricer_strategies WHERE roller = ? ORDER BY writer, underlying').all(this.roller.toLowerCase()) as Array<{ writer: string; underlying: string }>;
    return rows.map((r) => ({ writer: getAddress(r.writer), underlying: getAddress(r.underlying) }));
  }

  /** Scan StrategySet from the cursor towards `head`, at most `maxChunks` ranges. Throws only when even a minimal range fails. */
  async scan(client: LogClient, options: { fromBlock: bigint; head: bigint; chunkBlocks: number; maxChunks: number }): Promise<ScanResult> {
    const cursor = this.scannedTo();
    let start = cursor === null ? options.fromBlock : cursor + 1n - REORG_OVERLAP;
    if (start < options.fromBlock) start = options.fromBlock;
    let chunk = BigInt(options.chunkBlocks);
    const logHead = await client.getBlockNumber({ cacheTime: 0 });
    const head = logHead < options.head ? logHead : options.head;
    const result: ScanResult = { fromBlock: null, toBlock: null, ranges: 0, logs: 0, caughtUp: start > head };
    while (start <= head && result.ranges < options.maxChunks) {
      const to = start + chunk - 1n > head ? head : start + chunk - 1n;
      let logs: DecodedLog[];
      try {
        logs = (await client.getLogs({ address: this.roller, event: STRATEGY_SET, fromBlock: start, toBlock: to, strict: false } as never)) as unknown as DecodedLog[];
      } catch (error) {
        if (chunk > MIN_CHUNK) {
          chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
          continue;
        }
        throw error;
      }
      this.applyRange(pairsFromLogs(logs, this.roller), to);
      result.fromBlock ??= start;
      result.toBlock = to;
      result.ranges += 1;
      result.logs += logs.length;
      start = to + 1n;
    }
    result.caughtUp = start > head;
    return result;
  }
}

export interface StrategyList {
  pairs: StrategyPair[];
  /** 'off' (no INDEXER_URL), 'ok', or why it was not used. */
  indexer: string;
  /** The scan's outcome, or its error (the list then holds what earlier scans found). */
  scan: ScanResult | { error: string };
}

/** Union of the log index and the indexer's active strategies, deduplicated, in a stable order. */
export async function listStrategies(
  index: StrategyIndex,
  indexer: Pick<IndexerClient, 'activeStrategies'> | null,
  scan: () => Promise<ScanResult>,
): Promise<StrategyList> {
  let scanned: StrategyList['scan'];
  try {
    scanned = await scan();
  } catch (error) {
    scanned = { error: error instanceof Error ? error.message.split('\n')[0]! : String(error) };
  }
  const pairs = new Map<string, StrategyPair>();
  for (const p of index.pairs()) pairs.set(`${p.writer.toLowerCase()}:${p.underlying.toLowerCase()}`, p);
  let status = indexer === null ? 'off' : 'ok';
  if (indexer !== null) {
    const result = await indexer.activeStrategies();
    if (result.ok) for (const p of result.items) pairs.set(`${p.writer.toLowerCase()}:${p.underlying.toLowerCase()}`, { writer: getAddress(p.writer), underlying: getAddress(p.underlying) });
    else status = `down (${result.reason}); log index only`;
  }
  const sorted = [...pairs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
  return { pairs: sorted, indexer: status, scan: scanned };
}
