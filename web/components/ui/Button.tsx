import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { ExternalLink } from "./ExternalLink";

/**
 * The Neon button: a pill at every size. First copied
 * from callhouse-site: components/ui/Button.tsx; the app adds the `xs` size for inline controls such as an amount
 * field's "max". Four variants:
 *   - primary:   accent fill. One per view, for the thing the reader came to do (Connect, Review order, Buy).
 *   - secondary: raised chip fill (--surface-2) with a --line-2 outline. The row-level action in a table ("Buy" on an
 *                ask row) and the unselected state of a chip.
 *   - ghost:     transparent with a --line-2 outline. The secondary action beside a primary. This is the variant the
 *                app's ~100 existing call sites already use in that role, so it keeps its outline and only loses its
 *                fill, which on the black night ground was a second grey that the Neon palette does not have.
 *   - inverse:   transparent with a ground-coloured border and text, for a ghost button on an ink-coloured band.
 *   - select:    the inverted fill (--select-bg / --select-ink) of a SELECTED chip or segment. Only Segments and
 *                DayPicker use it, as the pressed state; it is not a call-to-action colour.
 *   - quiet:     borderless and transparent, --ink-3 text: an unselected segment inside a SegmentedControl track.
 *
 * `md` is at least 44px tall (touch targets), and so is `touch`, which is `sm`'s look at that height.
 * `sm` and `xs` are for dense rows and inline controls beside a larger target; do not use them as the only way to
 * reach an action on a phone.
 *
 * What it renders is decided by `href`:
 *   - no href                    → <button type="button">
 *   - http(s) URL, or external   → <a target=_blank rel="noreferrer noopener"> via ExternalLink
 *   - "/route"                   → next/link
 *   - anything else ("#how", "mailto:") → plain <a>
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "inverse" | "select" | "quiet";
export type ButtonSize = "md" | "touch" | "sm" | "xs";

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
};

export type LinkButtonProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children" | "href"> & {
    href: string;
    /** Force new-tab behaviour. Defaults to true for http(s) URLs. */
    external?: boolean;
  };

export type NativeButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
    href?: undefined;
  };

export type ButtonProps = LinkButtonProps | NativeButtonProps;

const BASE =
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-pill border font-body font-bold leading-none no-underline transition-[background-color,border-color,transform] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60";

const SIZE: Record<ButtonSize, string> = {
  md: "min-h-11 px-[22px] py-3 text-[15px]",
  // sm's padding and type at the 44px touch height: for a control that IS the only way to its action on a
  // phone, such as the header's wallet button. A size of its own, because `cn` does not resolve conflicts and a
  // `min-h-11` className beside sm's `min-h-9` would leave the winner to stylesheet order.
  touch: "min-h-11 px-4 py-2 text-sm",
  sm: "min-h-9 px-4 py-2 text-sm",
  xs: "px-2.5 py-1 text-xs",
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent text-accent-ink hover:bg-accent-hover active:translate-y-px",
  secondary: "border-line-2 bg-surface-2 text-ink hover:border-ink-3",
  ghost: "border-line-2 bg-transparent text-ink hover:bg-surface-2",
  inverse: "border-ground/30 bg-transparent text-ground hover:bg-ground/10",
  select: "border-select-bg bg-select-bg text-select-ink",
  quiet: "border-transparent bg-transparent text-ink-3 hover:text-ink",
};

/** The class string on its own, for the rare element that must look like a button but is not one. */
export function buttonClasses({
  variant = "primary",
  size = "md",
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn(BASE, SIZE[size], VARIANT[variant], className);
}

export function Button(props: ButtonProps) {
  if (props.href === undefined) {
    const { variant, size, className, children, type, ...rest } = props;
    return (
      <button type={type ?? "button"} className={buttonClasses({ variant, size, className })} {...rest}>
        {children}
      </button>
    );
  }

  const { variant, size, className, children, href, external, ...rest } = props;
  const classes = buttonClasses({ variant, size, className });

  if (external ?? /^https?:\/\//i.test(href)) {
    return (
      <ExternalLink href={href} className={classes} {...rest}>
        {children}
      </ExternalLink>
    );
  }
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={classes} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={classes} {...rest}>
      {children}
    </a>
  );
}
