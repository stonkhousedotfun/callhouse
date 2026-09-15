/**
 * Compliance surface, not marketing. The disclosures this page is required to carry — the
 * US-person perimeter and the legal form of the Stock Token — are enforced verbatim by
 * scripts/copy-lint.mjs, which fails CI if the wording drifts. Treat every sentence here as
 * legal text: do not reword, soften, or tidy up phrasing without running that script first.
 */
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ExternalLink, Notice, PageHead } from "@/components/ui";
import { cn } from "@/lib/cn";
import { MARKET, SHARE_TICKER } from "@/lib/contracts";
import { TERMS_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Legal — Callhouse",
  description:
    "Geographic restrictions and the legal form of Robinhood Chain Stock Tokens used as collateral.",
};

/** The page's h2s, in render order. The section list and the headings both read from here. */
const SECTIONS = {
  geographic: { id: "geographic-restrictions", title: "Geographic restrictions" },
  stockToken: { id: "stock-token", title: "What a Stock Token is" },
  share: { id: "vault-share", title: `What ${SHARE_TICKER} is` },
  noAdvice: { id: "no-advice", title: "No advice, no guarantee" },
  noAffiliation: { id: "no-affiliation", title: "No affiliation" },
} as const satisfies Record<string, TocEntry>;

export default function LegalPage() {
  return (
    <>
      <PageHead eyebrow="Legal" title="Who this is for, and what the collateral actually is" />

      <DocShell toc={Object.values(SECTIONS)}>
        {/* The two phrases below are required, verbatim, by scripts/copy-lint.mjs.
            They come from README "Frontend copy" and are compliance text. Do not reword. */}
        <div className={MEASURE}>
          <Notice
            tone="danger"
            title="This interface is not available to US persons."
            className="border border-line border-l-[3px] border-l-danger bg-surface! px-4! py-3.5! text-[15px]! leading-[1.6]! sm:px-5! [&>svg]:mt-[4px]! [&_strong]:mb-0.5"
          >
            The same perimeter applies as to the underlying Stock Tokens. If you are a US person, or you
            are accessing this from a jurisdiction where these instruments are not offered, do not use
            this interface.
          </Notice>
        </div>

        <DocSection {...SECTIONS.geographic}>
          <DocList>
            <li>
              Callhouse is <strong>not available to US persons</strong>, and nothing on this site is an
              offer or solicitation to any person in any jurisdiction where such an offer would be
              unlawful.
            </li>
            <li>
              Robinhood Chain Stock Tokens are offered outside the United States under their issuer&apos;s
              own terms and eligibility rules. Those rules govern whether you may hold the collateral at
              all; this interface does not widen them and cannot waive them.
            </li>
            <li>
              Access is restricted by the{" "}
              <ExternalLink href={TERMS_URL} arrow className={cn(DOC_LINK, ARROW_QUIET)}>
                Terms of Use
              </ExternalLink>
              , not by a technical control. You are responsible for your own eligibility, and for any
              tax or reporting consequence of using this interface.
            </li>
            <li>
              No know-your-customer process is run here, and none is implied. This is a permissionless
              smart contract on a public chain.
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.stockToken}>
          <DocList>
            <li>
              The collateral in this vault is a tokenised instrument issued by{" "}
              <strong>Robinhood Assets (Jersey) Limited</strong>. Stock Tokens are debt securities issued
              by that entity. They are not shares in the underlying company.
            </li>
            <li>
              Holding one gives you <strong>no shareholder rights</strong>: no vote, no direct claim on
              the underlying company, and no direct relationship with it.
            </li>
            <li>
              You carry <strong>issuer credit risk</strong> on Robinhood Assets (Jersey) Limited. If the
              issuer fails, the token&apos;s value does not survive independently of it.
            </li>
            <li>
              The issuer can <strong>freeze or restrict transfers</strong>, which can stop this vault
              writing, settling, and paying out tokens until it is lifted. The token can also pause its
              own price oracle, which stops this vault writing and listing new calls; settlement does
              not read the oracle. No Callhouse contract can override either.
            </li>
            <li>
              Corporate actions — splits, dividend adjustments — are expressed through an ERC-8056
              display multiplier rather than by rebasing balances. This interface shows the adjusted
              figure clearly labelled as display-only; all vault accounting uses raw balances.
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.share}>
          <DocList>
            <li>
              {SHARE_TICKER} is a vault share. It represents a pro-rata claim on the {MARKET} Stock
              Tokens the vault holds, plus separately accrued USDG. It is not itself a Stock Token, not a
              deposit, and not a claim on Callhouse, Valorem or any Robinhood entity.
            </li>
            <li>
              There is no protocol token, no points programme and no airdrop attached to this vault.
            </li>
            <li>
              Premium is paid only when a buyer fills the weekly listing. A week with no buyer pays
              nothing, and an exercised call takes collateral at the strike.{" "}
              <Link href="/docs" className={DOC_LINK}>The docs page</Link> carries the full risk list.
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.noAdvice}>
          <DocList>
            <li>
              Nothing on this site is investment, legal, tax or accounting advice, and nothing here is an
              offer of securities.
            </li>
            <li>
              The Callhouse smart contracts have not been audited. They are provided as-is,
              under the MIT licence, with no warranty of any kind. You can lose the collateral you
              deposit.
            </li>
            <li>
              Past weekly results, including any published on{" "}
              <Link href="/activity" className={DOC_LINK}>the activity page</Link>, describe what has already happened and say
              nothing about what any future week will do.
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.noAffiliation}>
          <p>
            Callhouse is an independent project. It is not affiliated with, endorsed by, or operated by
            Robinhood Markets, Inc., Robinhood Assets (Jersey) Limited, Valorem, or the issuers of USDG or
            Seaport. Those names appear here only to identify the third-party contracts and services this
            vault interacts with.
          </p>
        </DocSection>
      </DocShell>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
   The reading layout, modelled on callhouse-site's LegalDocument shell. app/docs/page.tsx and
   app/legal/page.tsx each carry an identical copy, because a Next page file may not export components.
   Layout and type only. The one string it adds is the section-list label; the list itself repeats
   the page's own h2 text from SECTIONS.
   ------------------------------------------------------------------------------------------------ */

type TocEntry = { readonly id: string; readonly title: string };

const TOC_LABEL = "On this page";

const TOC_LINK =
  "block rounded-sm py-1.5 text-[14px] leading-snug text-ink-2 no-underline transition-colors duration-150 hover:text-ink focus-visible:outline-offset-[-2px]";

/** Inline links in running text. */
const DOC_LINK = "link font-medium text-ink";

/** The reading measure. Nothing in the column runs wider than this. */
const MEASURE = "max-w-[68ch]";

/**
 * ExternalLink's ` ↗` (an aria-hidden span) as a quiet glyph outside the underline: an
 * inline-block is not underlined by its parent, and its leading space stays in the text.
 */
const ARROW_QUIET =
  "[&>span[aria-hidden]]:ml-1 [&>span[aria-hidden]]:inline-block [&>span[aria-hidden]]:text-ink-3";

/**
 * Under the page head: a hairline, then a sticky section list beside the reading column from 960px,
 * folded into a disclosure above the column below it.
 */
function DocShell({ toc, children }: { toc: readonly TocEntry[]; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-16 border-t border-line pt-8 sm:pt-12 lg:grid-cols-[220px_minmax(0,1fr)] xl:gap-x-20">
      <nav aria-labelledby="toc-heading" className="hidden lg:block">
        <div className="sticky top-8 max-h-[calc(100dvh-4rem)] overflow-y-auto pb-2">
          <p
            id="toc-heading"
            className="font-body text-[12.5px] font-bold uppercase leading-none tracking-[0.1em] text-ink-3"
          >
            {TOC_LABEL}
          </p>
          <ol className="mt-4 border-l border-line">
            {toc.map((entry) => (
              <li key={entry.id} className="-ml-px border-l border-transparent pl-4 hover:border-ink-3">
                <a href={`#${entry.id}`} className={TOC_LINK}>
                  {entry.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </nav>

      <div className="min-w-0 text-[16.5px] leading-[1.7] text-ink-2 [&_em]:text-ink [&_strong]:font-semibold [&_strong]:text-ink">
        <nav aria-label={TOC_LABEL} className={cn("mb-10 lg:hidden", MEASURE)}>
          <details className="group rounded-md border border-line bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-4 py-3 text-[14.5px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
              {TOC_LABEL}
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden="true"
                focusable="false"
                className="shrink-0 text-ink-3 transition-transform duration-150 group-open:rotate-180"
              >
                <path fill="currentColor" d="M2.6 5.1 3.7 4 7 7.3 10.3 4l1.1 1.1L7 9.5 2.6 5.1Z" />
              </svg>
            </summary>
            <ol className="border-t border-line px-4 py-2">
              {toc.map((entry) => (
                <li key={entry.id}>
                  <a href={`#${entry.id}`} className={TOC_LINK}>
                    {entry.title}
                  </a>
                </li>
              ))}
            </ol>
          </details>
        </nav>
        {children}
      </div>
    </div>
  );
}

/**
 * One h2 section. `id` goes on the heading and is what the section list links to. The measure sits
 * on the section, so the heading and its body share one right edge.
 */
function DocSection({ id, title, children }: TocEntry & { children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={cn("mt-14", MEASURE)}>
      <h2 id={id} className="scroll-mt-8 text-[length:clamp(22px,2.4vw,26px)] font-bold leading-[1.2] tracking-[-0.02em]">
        {title}
      </h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

/** A bulleted list. */
function DocList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2.5 pl-5 marker:text-ink-3">{children}</ul>;
}
