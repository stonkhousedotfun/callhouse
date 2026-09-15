import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A surface card. Flat by default (1px line border, the mockup's .panel / .ending-panel). Copied
 * from callhouse-site: components/ui/Panel.tsx, with the app's card head added below.
 *
 * `lift` swaps the border for the lift shadow. Reserve it for the few elevated objects the design
 * calls for: the vault card on the home page, the fill card, toasts and menus. Everything else
 * stays flat.
 *
 * `pad`: none 0 · sm 22px (.panel) · md 26px (default) · lg 30px. Below 560px every padded size
 * drops to 18px so a 390px screen keeps its figures on one line. Overflow is not clipped unless you
 * add `overflow-hidden`.
 *
 * TEST HOOKS. Every card renders `data-slot="card"`, and its head `card-head`, `card-title` and
 * `card-meta`. The fork acceptance run (tests/acceptance/fork.acceptance.ts, W-13) finds cards and
 * their figures by those attributes, never by class names, so restyling a card cannot break it.
 * Keep the attributes when you change the markup.
 */
export type PanelPad = "none" | "sm" | "md" | "lg";

export type PanelProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  as?: "div" | "article" | "section" | "aside";
  lift?: boolean;
  pad?: PanelPad;
  children: ReactNode;
};

const PAD: Record<PanelPad, string> = {
  none: "",
  sm: "p-[18px] sm:p-[22px]",
  md: "p-[18px] sm:p-[26px]",
  lg: "p-[18px] sm:p-[30px]",
};

export function Panel({ as: Tag = "div", lift = false, pad = "md", className, children, ...rest }: PanelProps) {
  return (
    <Tag
      data-slot="card"
      className={cn("min-w-0 rounded-lg bg-surface", lift ? "shadow-lift" : "border border-line", PAD[pad], className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Alias: the same component, for call sites where "card" reads better. */
export const Card = Panel;

/**
 * A card's head row: the title on the left, and on the right either a status chip or a short
 * mono meta line (`<CardMeta>`). Wraps under 390px rather than squeezing the title.
 */
export function CardHead({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      data-slot="card-head"
      className={cn("mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}
    >
      {children}
    </div>
  );
}

/**
 * A card's title. An h2 by default, because on every app page the cards are the page's sections;
 * pass `as="h3"` for a sub-head inside a card (the queued-redemption block under Withdraw).
 */
export function CardTitle({
  as: Tag = "h2",
  id,
  className,
  children,
}: {
  as?: "h2" | "h3" | "p";
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      id={id}
      data-slot="card-title"
      className={cn("font-display text-lg font-bold leading-snug tracking-[-0.01em] text-ink", className)}
    >
      {children}
    </Tag>
  );
}

/** The quiet mono line in a card head: "cycle #4", "cap headroom 12.0000 NVDA", "status open". */
export function CardMeta({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span data-slot="card-meta" className={cn("num text-[12.5px] font-medium text-ink-3", className)}>
      {children}
    </span>
  );
}
