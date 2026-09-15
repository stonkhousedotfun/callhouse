import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Label / value lists: the app's ledger rows ("Protocol fee ........ 0.214047"). The fee slip on
 * callhouse.finance is the model: a quiet label on the left, the figure right-aligned in Geist Mono,
 * a hairline between rows.
 *
 *   <Rows>
 *     <Row k="Vault cycle" v={`#${v.cycleNumber}`} />
 *     <Row k="Order hash" v={<Link …/>} title="…" />
 *   </Rows>
 *
 * <Rows> is a <dl>; each <Row> is a <div> holding one <dt> and one <dd>, which is valid inside a
 * dl. `mono={false}` on a Row whose value is a sentence rather than a figure. `dense` tightens the
 * rows for the small print under a card (the home card's countdown line).
 *
 * A long value wraps under its label on a narrow screen instead of pushing the page sideways.
 *
 * TEST HOOKS: `data-slot` rows / row / k / v. The W-13 run finds a row by its `k` text and reads `v`.
 * Keep the value's visible text free of screen-reader-only additions (use ExternalLink with
 * srNote={false} inside a value) so what the run reads is what a sighted reader sees.
 */
export function Rows({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <dl data-slot="rows" className={cn("grid min-w-0", className)}>
      {children}
    </dl>
  );
}

export type RowProps = {
  k: ReactNode;
  v: ReactNode;
  title?: string;
  mono?: boolean;
  dense?: boolean;
  className?: string;
};

export function Row({ k, v, title, mono = true, dense = false, className }: RowProps) {
  return (
    <div
      data-slot="row"
      title={title}
      className={cn(
        "flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line last:border-b-0",
        dense ? "py-1.5 text-[13px]" : "py-2.5 text-[14.5px]",
        className,
      )}
    >
      <dt data-slot="k" className="min-w-0 text-ink-2">
        {k}
      </dt>
      <dd
        data-slot="v"
        className={cn("ml-auto min-w-0 text-right text-ink [overflow-wrap:anywhere]", mono ? "num" : null)}
      >
        {v}
      </dd>
    </div>
  );
}
