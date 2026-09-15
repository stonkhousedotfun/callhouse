import Link from "next/link";

import { cn } from "@/lib/cn";

/**
 * The Daylight brand mark: an accent rounded square with a rising line over a base rule. It is
 * the mockup's CSS mark (.brand-mark::before/::after) redrawn as SVG with the same geometry on a
 * 26px grid, so it scales and needs no pseudo-elements. Not a feather, not Robinhood green.
 */
export function BrandMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 26 26"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <rect width="26" height="26" rx="8" className="fill-accent" />
      <rect x="6" y="16.5" width="14" height="2.5" rx="1" className="fill-accent-ink" />
      <path d="M7 15 12.04 8.7 14.68 11.58 19 6v1.98l-4.08 6.12-2.76-2.88L8.44 15Z" className="fill-accent-ink" />
    </svg>
  );
}

/** Mark + "stonkhouse" wordmark, linking home. */
export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex items-center gap-[9px] rounded-[10px] font-display text-[21px] font-extrabold leading-none tracking-[-0.03em] text-ink no-underline",
        className,
      )}
    >
      <BrandMark />
      stonkhouse
    </Link>
  );
}
