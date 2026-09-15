import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** The mockup's .eyebrow: small uppercase accent label above a section heading. */
export type EyebrowProps = {
  as?: "p" | "span" | "div";
  className?: string;
  children: ReactNode;
};

export function Eyebrow({ as: Tag = "p", className, children }: EyebrowProps) {
  return (
    <Tag
      className={cn(
        "font-body text-[12.5px] font-bold uppercase leading-none tracking-[0.1em] text-accent-text",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
