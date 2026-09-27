"use client";

/**
 * "When you get paid", shown on every surface where the user commits money, ABOVE the button that signs.
 * The words and times come from lib/v2/payoutTiming.ts, the one source. This file only lays them out:
 * no sentence here says when anything happens.
 *
 * WHAT IS ALWAYS VISIBLE, on a 390 px phone as on a desktop: the headline and the time (America/New_York, the app's
 * canonical market time, plus the reader's own zone once mounted). What the user can do if a keeper is late, and what
 * happens when it goes the other way, sit behind the "?". The time is never behind a tooltip: a timing the user must
 * open to see is a timing they will sign without reading.
 *
 * THE CLOCK. Callers pass a function of `now` rather than a finished PayoutTiming, so every surface uses the same
 * minute clock and a timing computed on one render cannot go stale on the next. `now` may be passed in for tests.
 * The reader's local zone is rendered only after mount: the server renders in its own zone, and a zoned string that
 * differs between server and client would be a hydration mismatch.
 *
 * The wall clock is read only after mount, for the same reason. A static page is prerendered at BUILD time
 * and hydrated at READ time, so a clock seeded during render baked the build time into the HTML, the first client
 * render disagreed, React threw #418 and re-rendered the tree on the client, and that dropped the `data-theme` the
 * pre-paint script set. Without a pinned `now` the block renders nothing until the first client tick: no time is
 * better than a wrong one above a sign button.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { InfoTip } from "@/components/ui/InfoTip";
import { formatLocal, type PayoutTiming as Timing } from "@/lib/v2/payoutTiming";

/** The value before mount: the pinned clock, else null. Never the wall clock (see THE CLOCK above). */
export function initialPayoutClock(provided?: number): number | null {
  return provided ?? null;
}

type Ticker = { now: () => number; every: (fn: () => void, ms: number) => () => void };

const browserTicker: Ticker = {
  now: () => Date.now(),
  every: (fn, ms) => {
    const timer = window.setInterval(fn, ms);
    return () => window.clearInterval(timer);
  },
};

/** Runs after mount: one read now, then one a minute. Returns the stop function for the effect's cleanup. */
export function startPayoutClock(set: (now: number) => void, ticker: Ticker = browserTicker): () => void {
  const read = () => set(Math.floor(ticker.now() / 1_000));
  read();
  return ticker.every(read, 60_000);
}

/**
 * Unix seconds, ticking once a minute; `provided` pins it (tests, or a surface that already keeps its own clock).
 * Null until the first client tick when nothing is pinned.
 */
export function usePayoutNow(provided?: number): number | null {
  const [clock, setClock] = useState(() => initialPayoutClock(provided));
  useEffect(() => {
    if (provided !== undefined) return;
    return startPayoutClock(setClock);
  }, [provided]);
  return provided ?? clock;
}

const NO_SUBSCRIBE = () => () => {};

/** False on the server and while hydrating, true after: the reader's zone is only known in the browser. */
function useMounted(): boolean {
  return useSyncExternalStore(NO_SUBSCRIBE, () => true, () => false);
}

/** The time line's label: a clock the payment usually meets, or the earliest moment it can happen. */
export function whenLabel(timing: Timing): string | null {
  if (timing.whenEt === null) return null;
  return timing.usualBy !== null ? "Usually by" : "From";
}

const MARKET_DATE = new Intl.DateTimeFormat("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/New_York" });

/** The one visible answer: the market date (MM/DD/YYYY), "Right away", or "When it fills" for an order that rests. */
export function payoutWhen(timing: Timing): string {
  if (timing.path === "resting-order") return "When it fills";
  const at = timing.usualBy ?? timing.earliestAt;
  if (at === null || (timing.arrival === "immediate" && timing.usualBy === null)) return "Right away";
  return MARKET_DATE.format(new Date(at * 1000));
}

/** The rendered line, from an already computed timing. Null renders nothing (a surface without the facts yet). */
export function PayoutTimingNote({ timing, localZone, className }: {
  timing: Timing | null;
  /** The reader's zone for the second stamp; omitted: not shown (before mount, and on the server). */
  localZone?: string | "runtime";
  className?: string;
}) {
  if (timing === null) return null;
  const at = timing.usualBy ?? timing.earliestAt;
  const label = whenLabel(timing);
  const local = localZone === undefined || at === null ? null : formatLocal(at, localZone === "runtime" ? undefined : localZone);
  return <div className={`rounded-md border border-line bg-field px-3.5 py-2.5 text-[13px] leading-snug ${className ?? ""}`.trim()}
    data-payout-timing={timing.path} data-arrival={timing.arrival} data-late={timing.late ? "true" : undefined}>
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 font-semibold text-ink">When you get paid
        <InfoTip label="More about when you get paid" align="start" text={<>
          <span className="block">{timing.headline}</span>
          {label !== null ? <span className="mt-1 block">{label} <span className="font-semibold text-ink">{timing.whenEt}</span>
            {local !== null ? <span className="text-ink-3"> · your time {local}</span> : null}</span> : null}
          {timing.selfServe !== null ? <span className="mt-1 block">{timing.selfServe}</span> : null}
          <span className="mt-1 block">{timing.unhappy}</span>
        </>} /></span>
      <span data-slot="payout-when" className="num font-semibold text-ink">{payoutWhen(timing)}</span>
    </div>
    {timing.late ? <p className="mt-1 font-semibold text-warn">Running late: this is past the usual time and not yet paid.</p> : null}
  </div>;
}

/**
 * What a surface mounts, above its sign button: `of` turns the minute clock into the module's answer for this action.
 * `of` returning null (the surface does not know the expiry or epoch yet) renders nothing, and so does a clock that
 * has not ticked yet (no pinned `now`, not yet mounted).
 */
export function PayoutTiming({ of, now, className }: {
  of: (now: number) => Timing | null;
  now?: number;
  className?: string;
}) {
  const clock = usePayoutNow(now);
  const mounted = useMounted();
  if (clock === null) return null;
  return <PayoutTimingNote timing={of(clock)} localZone={mounted ? "runtime" : undefined} className={className} />;
}
