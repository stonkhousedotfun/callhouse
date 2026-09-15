import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** A scrolling monospace block for raw JSON (the order payload). Scrolls both ways inside itself. */
export function CodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <pre
      tabIndex={0}
      className={cn(
        "num max-h-[460px] overflow-auto rounded-md border border-line bg-surface-2 p-3.5 text-[12px] leading-[1.55] text-ink-2 focus-visible:outline-offset-[-2px]",
        className,
      )}
    >
      {children}
    </pre>
  );
}
