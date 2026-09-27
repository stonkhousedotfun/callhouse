import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Page width (Neon): the desktop artboard is 1280px with 40px side gutters, so the
 * content is at most 1200px, centred. Gutters are 16px on a phone, 20px from 640px and 40px from 1024px.
 * `box-content` makes the 1200 the CONTENT width, so the gutter is added outside it rather than eaten from it.
 * Inside it, RailLayout splits the 1200 into the 820px main column, a 40px gap and the ~340px rail.
 */
export type ContainerProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  as?: "div" | "header" | "footer" | "section" | "nav";
  children: ReactNode;
};

export function Container({ as: Tag = "div", className, children, ...rest }: ContainerProps) {
  return (
    <Tag className={cn("mx-auto box-content max-w-[1200px] px-4 sm:px-5 lg:px-10", className)} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * The mockup's `section.band`: a full-width section with a 1px top rule (inset by the gutter),
 * 80px vertical padding (56px below 560px), and the same 1200px content column and gutters as Container.
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
    <section id={id} aria-labelledby={labelledBy} className={cn("px-4 sm:px-5 lg:px-10", className)} {...rest}>
      <div className={cn("py-14 sm:py-20", bordered ? "border-t border-line" : null)}>
        <div className={cn("mx-auto max-w-[1200px]", innerClassName)}>{children}</div>
      </div>
    </section>
  );
}

/**
 * The Neon page split: an 820px main column and a right rail that takes the rest of the 1200px
 * content width after a 40px gap, about 340px. Below 1024px the two stack, main first, because on a phone the rail's
 * job (the order ticket) moves to the sticky buy bar above the tab bar.
 *
 * TEST HOOKS: `data-slot` main-column / rail.
 */
export type RailLayoutProps = {
  main: ReactNode;
  rail: ReactNode;
  /** Names the rail landmark ("Order ticket", "Leaderboard"). */
  railLabel?: string;
  className?: string;
};

export function RailLayout({ main, rail, railLabel, className }: RailLayoutProps) {
  return (
    <div className={cn("grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:gap-10", className)}>
      <div data-slot="main-column" className="min-w-0">
        {main}
      </div>
      <aside data-slot="rail" aria-label={railLabel} className="min-w-0">
        {rail}
      </aside>
    </div>
  );
}
