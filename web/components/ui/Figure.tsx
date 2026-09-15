import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Numbers. Every figure on the site is Geist Mono with tabular figures.
 *
 * <Num> is the inline form: `<Num unit="USDG">225.00</Num>`. The unit renders as a smaller,
 * muted <small> after a space, like the mockup's `225.00 <small>USDG</small>`.
 *
 * <Figure> is one label/value pair and renders `<div><dt/><dd/></div>`, so it MUST sit inside a
 * <dl>. Shapes from the mockup:
 *   - hero facts:     <Figure label="Launch cap" value="20 NVDA" />                  (size md)
 *   - week card:      <Figure boxed size="lg" label="Strike" value="225.00" unit="USDG" />
 *   - endings panel:  <Figure boxed caps mono={false} size="sm" label="Premium" value="None" />
 *
 * Figures from the fork rehearsal are examples; label them as such next to where they appear.
 */
export type NumTone = "ink" | "ink-2" | "accent" | "usdg";

const TONE: Record<NumTone, string> = {
  ink: "text-ink",
  "ink-2": "text-ink-2",
  accent: "text-accent-text",
  usdg: "text-usdg",
};

export type NumProps = {
  tone?: NumTone;
  unit?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function Num({ tone, unit, className, children }: NumProps) {
  return (
    <span className={cn("num", tone ? TONE[tone] : null, className)}>
      {children}
      {unit ? (
        <>
          {" "}
          <small className="text-[0.625em] font-medium tracking-normal text-ink-3">{unit}</small>
        </>
      ) : null}
    </span>
  );
}

export type FigureSize = "sm" | "md" | "lg";

export type FigureProps = {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  tone?: NumTone;
  /** sm 15px · md 17px (default) · lg 20px. */
  size?: FigureSize;
  /** surface-2 tile with a md radius, as in the week card's strike row. */
  boxed?: boolean;
  /** Uppercase tracked label, as in the endings outcome tiles. */
  caps?: boolean;
  /** Set false when the value is words, not a number ("Back at close"). */
  mono?: boolean;
  className?: string;
};

const SIZE: Record<FigureSize, string> = {
  sm: "text-[15px] leading-[1.35]",
  md: "text-[17px] leading-[1.3]",
  lg: "text-[20px] leading-[1.2]",
};

export function Figure({
  label,
  value,
  unit,
  tone,
  size = "md",
  boxed = false,
  caps = false,
  mono = true,
  className,
}: FigureProps) {
  return (
    <div className={cn("grid content-start gap-1", boxed ? "rounded-md bg-surface-2 p-3.5" : null, className)}>
      <dt
        className={cn(
          "text-ink-3",
          caps ? "text-[12.5px] font-semibold uppercase tracking-[0.06em]" : size === "md" ? "text-[13px]" : "text-[12.5px]",
        )}
      >
        {label}
      </dt>
      <dd className={cn("font-semibold", SIZE[size], mono ? "num" : null, tone ? TONE[tone] : null)}>
        {value}
        {unit ? (
          <>
            {" "}
            <small className="text-[0.625em] font-medium tracking-normal text-ink-3">{unit}</small>
          </>
        ) : null}
      </dd>
    </div>
  );
}
