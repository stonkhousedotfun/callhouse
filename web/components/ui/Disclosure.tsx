import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { ChevronDownIcon } from "./icons";

export function Disclosure({ title, summary, open, className, children, ...rest }: {
  title: ReactNode;
  summary?: ReactNode;
  open?: boolean;
  className?: string;
  children: ReactNode;
  "data-slot"?: string;
}) {
  return <details open={open || undefined} data-slot={rest["data-slot"] ?? "disclosure"}
    className={cn("group min-w-0 rounded-lg border border-line-2 bg-surface", className)}>
    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-[18px] py-3.5 sm:px-[22px] [&::-webkit-details-marker]:hidden">
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold leading-snug text-ink">{title}</span>
        {summary ? <span className="mt-0.5 block text-[13px] text-ink-3">{summary}</span> : null}
      </span>
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-pill border border-line-2 text-ink-2 transition-transform duration-150 group-open:rotate-180"><ChevronDownIcon /></span>
    </summary>
    <div className="grid min-w-0 gap-4 border-t border-line px-[18px] py-4 text-sm leading-relaxed text-ink-2 sm:px-[22px]">{children}</div>
  </details>;
}
