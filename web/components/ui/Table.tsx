import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A data table in its own horizontal scroll container, so a 13-column history never scrolls the
 * page body at 390px. Numbers are Geist Mono and right-aligned so columns compare at a glance; the
 * first column is left-aligned. Cells do not wrap unless a cell opts in with `whitespace-normal`.
 *
 * Pass `<thead>` and `<tbody>` as children; the styling reaches them through the table's own
 * arbitrary variants, so the rows stay plain JSX.
 *
 * `bleed` pulls the scroll area out to a card's edges (the card's padding is 18px below 560px and
 * 26px above), so a wide table gets every pixel of the card. Use it only inside a pad="md" Card.
 */
export function Table({
  label,
  bleed = false,
  minWidth = 520,
  className,
  children,
}: {
  /** Accessible name for the scroll region (it is focusable, so keyboard users can scroll it). */
  label: string;
  bleed?: boolean;
  minWidth?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "overflow-x-auto [scrollbar-width:thin] focus-visible:outline-offset-[-2px]",
        bleed ? "-mx-[18px] px-[18px] sm:-mx-[26px] sm:px-[26px]" : null,
        className,
      )}
    >
      <table
        style={{ minWidth }}
        className={cn(
          "w-full border-collapse text-[13.5px]",
          "[&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-line-2 [&_th]:px-2.5 [&_th]:pb-2.5 [&_th]:pt-1 [&_th]:text-right [&_th]:text-[12px] [&_th]:font-semibold [&_th]:text-ink-3",
          "[&_td]:num [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:border-line [&_td]:px-2.5 [&_td]:py-2.5 [&_td]:text-right [&_td]:text-ink",
          "[&_th:first-child]:pl-0 [&_th:first-child]:text-left [&_td:first-child]:pl-0 [&_td:first-child]:text-left",
          "[&_th:last-child]:pr-0 [&_td:last-child]:pr-0 [&_tbody_tr:last-child_td]:border-b-0",
          "[&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-surface-2/60",
        )}
      >
        {children}
      </table>
    </div>
  );
}
