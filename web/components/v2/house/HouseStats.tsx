"use client";

import { useEffect, useState, type ReactNode } from "react";

import { InfoTip } from "@/components/ui";
import { cn } from "@/lib/cn";

export function countdownParts(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  return `${days}d ${hours}h ${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function LiveCountdown({ to, now, className }: { to: number; now: number; className?: string }) {
  const [tick, setTick] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Math.floor(Date.now() / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className={cn("num tabular-nums", className)} data-slot="house-countdown" aria-live="off">
    {countdownParts(to - (tick ?? now))}
  </span>;
}

export type HouseStatCell = {
  label: string;
  tip?: ReactNode;
  value: ReactNode;
  words?: boolean;
  sub?: ReactNode;
  caution?: boolean;
  slot?: string;
};

const DIVIDERS = ["", "border-l", "max-lg:border-t lg:border-l", "border-l max-lg:border-t"] as const;

export function HouseStatStrip({ label, cells }: { label: string; cells: readonly HouseStatCell[] }) {
  return <section aria-label={label} data-slot="house-stats"
    className="grid min-w-0 grid-cols-2 rounded-lg border border-line-2 bg-surface lg:grid-cols-4">
    <h2 className="sr-only">{label}</h2>
    {cells.map((cell, index) => <div key={cell.label} data-slot={cell.slot}
      className={cn("min-w-0 border-line px-3.5 py-4 sm:px-6 sm:py-5", DIVIDERS[index] ?? "border-l")}>
      <div className="flex min-h-5 items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
        <span className="truncate">{cell.label}</span>
        {cell.tip ? <InfoTip label={`About ${cell.label.toLowerCase()}`} text={cell.tip} align={index % 2 === 0 ? "start" : "end"} /> : null}
      </div>
      <div className={cn("mt-1.5 min-w-0 [overflow-wrap:anywhere]",
        cell.words
          ? "font-display text-[16px] font-bold leading-snug text-ink-2 sm:text-[18px]"
          : "num text-[18px] font-semibold leading-tight tracking-[-0.01em] text-ink sm:text-[24px]")}>
        {cell.value}
      </div>
      {cell.sub !== undefined && cell.sub !== null
        ? <div className={cn("mt-1 min-w-0 text-[12.5px] leading-snug [overflow-wrap:anywhere]", cell.caution ? "font-medium text-warn" : "text-ink-3")}>{cell.sub}</div>
        : null}
    </div>)}
  </section>;
}
