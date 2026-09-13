/**
 * callhouse.xyz/ — the landing page, and the first thing a stranger reads about this product.
 *
 * One job: leave a reader who skims only the first screen with an ACCURATE expectation. That
 * expectation is not a number, it is a shape — the vault writes one call a week against pooled
 * collateral, the premium arrives only if somebody buys the call, and on a thin book the most
 * likely week is the one that pays nothing. The hero says that in words, the first figure on the
 * page says it as a zero, and the outcomes card says it again with the unfilled week listed
 * first. If a future edit moves that below the fold, the edit is wrong.
 *
 * DELIBERATELY ABSENT:
 *   - Wallet code of any kind. No wagmi, no viem, no query client, no connect button. This is a
 *     server component with no "use client", no hooks and no fetch; it renders identically with
 *     JavaScript switched off, which is the whole reason site/ is a separate package from web/.
 *   - Live data. The vault is not deployed. A chain read here would render zeros, and a zero that
 *     really means "not deployed yet" is a lie told in a number. The notice below the hero says
 *     so in words instead.
 *   - Any forward-looking figure, and any figure scaled past one week. Every number on this page
 *     is a fixed policy parameter from README "Policy (launch)" or a protocol constant.
 *     scripts/copy-lint.mjs fails CI on the vocabulary; this file avoids the shape as well, and
 *     therefore needs no `copy-lint-allow` escape hatch anywhere in it. Do not add one: the
 *     escape hatch has to sit on the same physical line as the phrase, so any later reformat of
 *     this file would silently break the build.
 *   - The full policy table, the fee table, the phase machine and the addresses table. All four
 *     live on /how-it-works, which owns them. Repeating them here would push the material a
 *     depositor actually needs below three screens of reference data.
 *
 * Three phrases are required verbatim on this route by scripts/copy-lint.mjs. They are written
 * into the sentences that carry the argument — the hero, the assignment card and the pre-deposit
 * list — and not parked in a disclaimer block, because a disclaimer is the part nobody reads:
 *   "Premium is paid only if a buyer fills"
 *   "Assignment can take the collateral at the strike"
 *   "Stock Tokens are debt securities"
 * Reword those sentences only with `node scripts/copy-lint.mjs` open.
 *
 * Every "go do something" link leaves for app.callhouse.xyz through appUrl(). A relative href on
 * this domain is a 404, not a route into the dapp.
 */
import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  APP_URL,
  CHAIN_ID,
  CHAIN_NAME,
  MARKET,
  SHARE_TICKER,
  VENUE_NAME,
  VENUE_URL,
  appUrl,
} from "@/lib/site";

const DESCRIPTION =
  "Deposit one tokenised stock, receive vault shares. Each week a keeper writes one Overcall call per whole token and lists it for USDG. Premium is paid only if a buyer fills, and a week with no buyer pays zero.";

/**
 * `title.absolute` and not a bare string: the layout carries a "%s — Callhouse" template, so a
 * plain `title` here would render "Callhouse — … — Callhouse". The landing is the one route whose
 * title is the full positioning line rather than a route name.
 */
export const metadata: Metadata = {
  title: { absolute: `Callhouse — pooled covered calls on ${MARKET} Stock Tokens` },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: `Callhouse — pooled covered calls on ${MARKET} Stock Tokens`,
    description: DESCRIPTION,
    url: "/",
    siteName: "Callhouse",
    type: "website",
  },
};

/**
 * `.card + .card` is a vertical-stack rule: 16px between two cards that follow one another down
 * the page. Inside a `.grid` the grid's own gap already does that, and the inherited margin drops
 * every card except the first out of line with its row. Cancelling it per element is cheaper than
 * adding a selector to a stylesheet that has to stay byte-compatible with the dapp's. Same
 * constant, same reason, as site/app/how-it-works/page.tsx.
 */
const IN_GRID: CSSProperties = { marginTop: 0 };

/**
 * The bounds a depositor is trusting, from README "Policy (launch)". Shown here as five rows
 * rather than the full nine-row table because the point of this card is "the limits are in the
 * bytecode, not in a dashboard", and five rows make that point. /how-it-works has the table.
 */
const LIMITS: ReadonlyArray<readonly [string, string]> = [
  ["Strike band", "3% to 12% above spot"],
  ["Will not list below", "0.40% of spot / week"],
  ["Collateral written", "at most 95% of idle"],
  ["Listings signed per cycle", "at most 3"],
  ["Deposit cap at launch", `20–50 ${MARKET}`],
];

export default function HomePage() {
  return (
    <>
      <header className="hero">
        <div className="kicker">
          {CHAIN_NAME} {CHAIN_ID} · {VENUE_NAME} · Valorem Clear · Seaport 1.6
        </div>
        <h1>One call a week, written against pooled {MARKET} Stock Tokens.</h1>
        <p className="lede">
          Deposit one tokenised stock, receive {SHARE_TICKER} shares. Each week a keeper writes an{" "}
          {VENUE_NAME} call against the idle collateral and lists it for USDG.{" "}
          <strong>Premium is paid only if a buyer fills</strong> the listing. A week with no buyer
          pays zero, and on a book this thin that is the most likely outcome — published as a row
          like any other week, not hidden as an error state.
        </p>

        <div className="cta">
          <a
            className="btn ext"
            data-variant="primary"
            href={appUrl("/vault/nvda")}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open the app
          </a>
          <Link className="btn" data-variant="ghost" href="/how-it-works">
            Read the mechanics first
          </Link>
          <Link className="btn" data-variant="ghost" href="/risks">
            What can go wrong
          </Link>
        </div>
      </header>

      {/* `.stack` supplies the 16px between every block below. `.card + .card` would cover the
          cards but not the notice or the closing call-to-action row, and structural margins do
          not belong in inline style objects. */}
      <div className="stack">
        {/* Said once, out loud, instead of rendering zeros a reader would price in. */}
        <div className="notice" data-tone="info">
          <strong>The vault is not deployed yet.</strong>
          Nothing on this domain is live data and this site makes no chain reads. Every figure
          below is a fixed policy parameter, and no number on this page is scaled past one week.
          Realized weeks — including the unfilled ones — are published in the app once there are
          any.
        </div>

        <div className="card">
          <div className="grid grid-3">
            <div className="lead-stat">
              <span className="v">0</span>
              <span className="k">paid in a week nobody buys</span>
            </div>
            <div className="lead-stat">
              <span className="v">1.0000</span>
              <span className="k">{MARKET} locked per contract</span>
            </div>
            <div className="lead-stat">
              <span className="v">20–50</span>
              <span className="k">{MARKET} deposit cap at launch</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="card-title">What happens to your token in one week</h2>
            <span className="badge">
              <span className="dot" />
              Cycle → expiry
            </span>
          </div>

          <p className="small muted">
            The keeper binds to {VENUE_NAME}&apos;s registry cycle, not to a wall clock. One pass,
            every week, in this order.
          </p>

          <ol className="steps">
            <li className="step">
              <strong>You deposit.</strong> {MARKET} Stock Tokens in, {SHARE_TICKER} shares out,
              pro rata. While the vault is idle you can withdraw immediately.
            </li>
            <li className="step">
              <strong>The vault writes.</strong> When the registry opens a cycle, idle collateral
              is locked in Valorem Clear and one call is written per whole token, at the nearest
              strike rung inside the out-of-the-money band. If no rung qualifies, nothing is
              written and the collateral sits for the week.
            </li>
            <li className="step">
              <strong>The call is listed for USDG</strong> on Seaport, with the vault as the
              offerer. The book closes Friday 20:00 UTC. Until then a buyer may take it, or may
              not.
            </li>
            <li className="step">
              <strong>Saturday 20:00 UTC, the call expires.</strong> It was never bought, or was
              bought and expired worthless, or was bought and exercised. Those are the only three
              endings, and they are unpacked below.
            </li>
            <li className="step">
              <strong>Harvest.</strong> Whatever USDG arrived is collected: 5% of the premium to
              the fee Safe, the rest, including any strike proceeds in full, claimable pro rata by
              share. A withdrawal requested while the call was open settles here, not before.
            </li>
          </ol>
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="card-title">How the week ends</h2>
          </div>
          <p className="small muted">
            Three endings. Which one you get is decided by the order book and by where the stock
            closes, not by anything the vault does.
          </p>

          <div className="grid grid-3">
            <div className="card" style={IN_GRID}>
              <div className="card-head">
                <h3 className="card-title">Nobody bought</h3>
                <span className="badge" data-tone="warn">
                  Most likely
                </span>
              </div>
              <p className="small" style={{ marginBottom: 0 }}>
                There is no dealer obliged to take the other side. The listing sat on a thin book
                and nobody filled it, so the week pays zero USDG. Nobody owns the call, so nothing
                can be assigned: the collateral comes straight back out of Valorem at expiry.
              </p>
            </div>

            <div className="card" style={IN_GRID}>
              <div className="card-head">
                <h3 className="card-title">Bought, expired worthless</h3>
                <span className="badge" data-tone="good">
                  Premium kept
                </span>
              </div>
              <p className="small" style={{ marginBottom: 0 }}>
                A buyer paid. The vault was credited 95% of the premium and {VENUE_NAME} took 5%
                inside the order itself. Spot finished under the strike, so the collateral was
                never touched and the USDG is claimable after the protocol fee.
              </p>
            </div>

            <div className="card" style={IN_GRID}>
              <div className="card-head">
                <h3 className="card-title">Bought and exercised</h3>
                <span className="badge" data-tone="bad">
                  Assigned
                </span>
              </div>
              <p className="small" style={{ marginBottom: 0 }}>
                Assignment can take the collateral at the strike. You keep the premium and those
                tokens come back as strike USDG instead, with no protocol fee taken from it; the
                upside above the strike is gone for that week. Valorem assigns by bucket, so a week can be assigned in part, and v1
                does not buy the tokens back.
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="card-title">Where the money goes</h2>
          </div>

          <div className="flow">
            <div className="flow-node">
              <strong>Your {MARKET} Stock Tokens</strong>
              <div className="tiny faint">in; {SHARE_TICKER} shares out</div>
            </div>
            <div className="flow-arrow" aria-hidden="true" />
            <div className="flow-node">
              <strong>Valorem Clear</strong>
              <div className="tiny faint">collateral locked, one call per whole token</div>
            </div>
            <div className="flow-arrow" aria-hidden="true" />
            <div className="flow-node">
              <strong>Seaport 1.6</strong>
              <div className="tiny faint">the call listed for USDG, vault as offerer</div>
            </div>
            <div className="flow-arrow" aria-hidden="true" />
            <div className="flow-node">
              <strong>A buyer, or nobody</strong>
              <div className="tiny faint">a fill pays 95% to the vault, 5% to {VENUE_NAME}</div>
            </div>
            <div className="flow-arrow" aria-hidden="true" />
            <div className="flow-node">
              <strong>Saturday settlement</strong>
              <div className="tiny faint">collateral or strike back · 5% fee on premium, the rest per share</div>
            </div>
          </div>

          <hr className="hr" />

          <p className="small muted" style={{ marginBottom: 0 }}>
            Cut the path at Seaport and you have the other week: nobody fills, the premium is zero,
            and Valorem hands the collateral back whole at expiry. Settlement never reads a price
            feed — whether the vault was assigned is decided by what the option holder did, and the
            Chainlink feed is display and a gate on writing, nothing more. The protocol fee is
            5% of the premium and nothing else: strike proceeds from an assignment carry no fee,
            and a week that pays nothing costs nothing.
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="card-title">The limits are compiled in</h2>
            <span className="badge">On chain</span>
          </div>
          <p className="small muted">
            These are contract bounds, not intentions. An admin can move a knob inside them and
            cannot move them, so nobody can quietly start selling at-the-money calls against your
            collateral.
          </p>

          <div className="rows">
            {LIMITS.map(([k, v]) => (
              <div className="row" key={k}>
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>

          <hr className="hr" />

          <p className="small muted" style={{ marginBottom: 0 }}>
            The keeper opens the week, signs the listing and closes the week. It never holds the
            option tokens and can never move funds. A Guardian can halt writes and cancel listings
            and nothing else; neither role can block an idle withdrawal or the close of a week. The
            full policy table, the fees, the phase machine and every contract address are on{" "}
            <Link href="/how-it-works">how it works</Link>. The venue is{" "}
            <a className="ext" href={VENUE_URL} target="_blank" rel="noreferrer noopener">
              {VENUE_NAME}
            </a>
            , a third party — Callhouse is not an options exchange and runs no book of its own.
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="card-title">Before you deposit</h2>
          </div>
          <ul className="tight" style={{ marginBottom: 0 }}>
            <li>
              <strong>Stock Tokens are debt securities</strong> issued by Robinhood Assets (Jersey)
              Limited. Not shares: no vote, no claim on the company, and the issuer&apos;s credit
              risk is yours. The issuer can freeze transfers and the token can pause its own price
              oracle, either of which can stop this vault writing or settling.{" "}
              <Link href="/legal">The legal page</Link> has the full form.
            </li>
            <li>
              <strong>Not available to US persons.</strong> The same perimeter applies here as to
              the Stock Tokens themselves. Nothing on this site is an offer or investment advice.
            </li>
            <li>
              <strong>The contracts in this repository have not been audited.</strong> Valorem
              Clear was audited by Zellic under its former name; this vault was not. There is no
              proxy, so a fix means a v2 and a migration. The 20–50 {MARKET} cap is the honest
              measure of how much confidence that deserves.
            </li>
            <li>
              <strong>There is no protocol token</strong>, no points programme and no airdrop at
              launch. Depositing early accrues nothing but the USDG a buyer actually paid.
            </li>
            <li>
              An empty book, assignment, partial assignment, an issuer freeze, the Valorem fee
              switch and an outage into the Friday window are each written out on{" "}
              <Link href="/risks">the risks page</Link>. Read it before the app.
            </li>
          </ul>
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="card-title">One action</h2>
          </div>
          <p className="small muted">
            Depositing, withdrawing, this week&apos;s strike and every published week live in the
            app at <span className="mono">{APP_URL.replace(/^https?:\/\//, "")}</span>. This domain
            never asks for a wallet.
          </p>
          <div className="cta">
            <a
              className="btn ext"
              data-variant="primary"
              href={appUrl("/vault/nvda")}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open the app
            </a>
            <a
              className="btn ext"
              data-variant="ghost"
              href={appUrl("/activity")}
              target="_blank"
              rel="noreferrer noopener"
            >
              Every published week, including the zeros
            </a>
            <Link className="btn" data-variant="ghost" href="/legal">
              Legal
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
