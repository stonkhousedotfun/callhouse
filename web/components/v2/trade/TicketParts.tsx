"use client";

import type { ReactNode } from "react";

import { InfoTip } from "@/components/ui";
import { cn } from "@/lib/cn";


export function TicketHead({ title, sub, day }: { title: ReactNode; sub?: ReactNode; day?: ReactNode }) {
  return <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 className="font-display text-[20px] font-extrabold leading-tight tracking-[-0.02em] text-ink">{title}</h2>
      {sub ? <p className="mt-0.5 text-[13px] text-ink-3">{sub}</p> : null}
    </div>
    {day ? <span className="shrink-0 rounded-pill border border-line-2 bg-surface-2 px-2.5 py-1 text-xs font-bold text-ink-2">{day}</span> : null}
  </div>;
}

export type ToggleOption<T extends string> = { value: T; label: string };

export function Toggle<T extends string>({ label, options, value, onChange, size = "sm", className }: {
  label: string;
  options: readonly ToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return <div role="group" aria-label={label} className={cn(
    "grid auto-cols-fr grid-flow-col gap-0.5 rounded-pill border border-line-2 bg-field p-[3px]", className)}>
    {options.map((option) => {
      const on = option.value === value;
      return <button key={option.value} type="button" aria-pressed={on} onClick={() => onChange(option.value)}
        className={cn("inline-flex items-center justify-center rounded-pill font-bold transition-[background-color,color] duration-150",
          "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40",
          size === "md" ? "min-h-11 px-4 text-[14px] sm:min-h-10" : "min-h-9 px-3 text-[12.5px] max-sm:min-h-10",
          on ? "bg-select-bg text-select-ink shadow-soft" : "text-ink-3 hover:text-ink")}>
        {option.label}
      </button>;
    })}
  </div>;
}

export function PickChip({ pressed, onClick, mono = true, children }: {
  pressed: boolean; onClick: () => void; mono?: boolean; children: ReactNode;
}) {
  return <button type="button" onClick={onClick} aria-pressed={pressed}
    className={cn("min-h-11 rounded-pill border px-3 text-[13px] font-semibold transition-colors sm:min-h-9",
      "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40",
      mono ? "num" : null,
      pressed ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface-2 text-ink-2 hover:border-ink-3 hover:text-ink")}>
    {children}
  </button>;
}

export function InputLabel({ htmlFor, label, tip, tipLabel, aside }: {
  htmlFor: string; label: ReactNode; tip?: ReactNode; tipLabel?: string; aside?: ReactNode;
}) {
  return <div className="flex min-h-9 min-w-0 items-center justify-between gap-3">
    <span className="flex min-w-0 items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink-2">{label}</label>
      {tip ? <InfoTip text={tip} align="start" label={tipLabel ?? (typeof label === "string" ? `About ${label.toLowerCase()}` : "More info")} /> : null}
    </span>
    {aside}
  </div>;
}

export function SummaryBox({ children, className, footer }: { children: ReactNode; className?: string; footer?: ReactNode }) {
  return <div className={cn("rounded-md border border-line bg-field px-4 py-1.5", className)}>
    <dl className="grid min-w-0">{children}</dl>
    {footer}
  </div>;
}

export function SummaryRow({ k, v, tip, tipLabel, tone = "ink", slot, strong = false, mono = true }: {
  k: ReactNode;
  v: ReactNode;
  tip?: ReactNode;
  tipLabel?: string;
  tone?: "ink" | "accent" | "danger" | "muted";
  slot?: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return <div data-slot={slot ?? "row"}
    className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line py-2 text-[13.5px] last:border-b-0">
    <dt data-slot="k" className="inline-flex min-w-0 items-center gap-1.5 text-ink-2">
      {k}{tip ? " " : null}
      {tip ? <InfoTip text={tip} align="start" label={tipLabel ?? (typeof k === "string" ? `About ${k.toLowerCase()}` : "More info")} /> : null}
    </dt>
    <dd data-slot="v" className={cn("ml-auto min-w-0 text-right [overflow-wrap:anywhere]", mono && "num", strong ? "font-bold" : "font-medium", {
      ink: "text-ink", accent: "text-accent-text", danger: "text-danger-text", muted: "text-ink-3",
    }[tone])}>{v}</dd>
  </div>;
}

export function StepButton({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: ReactNode;
}) {
  return <button type="button" aria-label={label} disabled={disabled} onClick={onClick}
    className="grid size-11 shrink-0 place-items-center rounded-pill border border-line-2 bg-surface-2 text-lg text-ink transition-colors hover:border-ink-3 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40 disabled:opacity-40 sm:size-10">
    {children}
  </button>;
}

export function TicketSections({ children }: { children: ReactNode }) {
  return <div data-slot="ticket-sections" className="-mx-[18px] -mb-[18px] border-t border-line sm:-mx-[22px] sm:-mb-[22px]">{children}</div>;
}

export function TicketSection({ title, summary, children, slot }: {
  title: ReactNode; summary?: ReactNode; children: ReactNode; slot?: string;
}) {
  return <details data-slot={slot ?? "ticket-section"} className="group border-b border-line last:border-b-0">
    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-[18px] py-3 sm:px-[22px] [&::-webkit-details-marker]:hidden">
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold text-ink">{title}</span>
        {summary ? <span className="mt-0.5 block truncate text-[12.5px] text-ink-3">{summary}</span> : null}
      </span>
      <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-pill border border-line-2 text-[12px] text-ink-2 transition-transform duration-150 group-open:rotate-180">▾</span>
    </summary>
    <div className="grid min-w-0 gap-4 px-[18px] pb-[18px] text-sm leading-relaxed text-ink-2 sm:px-[22px] sm:pb-[22px]">{children}</div>
  </details>;
}
