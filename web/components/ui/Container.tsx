import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Page width: content at most 1160px, centred, with a 16px side gutter below 560px and 20px
 * above (the mockup's body padding). `box-content` makes the 1160 the CONTENT width, so the
 * gutter is added outside it rather than eaten from it.
 */
export type ContainerProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  as?: "div" | "header" | "footer" | "section" | "nav";
  children: ReactNode;
};

export function Container({ as: Tag = "div", className, children, ...rest }: ContainerProps) {
  return (
    <Tag className={cn("mx-auto box-content max-w-[1160px] px-4 sm:px-5", className)} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * The mockup's `section.band`: a full-width section with a 1px top rule (inset by the gutter),
 * 80px vertical padding (56px below 560px), and a 1160px content column.
 *
 * `labelledBy` sets aria-labelledby; point it at the id you gave <SectionHead id="...">.
 * `bordered={false}` drops the top rule (a first section straight under the hero or page head).
 */
export type SectionProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  id?: string;
  labelledBy?: string;
  bordered?: boolean;
  innerClassName?: string;
  children: ReactNode;
};

export function Section({
  id,
  labelledBy,
  bordered = true,
  className,
  innerClassName,
  children,
  ...rest
}: SectionProps) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn("px-4 sm:px-5", className)} {...rest}>
      <div className={cn("py-14 sm:py-20", bordered ? "border-t border-line" : null)}>
        <div className={cn("mx-auto max-w-[1160px]", innerClassName)}>{children}</div>
      </div>
    </section>
  );
}
