/**
 * app.stonkhouse.fun/ — the app home. 1-lot covered calls, not a pooled vault.
 *
 * One card per LIVE market (lib/markets.ts MARKETS, compiled in from the registry), each linking to
 * its account page and its book, and a "Next" card when planned markets remain,
 * grouped by rollout wave. Superseded markets are not listed; nothing here names a ticker.
 * A market moves from the second card to the first by turning live in ops/markets/tier1.json,
 * gen:markets and a rebuild. The old pooled vault is closed; collect a queued redemption on /collect.
 *
 * Copy discipline (scripts/copy-lint.mjs): what a market IS and where it is, never what it might
 * pay. "Planned" is a statement about a registry row, not a promise of a date.
 *
 * Status matches stonkhouse.fun: beta, pending audit.
 */
import Link from "next/link";

import { Button, Card, Chip, ExternalLink, Figure, Notice, PageHead, SectionHead } from "@/components/ui";
import { addressUrl } from "@/lib/chain";
import { DEFAULT_MARKET, MARKETS, marketHref, plannedByWave, type MarketWave } from "@/lib/markets";
import { SITE_URL, STATUS } from "@/lib/site";

/**
 * How each wave is labelled on the "Next" card. Rollout order, no dates. The card lists the
 * markets that are NOT live (plannedByWave), so a row whose wave is "live" can only be there
 * because its status is not: it is a paused market, and "Live" as its heading would be the one
 * wrong word on the page.
 */
const WAVE_LABEL: Record<MarketWave, string> = {
  live: "Paused",
  canary: "Next",
  wave1: "Then",
  wave2: "Later",
};

export default function HomePage() {
  const planned = plannedByWave();
  const plannedCount = planned.reduce((n, group) => n + group.markets.length, 0);
  const tickers = MARKETS.map((m) => m.ticker);
  const liveLine =
    tickers.length === 1 ? tickers[0] : tickers.length === 2 ? tickers.join(" and ") : `${tickers.length} stocks`;

  return (
    <>
      <PageHead
        eyebrow="Robinhood Chain"
        title={
          <>
            Let your stonks work for you. <span className="text-accent-text">{liveLine} now.</span>
          </>
        }
        lede={
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              <Chip tone="accent" dot>
                {STATUS.phase}
              </Chip>
            </div>
            <p>
              Put your Stock Tokens in. Each week someone can pay you for the chance to buy them at a set price. If they
              don&apos;t, you keep the stock. Only the amount you offer can be sold.
            </p>
          </>
        }
        aside={
          <Button href={marketHref(DEFAULT_MARKET.ticker, "account")} className="max-sm:w-full">
            Open your account
          </Button>
        }
      />

      <Notice tone="warn" className="mb-6 lg:[&>div]:max-w-[88ch]">
        Premium is paid only if a buyer fills. Assignment can take the collateral at the strike. Stock Tokens are debt
        securities, not shares in the underlying company.
      </Notice>

      <div className="grid gap-4 sm:gap-5">
        <div>
          <SectionHead id="live-h" eyebrow="Live" title={MARKETS.length === 1 ? "One market." : `${MARKETS.length} markets.`} className="mb-5" />
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {MARKETS.map((m) => (
              <li key={m.ticker}>
                <Card lift className="grid h-full gap-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <Chip tone="accent" dot>
                        Live
                      </Chip>
                      <h2 className="mt-3 text-[26px] font-extrabold tracking-[-0.02em]">{m.ticker}</h2>
                      <p className="mt-1 text-[13.5px] text-ink-3">{m.name}</p>
                      <p className="mt-2 max-w-[36em] text-[15.5px] text-ink-2">
                        Deposit your {m.ticker}. Choose how much is for sale this week. If someone pays, you get USDG. If they
                        don&apos;t, you keep the stock.
                      </p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Figure label="Stock" value={m.ticker} />
                    <Figure label="You get paid in" value="USDG" tone="usdg" />
                    <Figure label="Our fee" value="5%" />
                  </dl>
                  <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
                    <Button href={marketHref(m.ticker, "account")}>Put {m.ticker} in</Button>
                    <Button variant="ghost" href={marketHref(m.ticker, "book")}>
                      Buy this week
                    </Button>
                    <ExternalLink href={addressUrl(m.factory)} arrow className="link ml-auto text-[13px] text-ink-3">
                      factory
                    </ExternalLink>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </div>

        {planned.length > 0 ? (
          <Card className="grid content-start gap-4 border-dashed">
          <div className="flex flex-wrap items-center gap-2">
            <Chip>Next</Chip>
            <span className="text-[13px] text-ink-3">
              {plannedCount} more {plannedCount === 1 ? "stock" : "stocks"} in the registry, not open yet.
            </span>
          </div>
          <h2 className="text-[22px] font-extrabold tracking-[-0.02em] text-ink-2">More stocks, in this order.</h2>
          <p className="text-[15.5px] text-ink-2">
            Each one opens when its own factory is deployed and configured. Until then its page does not exist and
            nothing of it is for sale. Same design for every market: one account per wallet, one lot per offer, USDG
            in, no basket, no points.
          </p>
          <dl className="grid gap-3">
            {planned.map((group) => (
              <div key={group.wave} className="grid gap-1.5">
                <dt className="text-[12.5px] font-bold uppercase tracking-[0.1em] text-ink-3">{WAVE_LABEL[group.wave]}</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {group.markets.map((m) => (
                    <Chip key={m.ticker} title={m.name}>
                      {m.ticker}
                    </Chip>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
          </Card>
        ) : null}

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
