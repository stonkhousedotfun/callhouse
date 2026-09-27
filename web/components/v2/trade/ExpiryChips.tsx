"use client";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { DAY_PICKER_MAX, dayOptions } from "@/lib/ui/dayPicker";

import { expiryName } from "./price";

export function ExpiryChips({ expiries, resaleOnly, now, selected, onSelect, className }: {
  expiries: readonly number[];
  resaleOnly?: readonly number[];
  now: number;
  selected: number | null;
  onSelect: (expiry: number) => void;
  className?: string;
}) {
  const options = dayOptions(expiries, now, DAY_PICKER_MAX, resaleOnly);
  if (options.length === 0) return null;
  return <div role="group" aria-label="Expiration" data-slot="expiry-chips"
    className={cn("flex flex-wrap items-center gap-2", className)}>
    {options.map((option) => {
      const on = option.expiry === selected;
      return <Button key={option.expiry} size="sm" variant={on ? "select" : "secondary"} aria-pressed={on}
        aria-label={option.long} title={option.long} data-expiry={option.expiry} className="shrink-0 max-sm:min-h-11"
        onClick={() => onSelect(option.expiry)}>
        {option.label === "Today" ? "Today" : expiryName(option.expiry)}
        {option.resaleOnly ? <span className="font-normal opacity-70" data-slot="resale-only"> · resale</span> : null}
      </Button>;
    })}
  </div>;
}
