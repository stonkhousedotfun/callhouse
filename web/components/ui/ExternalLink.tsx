import type { AnchorHTMLAttributes, ReactNode } from "react";

/**
 * A link that leaves this origin: the app, the docs, the explorer. Always a plain <a>
 * (next/link has no route to prefetch on another host), always a new tab, always
 * `rel="noreferrer noopener"`, and it tells screen-reader users the tab will change.
 *
 * `arrow` appends a visible ↗. Nav and footer links set it; a sentence-internal link usually
 * should not.
 *
 * `srNote={false}` drops the screen-reader "(opens in a new tab)" note. Use it only where the
 * surrounding sentence already says the link opens a new tab, so it is not read out twice.
 */
export type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target" | "rel"> & {
  href: string;
  arrow?: boolean;
  srNote?: boolean;
  children: ReactNode;
};

export function ExternalLink({ href, arrow = false, srNote = true, children, ...rest }: ExternalLinkProps) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
      {arrow ? <span aria-hidden="true"> ↗</span> : null}
      {srNote ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </a>
  );
}
