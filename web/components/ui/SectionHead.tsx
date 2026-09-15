import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Eyebrow } from "./Eyebrow";

/**
 * The mockup's .section-head: eyebrow + heading on the left, the intro paragraph on the right,
 * bottom-aligned. One column at or below 960px (Tailwind `lg` is 960px on this site). Without an
 * intro it is a single column at every width.
 *
 * `level` 2 (default) is a section inside a page. `level` 1 is the page head on a sub-page
 * (/how-it-works, /risks, /legal ...): same layout, a larger heading. A page has exactly one h1.
 *
 * `id` goes on the heading, so a wrapping <Section labelledBy="..."> can point at it.
 * A string intro is wrapped in <p>; pass JSX to control the markup yourself.
 */
export type SectionHeadProps = {
  eyebrow?: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  level?: 1 | 2;
  id?: string;
  className?: string;
};

export function SectionHead({ eyebrow, title, intro, level = 2, id, className }: SectionHeadProps) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div
      className={cn(
        "mb-11 grid grid-cols-1 items-end gap-x-10 gap-y-4",
        intro ? "lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" : null,
        className,
      )}
    >
      <div>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Heading
          id={id}
          className={cn(
            "font-extrabold tracking-[-0.03em]",
            level === 1
              ? "text-[length:clamp(36px,4.8vw,56px)] leading-[1.04]"
              : "text-[length:clamp(30px,3.6vw,44px)] leading-[1.06]",
            eyebrow ? "mt-3" : null,
          )}
        >
          {title}
        </Heading>
      </div>
      {intro ? (
        <div className="max-w-[36em] text-[17.5px] text-ink-2">
          {typeof intro === "string" ? <p>{intro}</p> : intro}
        </div>
      ) : null}
    </div>
  );
}
