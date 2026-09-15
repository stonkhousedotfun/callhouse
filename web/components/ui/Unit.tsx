import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A unit or filler word after a figure inside a mono ledger value ("20.0000 NVDA", "1 contracts",
 * "0 of at most 1"): body face, a step smaller, muted, so the figure is what the eye lands on.
 * The same treatment <Stat> gives its `unit`, for values rendered by <Row>.
 *
 *   <Row k="Deposit cap" v={<>{fmtAsset(cap)} <Unit>{MARKET}</Unit></>} />
 *
 * Keep the space between the figure and the unit as a literal space in the JSX: the W-13 run reads a
 * row's textContent ("20.0000 NVDA"), and the span adds no characters of its own.
 */
export function Unit({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("font-body text-[0.9em] text-ink-3", className)}>{children}</span>;
}
