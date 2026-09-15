import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * The mockup's .chip: a small rounded-full status label (copied from callhouse-site:
 * components/ui/Chip.tsx). `dot` adds the 7px current-colour dot the accent chips carry ("Listed").
 * `wrap` lets a long chip break across lines instead of running past a 390px screen.
 *
 * The app adds one tone, `danger`, for the states that stop the vault (a stranded claim, writes
 * halted). The shared palette has no --danger-soft, so its ground is the danger token at 10%.
 */
export type ChipTone = "neutral" | "accent" | "warn" | "usdg" | "danger";

export type ChipProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  tone?: ChipTone;
  dot?: boolean;
  wrap?: boolean;
  children: ReactNode;
};

const TONE: Record<ChipTone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  accent: "bg-accent-soft text-accent-text",
  warn: "bg-warn-soft text-warn",
  usdg: "bg-usdg-soft text-usdg",
  danger: "bg-danger/10 text-danger",
};

export function Chip({ tone = "neutral", dot = false, wrap = false, className, children, ...rest }: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-[7px] rounded-full px-2.5 py-1.5 font-body text-[12.5px] font-semibold",
        wrap ? "leading-tight" : "whitespace-nowrap leading-none",
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {dot ? <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
