import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { ExternalLink } from "./ExternalLink";

/**
 * The mockup's .btn (copied from callhouse-site: components/ui/Button.tsx; the app adds the `xs`
 * size for inline controls such as an amount field's "max"). Three variants:
 *   - primary: accent fill. One per view, for the thing the reader came to do.
 *   - ghost:   surface fill with a line border. The secondary action next to a primary.
 *   - inverse: transparent with a ground-coloured border and text, for the ghost button that sits
 *              on the ink-coloured CTA band (the mockup's `.cta-band .btn-ghost`).
 *
 * What it renders is decided by `href`:
 *   - no href                    → <button type="button">
 *   - http(s) URL, or external   → <a target=_blank rel="noreferrer noopener"> via ExternalLink
 *   - "/route"                   → next/link
 *   - anything else ("#how", "mailto:") → plain <a>
 */
export type ButtonVariant = "primary" | "ghost" | "inverse";
export type ButtonSize = "md" | "sm" | "xs";

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
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap border font-body font-semibold leading-none no-underline transition-[background-color,border-color,transform] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60";

const SIZE: Record<ButtonSize, string> = {
  md: "rounded-xl px-[18px] py-[13px] text-[15px]",
  sm: "rounded-[10px] px-3.5 py-2.5 text-sm",
  xs: "rounded-[7px] px-2 py-1 text-xs",
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent text-accent-ink hover:bg-accent-hover active:translate-y-px",
  ghost: "border-line-2 bg-surface text-ink hover:bg-surface-2",
  inverse: "border-ground/30 bg-transparent text-ground hover:bg-ground/10",
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
