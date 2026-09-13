"use client";

/**
 * Site chrome. The link order is the depositor's journey: land on the vault, deposit, watch the
 * cycle, audit the tape, then read the docs and the legal text.
 *
 * One link leaves the app entirely: callhouse.finance, the marketing site. It is LAST, and it is
 * deliberately not part of LINKS — it is a plain <a>, not next/link, because next/link is for
 * routes this app owns and prefetching another origin is meaningless. It is also never
 * "active": there is no pathname in this app that corresponds to it, so the exact-match test
 * above would be a lie if it were in the array.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { SITE_URL } from "@/lib/site";
import { ConnectButton } from "./ConnectButton";

const LINKS = [
  { href: "/", label: "Vault" },
  { href: "/vault/nvda", label: "Deposit" },
  { href: "/vault/nvda/cycle", label: "Cycle" },
  { href: "/activity", label: "Activity" },
  { href: "/docs", label: "Docs" },
  { href: "/legal", label: "Legal" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {/* The brand still points at "/". Inside the app, home is the vault — not the
            marketing site. Someone who wants callhouse.finance uses the last nav link. */}
        <Link href="/" className="brand">
          call<span>house</span>
        </Link>
        <nav className="nav">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              // Exact match only: /vault/nvda and /vault/nvda/cycle are separate destinations and
              // a prefix test would highlight both at once.
              data-active={pathname === link.href}
            >
              {link.label}
            </Link>
          ))}
          {/* Off-site, so: plain anchor, new tab, noreferrer, and the same ↗ the footer and the
              explorer links use. Dimmed a step below the in-app links and separated by a rule so
              it does not read as a seventh route of this app. */}
          <a
            href={SITE_URL}
            target="_blank"
            rel="noreferrer noopener"
            data-external="true"
            style={{
              color: "var(--fg-faint)",
              marginLeft: 6,
              paddingLeft: 12,
              borderLeft: "1px solid var(--line)",
              borderRadius: 0,
            }}
          >
            callhouse.finance ↗
          </a>
        </nav>
        <ConnectButton />
      </div>
    </header>
  );
}
