"use client";

/**
 * A time as the reader's browser sees it, in the reader's own
 * timezone. The rule and the formatters are in lib/v2/time.ts; this file only picks the zone.
 *
 * The server cannot know the reader's zone, so the server render (and hydration) uses New York, zone named, and the
 * client switches to the browser's zone once mounted. `useSyncExternalStore` does that switch: its server snapshot is
 * used for the server render and for hydration, so there is no mismatch, and a client-only mount reads the browser's
 * zone at once. Never formats in "whatever zone this process is in" during a server render: on Railway that is UTC.
 */
import { useSyncExternalStore } from "react";

import { localDayStamp, localStamp, marketStamp, NEW_YORK_TIME_ZONE } from "@/lib/v2/time";

export type TimeProps = { at: number; className?: string } & (
  | { dateOnly: true; market?: never }
  | { dateOnly?: false; market?: boolean }
);

/** The browser's IANA zone, or null when the runtime does not report one. */
export function viewerTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

const noSubscription = () => () => {};
const serverZone = () => null;

/** The reader's zone after mount; null on the server and during hydration (render New York then). */
export function useViewerTimeZone(): string | null {
  return useSyncExternalStore(noSubscription, viewerTimeZone, serverZone);
}

/** The text <Time> shows for a zone; null means the zone is not known yet, so New York. */
export function timeText(props: Pick<TimeProps, "at" | "dateOnly" | "market">, zone: string | null): string {
  const timeZone = zone ?? NEW_YORK_TIME_ZONE;
  if (props.dateOnly) return localDayStamp(props.at, timeZone);
  return props.market ? marketStamp(props.at, timeZone) : localStamp(props.at, timeZone);
}

/** `<Time at={unixSeconds} />`, `<Time at={expiry} market />` (adds the ET time), `<Time at={t} dateOnly />`. */
export function Time(props: TimeProps) {
  const zone = useViewerTimeZone();
  const text = timeText(props, zone);
  return (
    <time dateTime={new Date(props.at * 1000).toISOString()} className={props.className}>
      {text}
    </time>
  );
}
