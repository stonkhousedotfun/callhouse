import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Eyebrow } from "./Eyebrow";

/**
 * The head of an app page: eyebrow, h1, lede. The site's <SectionHead level={1}> scaled down for a
 * working screen, where the figures below the head are the point: the h1 tops out at 44px, not 56px,
 * and the lede sits under the heading rather than beside it, so the first card starts higher.
 *
 * `aside` renders to the right of the heading from 960px (a phase chip, a button) and under it below.
 */
export function PageHead({
  eyebrow,
  title,
  lede,
  aside,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 items-end gap-x-10 gap-y-5 pb-8 pt-6 sm:pb-10 lg:pt-10",
        aside ? "lg:grid-cols-[minmax(0,1fr)_auto]" : null,
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <h1
          className={cn(
            "max-w-[22em] text-[length:clamp(30px,4vw,44px)] font-extrabold leading-[1.06] tracking-[-0.03em]",
            eyebrow ? "mt-3" : null,
          )}
        >
          {title}
        </h1>
        {lede ? (
          <div className="mt-4 max-w-[44em] text-[16.5px] leading-[1.6] text-ink-2 sm:text-[17.5px]">
            {typeof lede === "string" ? <p>{lede}</p> : lede}
          </div>
        ) : null}
      </div>
      {aside ? <div className="min-w-0">{aside}</div> : null}
    </div>
  );
}
