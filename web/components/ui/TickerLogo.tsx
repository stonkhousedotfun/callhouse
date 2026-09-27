import type { CSSProperties } from "react";

import { cn } from "@/lib/cn";

/**
 * A market's logo, drawn in front of its ticker.
 * Always decorative: the ticker is written right beside it, so the image has alt="" and the fallback is aria-hidden,
 * and a screen reader hears the ticker once. It is 1em square, so it matches the text it sits in.
 *
 * The marks are Simple Icons 16.32.0 paths (CC0), in public/tokens/. NVIDIA keeps its green, on a white plate. SpaceX is one colour and
 * is painted through a CSS mask in the text colour (`ink`), so it reads in day and night mode alike; an <img> cannot
 * take the text colour. A ticker with no mark here gets its first letter in a small rounded chip.
 */
const LOGOS: Readonly<Record<string, { src: string; ink?: true }>> = {
  NVDA: { src: "/tokens/nvda.svg" },
  SPCX: { src: "/tokens/spcx.svg", ink: true },
};

export function TickerLogo({ ticker, className }: { ticker: string; className?: string }) {
  const logo = LOGOS[ticker.toUpperCase()];
  if (logo?.ink) {
    const mask = `url(${logo.src}) center / contain no-repeat`;
    const style: CSSProperties = { mask, WebkitMask: mask };
    return <span aria-hidden="true" data-ticker-logo={ticker}
      className={cn("inline-block size-[1em] shrink-0 bg-current", className)} style={style} />;
  }
  if (logo) {
    // A static local SVG at text size; next/image adds nothing here. A brand-coloured mark sits on a small white plate so
    // it stays visible on any chip, including the accent-green selected one (NVIDIA's green vanished there).
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo.src} alt="" data-ticker-logo={ticker}
      className={cn("inline-block size-[1em] shrink-0 rounded-[0.22em] bg-white p-[0.08em]", className)} />;
  }
  return (
    <span aria-hidden="true" data-ticker-logo={ticker}
      className={cn("inline-grid size-[1em] shrink-0 place-items-center rounded-[0.28em] bg-surface-2 ring-1 ring-line", className)}>
      <span className="text-[0.55em] font-bold leading-none text-ink-2">{ticker.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}
