"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { createInfoTipController, type InfoTipController } from "@/lib/ui/infoTip";

/**
 * The "?" beside a card title or a label that holds the longer explanation, so the card itself can stay short
 * When it opens is lib/ui/infoTip.ts: a resting mouse after one second, a tap at once,
 * keyboard focus at once; Escape or leaving closes it.
 *
 *   <InfoTip>Paid in USDG when the vault settles each day.</InfoTip>
 *   <InfoTip text="Paid in USDG when the vault settles each day." label="About payouts" />
 *
 * The explanation is always in the page: `aria-describedby` points at it while it is hidden, so a screen reader reads
 * it with the button. The bubble sits above the icon and takes no pointer events, so it never covers or blocks the
 * card's own action.
 */
export type InfoTipProps = {
  /** The explanation. Either this or children. */
  text?: ReactNode;
  children?: ReactNode;
  /** The button's accessible name. */
  label?: string;
  align?: "center" | "start" | "end";
  className?: string;
};

const ALIGN = {
  center: "left-1/2 -translate-x-1/2",
  start: "-left-2",
  end: "-right-2",
} as const;

export function InfoTip({ text, children, label = "More info", align = "center", className }: InfoTipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const controller = useRef<InfoTipController | null>(null);
  const pressing = useRef(false);
  const bubble = useRef<HTMLSpanElement | null>(null);
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!open || !el?.parentElement) { setPlace(undefined); return; }
    const box = el.parentElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const left = Math.min(Math.max(box.left + box.width / 2 - r.width / 2, 16), vw - 16 - r.width);
    setPlace({ left: Math.round(left - box.left), right: "auto", translate: "none",
      ...(r.top < 8 ? { top: "100%", bottom: "auto", marginTop: 8, marginBottom: 0 } : {}) });
  }, [open]);
  if (controller.current === null) controller.current = createInfoTipController(setOpen);
  useEffect(() => () => controller.current?.dispose(), []);
  const tip = () => controller.current!;

  return (
    <span className={cn("relative inline-flex align-middle", className)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        className="inline-flex size-5 items-center justify-center rounded-pill border border-line-2 text-[11px] font-bold leading-none text-ink-3 hover:border-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent"
        onPointerEnter={(e) => tip().pointerEnter(e.pointerType)}
        onPointerLeave={(e) => tip().pointerLeave(e.pointerType)}
        onPointerDown={() => { pressing.current = true; }}
        onFocus={() => { tip().focus(!pressing.current); pressing.current = false; }}
        onBlur={() => { pressing.current = false; tip().blur(); }}
        onClick={() => tip().press()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) { e.stopPropagation(); tip().escape(); }
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      <span
        role="tooltip"
        id={id}
        ref={bubble}
        style={place}
        hidden={!open}
        className={cn("pointer-events-none absolute bottom-full z-30 mb-2 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-line-2 bg-surface-2 px-3 py-2 text-left text-sm font-normal normal-case leading-snug tracking-normal text-ink-2 shadow-lift", ALIGN[align])}
      >
        {text ?? children}
      </span>
    </span>
  );
}
