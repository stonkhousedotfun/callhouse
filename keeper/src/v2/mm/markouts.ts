/**
 * Post-trade markouts: for every vault fill, the later fair value of the same series at
 * +1, +5 and +30 minutes, measured against the fill price. The question it answers is the one a covered-call and
 * cash-secured-put book has to keep asking: are our fills systematically on the wrong side of where the option went
 * next? A seller who is consistently marked out negative at 30 min is being picked off (stale or cheap asks).
 *
 * SIGN: positive is good for the vault.
 *   sold at `price`, later fair `f`  ->  (price - f) / price   (we sold above what it became worth)
 *   bought at `price`, later fair `f` ->  (f - price) / price
 * In basis points of the fill price. A fill at price 0 is not measured (no denominator).
 *
 * HOW IT IS FED. `record(fill)` for each new fill (mm/fills.ts `FillRecord`). Each tick, `due(now)` lists the
 * (fill, horizon) checkpoints whose time has come, the caller reads the fair of those series (it already does,
 * for quoting), and `observe(now, fairOf)` stores what it can. A checkpoint first observed late is stored with its
 * actual age (`lateS`), never pretended exact. A series with no fair by `horizon + giveUpS` (a 0DTE series that
 * expired inside the 30 minutes, a pricing outage) is stored as `missing`, so it neither hangs nor counts.
 *
 * THE ALERT RULE. `alert(now, rule)` looks at the most recent `minFills` fills whose 30-minute markout is known and
 * fires when their notional-weighted mean is below `thresholdBps`. Notional-weighted, because one large fill marked
 * out badly matters more than ten dust fills marked out well.
 *
 * In memory: a restart forgets pending checkpoints and history. That loses at most the last 30 minutes' marks and
 * the rolling window, never a fill (the fills ledger is mm/fills.ts's, persisted by mm-store).
 */

export const MARKOUT_HORIZONS_S = [60, 300, 1_800] as const;
export type MarkoutHorizon = (typeof MARKOUT_HORIZONS_S)[number];

export interface MarkoutFill {
  at: number;
  orderId: bigint;
  longId: bigint;
  side: 'buy' | 'sell';
  units: bigint;
  price: bigint;
}

export type MarkoutMark = { bps: number; fair: bigint; lateS: number } | { missing: true };

export interface MarkoutEntry {
  key: string;
  fill: MarkoutFill;
  marks: Partial<Record<MarkoutHorizon, MarkoutMark>>;
}

export interface MarkoutRule {
  thresholdBps: number;
  minFills: number;
}

export interface MarkoutAlert {
  fills: number;
  meanBps: number;
  thresholdBps: number;
  worst: { key: string; bps: number } | null;
}

/** Positive = good for the vault. null when the fill price is 0. */
export function markoutBps(side: 'buy' | 'sell', price: bigint, fair: bigint): number | null {
  if (price <= 0n) return null;
  const edge = side === 'sell' ? price - fair : fair - price;
  // bigint first, one division at the end: 1e4 * edge / price, to 0.01 bps.
  return Number((edge * 1_000_000n) / price) / 100;
}

export class MarkoutBook {
  private readonly entries: MarkoutEntry[] = [];
  private seq = 0;

  constructor(
    private readonly opts: { giveUpS: number; keep: number } = { giveUpS: 600, keep: 500 },
  ) {}

  record(fill: MarkoutFill): string {
    const key = `${fill.orderId}:${fill.at}:${this.seq++}`;
    this.entries.push({ key, fill, marks: {} });
    if (this.entries.length > this.opts.keep) this.entries.splice(0, this.entries.length - this.opts.keep);
    return key;
  }

  /** The series whose fair is needed now: one per longId, for every checkpoint whose time has come. */
  due(now: number): bigint[] {
    const ids = new Map<string, bigint>();
    for (const e of this.entries) {
      for (const h of MARKOUT_HORIZONS_S) {
        if (e.marks[h] === undefined && now >= e.fill.at + h) ids.set(e.fill.longId.toString(), e.fill.longId);
      }
    }
    return [...ids.values()];
  }

  /** Store every due checkpoint `fairOf` can price; give up on those past `horizon + giveUpS` with no fair. */
  observe(now: number, fairOf: (longId: bigint) => bigint | null | undefined): number {
    let stored = 0;
    for (const e of this.entries) {
      for (const h of MARKOUT_HORIZONS_S) {
        if (e.marks[h] !== undefined || now < e.fill.at + h) continue;
        const fair = fairOf(e.fill.longId);
        if (fair !== null && fair !== undefined) {
          const bps = markoutBps(e.fill.side, e.fill.price, fair);
          e.marks[h] = bps === null ? { missing: true } : { bps, fair, lateS: now - (e.fill.at + h) };
          stored += 1;
        } else if (now >= e.fill.at + h + this.opts.giveUpS) {
          e.marks[h] = { missing: true };
          stored += 1;
        }
      }
    }
    return stored;
  }

  /** The alert, or null. Uses the most recent `minFills` fills with a known 30-minute mark. */
  alert(rule: MarkoutRule): MarkoutAlert | null {
    const known = this.entries
      .map((e) => ({ e, m: e.marks[1_800] }))
      .filter((x): x is { e: MarkoutEntry; m: { bps: number; fair: bigint; lateS: number } } => x.m !== undefined && !('missing' in x.m));
    if (known.length < rule.minFills || rule.minFills <= 0) return null;
    const recent = known.slice(-rule.minFills);
    let weight = 0;
    let sum = 0;
    for (const { e, m } of recent) {
      const w = Number(e.fill.units * e.fill.price);
      weight += w;
      sum += w * m.bps;
    }
    const meanBps = weight > 0 ? sum / weight : recent.reduce((a, x) => a + x.m.bps, 0) / recent.length;
    if (meanBps >= rule.thresholdBps) return null;
    const worst = recent.reduce((w, x) => (w === null || x.m.bps < w.bps ? { key: x.e.key, bps: x.m.bps } : w), null as { key: string; bps: number } | null);
    return { fills: recent.length, meanBps: Math.round(meanBps * 100) / 100, thresholdBps: rule.thresholdBps, worst };
  }

  /** For /state: the latest fills and their marks, newest first, bigints as strings. */
  snapshot(limit = 50) {
    return this.entries
      .slice(-limit)
      .reverse()
      .map((e) => ({
        key: e.key,
        at: e.fill.at,
        longId: e.fill.longId.toString(),
        side: e.fill.side,
        units: e.fill.units.toString(),
        price: e.fill.price.toString(),
        marks: Object.fromEntries(
          MARKOUT_HORIZONS_S.map((h) => {
            const m = e.marks[h];
            return [`${h}s`, m === undefined ? 'pending' : 'missing' in m ? 'missing' : { bps: m.bps, fair: m.fair.toString(), lateS: m.lateS }];
          }),
        ),
      }));
  }
}
