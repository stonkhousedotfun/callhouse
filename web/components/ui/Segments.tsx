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
 *
 * NEON. Two appearances, one contract:
 *   - chips (default): a row of pills. Selected is the inverted --select-bg fill, the rest are --surface-2 chips
 *     with a --line-2 outline. DayPicker is this appearance.
 *   - track (`track`, or the SegmentedControl export): the options sit inside one --field pill; the selected one
 *     is inverted, the rest are borderless --ink-3. "All / Calls / Puts", "Price / Payoff", a period switch.
 * Chips are 44px tall below 640px (touch targets) and 36px above, where the mockups draw them small.
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
  /** The segmented-control look: every option inside one --field pill. */
  track?: boolean;
  className?: string;
  disabled?: boolean;
};

export function Segments<T extends string>({
  label, options, selected, onSelect, scroll = false, track = false, className, disabled = false,
}: SegmentsProps<T>) {
  return <div
    role="group"
    aria-label={label}
    data-slot={track ? "segmented-control" : "segments"}
    className={cn(
      "flex items-center",
      track ? "w-fit max-w-full gap-0.5 rounded-pill border border-line-2 bg-field p-[3px]" : "gap-2",
      scroll ? "overflow-x-auto" : "flex-wrap",
      scroll && !track ? "pb-2" : undefined,
      className,
    )}
  >
    {options.map(({ value, label: text }) => <Button
      key={value}
      size="sm"
      variant={value === selected ? "select" : track ? "quiet" : "secondary"}
      aria-pressed={value === selected}
      disabled={disabled}
      className={cn("max-sm:min-h-11", scroll && "shrink-0")}
      onClick={() => onSelect(value)}
    >{text}</Button>)}
  </div>;
}

/** The track appearance under its Neon name. Same props as Segments, minus `track`. */
export function SegmentedControl<T extends string>(props: Omit<SegmentsProps<T>, "track">) {
  return <Segments {...props} track />;
}
