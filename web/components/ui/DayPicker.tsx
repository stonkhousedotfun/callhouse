"use client";

import { cn } from "@/lib/cn";
import { DAY_PICKER_MAX, dayOptions } from "@/lib/ui/dayPicker";

import { Button } from "./Button";

/**
 * The expiry day chips: "Today", "Wed 23", "Thu 24" from 640px, and short
 * weekday tabs ("Today", "Wed", "Thu") on a phone. Same contract as Segments (a labelled group of `aria-pressed`
 * buttons, exactly one pressed) and the same chip look, but the options are built by lib/ui/dayPicker.ts from the
 * expiries the caller actually lists: at most six, future only, nearest first. The picker never offers a day with
 * nothing listed on it.
 *
 * Each chip's accessible name is the full New York time ("Sep 23, 2026, 4:00 PM EDT"), because "Wed" alone names a
 * day, not an expiry. The visible label is only one of the two spans at any width; the other is display:none and so
 * is not read twice.
 *
 * With nothing listed it renders nothing: the empty state is the screen's to draw, in its own
 * words, not a picker with no chips in it.
 */
export type DayPickerProps = {
  /** Listed expiries, unix seconds. Order and duplicates do not matter. */
  expiries: readonly number[];
  /**
   * The listed days that are past their mint cutoff: shown, and marked "resale" from 640px, with
   * the full note in the accessible name. Days here must also be in `expiries`.
   */
  resaleOnly?: readonly number[];
  /** Unix seconds. Passed in rather than read, so the server and the first client render agree. */
  now: number;
  /** The selected expiry, or null for none. */
  selected: number | null;
  onSelect: (expiry: number) => void;
  label?: string;
  max?: number;
  className?: string;
};

export function DayPicker({
  expiries, resaleOnly, now, selected, onSelect, label = "Expiry day", max = DAY_PICKER_MAX, className,
}: DayPickerProps) {
  const options = dayOptions(expiries, now, max, resaleOnly);
  if (options.length === 0) return null;
  return <div
    role="group"
    aria-label={label}
    data-slot="day-picker"
    className={cn("flex items-center gap-1.5 overflow-x-auto sm:gap-2", className)}
  >
    {options.map((option) => {
      const on = option.expiry === selected;
      return <Button
        key={option.expiry}
        size="sm"
        variant={on ? "select" : "secondary"}
        aria-pressed={on}
        aria-label={option.long}
        title={option.long}
        data-expiry={option.expiry}
        className="shrink-0 max-sm:min-h-11"
        onClick={() => onSelect(option.expiry)}
      >
        <span className="sm:hidden">{option.short}</span>
        <span className="max-sm:hidden">{option.label}</span>
        {option.resaleOnly ? <span className="max-sm:hidden font-normal text-ink-3" data-slot="resale-only"> · resale</span> : null}
      </Button>;
    })}
  </div>;
}
