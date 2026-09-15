/**
 * app.stonkhouse.fun/ — the app home. 1-lot covered calls, not a pooled vault.
 *
 * Deposit and write on /account. Buy lots on /book. The old pooled vault is closed; collect a
 * queued redemption on /collect.
 *
 * Status matches stonkhouse.fun: beta, pending audit.
 */
import Link from "next/link";

import { Button, Card, Chip, ExternalLink, Figure, Notice, PageHead, SectionHead } from "@/components/ui";
import { MARKET } from "@/lib/contracts";
import { SITE_URL, STATUS } from "@/lib/site";

const ACCOUNT_HREF = "/account";
const BOOK_HREF = "/book";

const ROADMAP = [
  {
    when: "Now",
    title: "Beta, NVDA first",
    current: true,
    body: `Public beta. ${MARKET} first. You choose how much of yours is for sale each week. ${STATUS.audit}.`,
  },
  {
    when: "Next",
    title: "External audit",
    current: false,
    body: "An external audit of the contracts. The report is published. The cap stays until then.",
  },
  {
    when: "Then",
    title: "Four published weeks",
    current: false,
    body: "Four closed weeks on the public record, zeros included, before the cap moves.",
  },
  {
    when: "Later",
    title: "More stock books",
    current: false,
    body: "Additional Stock Token books, one underlying each, same week and the same rules.",
  },
] as const;

export default function HomePage() {
  return (
    <>
      <PageHead
        eyebrow="Robinhood Chain"
        title={
          <>
            Let your stonks work for you.{" "}
            <span className="text-accent-text">{MARKET} first.</span>
          </>
        }
        lede={
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              <Chip tone="accent" dot>
                {STATUS.phase}
              </Chip>
              <Chip tone="warn">{STATUS.audit}</Chip>
            </div>
            <p>
              Put your {MARKET} in. Each week someone can pay you for the chance to buy it at a set price. If they
              don&apos;t, you keep the stock. Only the amount you offer can be sold.
            </p>
          </>
        }
        aside={
          <Button href={ACCOUNT_HREF} className="max-sm:w-full">
            Open your account
          </Button>
        }
      />

      <Notice tone="warn" className="mb-6 lg:[&>div]:max-w-[88ch]">
        Premium is paid only if a buyer fills. Assignment can take the collateral at the strike. Stock Tokens are debt
        securities, not Nvidia shares. {STATUS.phase}. {STATUS.auditLine}
      </Notice>

      <div className="grid gap-4 sm:gap-5">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <Card lift className="grid gap-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Chip tone="accent" dot>
                  Live first
                </Chip>
                <h2 className="mt-3 text-[26px] font-extrabold tracking-[-0.02em]">
                  {MARKET}
                </h2>
                <p className="mt-1.5 max-w-[36em] text-[15.5px] text-ink-2">
                  Deposit your {MARKET}. Choose how much is for sale this week. If someone pays, you get USDG. If they
                  don&apos;t, you keep the stock.
                </p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="First stock" value={MARKET} />
              <Figure label="You get paid in" value="USDG" tone="usdg" />
              <Figure label="Our fee" value="5%" />
              <Figure label="Cap" value="20" unit={MARKET} />
            </dl>
            <div className="flex flex-wrap gap-3 border-t border-line pt-5">
              <Button href={ACCOUNT_HREF}>Put {MARKET} in</Button>
              <Button variant="ghost" href={BOOK_HREF}>
                Buy this week
              </Button>
            </div>
          </Card>

          <Card className="grid content-start gap-4 border-dashed">
            <Chip>Next</Chip>
            <h2 className="text-[22px] font-extrabold tracking-[-0.02em] text-ink-2">More stocks</h2>
            <p className="text-[15.5px] text-ink-2">
              Additional Stock Token books, one underlying each, after {MARKET} and the audit report is public. We
              will not name the next ticker until that book is being built.
            </p>
            <p className="text-[13.5px] text-ink-3">
              Same design: your lots, your premium, your assignment. No basket, no points.
            </p>
          </Card>
        </div>

        <div>
          <SectionHead
            id="roadmap-h"
            eyebrow="Roadmap"
            title="Where Stonkhouse is going."
            intro="Product steps, not a return. Nothing here is a date, a ticker we have not started, or a figure for a week that has not closed."
          />
          <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ROADMAP.map((step) => (
              <li
                key={step.title}
                className={
                  step.current
                    ? "rounded-lg border border-accent/30 bg-accent-soft p-5"
                    : "rounded-lg border border-line bg-surface p-5"
                }
              >
                <p className="text-[12.5px] font-bold uppercase tracking-[0.1em] text-accent-text">{step.when}</p>
                <h3 className="mt-3 text-[17px] font-bold tracking-[-0.015em]">{step.title}</h3>
                <p className="mt-2 text-[14.5px] text-ink-2">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>

        <p className="text-[13.5px] text-ink-3">
          How a week runs, the policy limits and the risks are on{" "}
          <Link href="/docs" className="link">
            Docs
          </Link>{" "}
          and on{" "}
          <ExternalLink href={`${SITE_URL}/how-it-works`} className="link">
            stonkhouse.fun
          </ExternalLink>
          .
        </p>
      </div>
    </>
  );
}
