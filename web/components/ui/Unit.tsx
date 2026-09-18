import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A unit or filler word after a figure inside a mono ledger value ("20.0000 TSLA", "1 contracts",
 * "0 of at most 1"): body face, a step smaller, muted, so the figure is what the eye lands on.
 * The same treatment <Stat> gives its `unit`, for values rendered by <Row>.
 *
 *   <Row k="Deposit cap" v={<>{fmtAsset(cap)} <Unit>{market.ticker}</Unit></>} />
 *
 * The unit is the market's ticker (lib/markets.ts), never a literal; the closed pooled vault's
 * components are the one place MARKET from lib/contracts still appears. Keep the space between the
 * figure and the unit as a literal space in the JSX: the W-13 run reads a row's textContent
 * ("20.0000 NVDA"), and the span adds no characters of its own.
 */
export function Unit({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("font-body text-[0.9em] text-ink-3", className)}>{children}</span>;
}
