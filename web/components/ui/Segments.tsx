"use client";

import { Button } from "./Button";
import { cn } from "@/lib/cn";

/**
 * A segmented control: one row of mutually exclusive options, exactly one selected.
 *
 * PROMOTED FROM `WinsLeaderboard.tsx` (UX review item 7). The app had two idioms for one control.
 * This one — a `role="group"` of `Button`s carrying `aria-pressed` — and a raw `<button>` styled
 * with `border-accent bg-accent-soft text-accent-text` when pressed, in five other places. Same
 * semantics, two appearances, two keyboard behaviours, because a `Button` and a bare `<button>`
 * do not focus, hover or disable alike. This is the better of the two and it was already generic
 * over `T extends string`, so it moves rather than being rewritten.
 *
 * WHAT IS *NOT* A SEGMENTED CONTROL, and was deliberately left alone: `EarnMarket`'s stage
 * stepper. It carries the same pressed colours, which is what makes it look like a sixth site,
 * but it is a wizard nav — `aria-current="step"`, `aria-controls`, `aria-expanded`, a numbered
 * label and a detail line per step. Converting it would swap a correct stepper contract for a
 * toggle contract and regress accessibility the review explicitly lists as already good.
 */
export type SegmentOption<T extends string> = { value: T; label: string };

export type SegmentsProps<T extends string> = {
  /** Names the group for a screen reader. Required: an unlabelled group of toggles is a puzzle. */
  label: string;
  options: readonly SegmentOption<T>[];
  selected: T;
  onSelect: (value: T) => void;
  /**
   * Scroll the row horizontally instead of wrapping it.
   *
   * For a set whose length is data-driven rather than fixed — the expiry row on a market page can
   * hold a dozen dates. Wrapping those onto four lines pushes the ladder off the screen, which is
   * the opposite of what the mobile row of this review asked for.
   */
  scroll?: boolean;
  className?: string;
  disabled?: boolean;
};

export function Segments<T extends string>({
  label, options, selected, onSelect, scroll = false, className, disabled = false,
}: SegmentsProps<T>) {
  return <div
    role="group"
    aria-label={label}
    className={cn("flex items-center gap-2", scroll ? "overflow-x-auto pb-2" : "flex-wrap", className)}
  >
    {options.map(({ value, label: text }) => <Button
      key={value}
      size="sm"
      variant={value === selected ? "primary" : "ghost"}
      aria-pressed={value === selected}
      disabled={disabled}
      className={scroll ? "shrink-0" : undefined}
      onClick={() => onSelect(value)}
    >{text}</Button>)}
  </div>;
}
