"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export type TabItem<T extends string> = {
  value: T;
  label: ReactNode;
  badge?: ReactNode;
  panel: ReactNode;
  disabled?: boolean;
};

export type TabsProps<T extends string> = {
  label: string;
  items: readonly TabItem<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  className?: string;
  panelClassName?: string;
};

export function Tabs<T extends string>({
  label, items, value, defaultValue, onChange, className, panelClassName,
}: TabsProps<T>) {
  const base = useId();
  const [own, setOwn] = useState<T | undefined>(defaultValue);
  const selected = value ?? own ?? items[0]?.value;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const choose = (next: T) => {
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
    const at = enabled.findIndex(({ item }) => item.value === selected);
    if (at < 0 || enabled.length === 0) return;
    let next = at;
    if (event.key === "ArrowRight") next = (at + 1) % enabled.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + enabled.length) % enabled.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = enabled.length - 1;
    else return;
    event.preventDefault();
    choose(enabled[next].item.value);
    refs.current[enabled[next].index]?.focus();
  };

  return <div data-slot="tabs" className={cn("grid min-w-0 gap-5", className)}>
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown}
      className="grid min-w-0 auto-cols-fr grid-flow-col gap-1 rounded-pill border border-line-2 bg-field p-1">
      {items.map((item, index) => {
        const on = item.value === selected;
        return <button key={item.value} ref={(node) => { refs.current[index] = node; }}
          type="button" role="tab" id={`${base}-tab-${item.value}`} aria-controls={`${base}-panel-${item.value}`}
          aria-selected={on} tabIndex={on ? 0 : -1} disabled={item.disabled} data-state={on ? "active" : "inactive"}
          onClick={() => choose(item.value)}
          className={cn(
            "inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-pill px-3 text-[14px] font-semibold",
            "transition-[background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40",
            "disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-11",
            on ? "bg-select-bg text-select-ink shadow-soft" : "text-ink-3 hover:text-ink",
          )}>
          <span className="truncate">{item.label}</span>
          {item.badge ? <span className={cn("hidden rounded-pill px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.04em] sm:inline",
            on ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent-text")}>{item.badge}</span> : null}
        </button>;
      })}
    </div>
    {items.map((item) => <div key={item.value} role="tabpanel" id={`${base}-panel-${item.value}`}
      aria-labelledby={`${base}-tab-${item.value}`} hidden={item.value !== selected} data-tab={item.value}
      className={cn("min-w-0", panelClassName)}>
      {item.panel}
    </div>)}
  </div>;
}
