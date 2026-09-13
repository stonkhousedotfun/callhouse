"use client";

/**
 * Marketing chrome for callhouse.xyz.
 *
 * The markup is deliberately the same as web/components/Nav.tsx — .topbar / .topbar-inner /
 * .brand / .nav, the same exact-match active test — because the two domains sit one click apart
 * and a visitor who crosses from here to app.callhouse.xyz should not feel the seam. Only the
 * link list and the right-hand control differ.
 *
 * "use client" buys exactly one thing: usePathname, for the active link. That is the whole client
 * island on this domain. DELIBERATELY ABSENT: the dapp's <ConnectButton /> and everything behind
 * it. There is no wallet, no wagmi, no chain read anywhere in this package, so the right-hand slot
 * that holds a connect button on the app holds a link to the app instead.
 *
 * The link order is the reader's journey and it is not the app's: land, understand the week, read
 * what can go wrong, read the legal position, and only then leave for the app.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { APP_URL } from "@/lib/site";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/risks", label: "Risks" },
  { href: "/legal", label: "Legal" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {/* On this domain "/" is the landing page, so the brand and the first nav link are the
            same destination. That is correct: the wordmark is the way back from /risks. */}
        <Link href="/" className="brand">
          call<span>house</span>
        </Link>
        <nav className="nav">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              // Exact match only. A prefix test would light "/" up on every page, since every
              // pathname starts with it.
              data-active={pathname === link.href}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        {/*
          The one control that leaves this domain, and the only call to action in the chrome.

          It is a plain <a>, not next/link: app.callhouse.xyz is a different origin and a
          different Next application, so there is no route for the router to prefetch and no
          client transition to make. next/link here would be a heavier anchor that does nothing
          extra. target/rel are set for the same reason — the reader who came to read /risks
          should still have this page when they come back from the app.

          It is LAST because the order of this bar is the argument: what this is, how the week
          runs, what can go wrong, the legal position, and only then "go and do it". It also
          sits where the dapp puts its connect button, so the two topbars have the same shape.

          The arrow is written into the label rather than left to `.ext[target]::after`, which
          globals.css suppresses on a .btn on purpose. This is the one button on the site that
          changes hostname, and it says so.
        */}
        <a
          className="btn"
          data-variant="primary"
          data-size="sm"
          href={APP_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open the app ↗
        </a>
      </div>
    </header>
  );
}
