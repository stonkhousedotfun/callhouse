/**
 * Compliance surface, not marketing. Nothing on this page sells anything, and the register is
 * legal text rather than the plain-but-warm voice of the landing.
 *
 * This is the CANONICAL copy of the disclosures. app.callhouse.xyz is noindex; callhouse.xyz is
 * the indexed domain, so this is the version a stranger, a search engine or a regulator reads
 * first. The two disclosures it is required to carry — the US-person perimeter and the legal
 * form of the Stock Token — are enforced verbatim by scripts/copy-lint.mjs, which fails CI if
 * the wording drifts. Do not reword, soften or tidy up a sentence here without running that
 * script; "not available to US persons" and "Robinhood Assets (Jersey) Limited" are literal
 * string matches, not sentiments.
 *
 * It mirrors web/app/legal/page.tsx and MUST STAY IN SYNC WITH IT. A change to one is a change
 * to both, in the same commit — two domains carrying two different versions of the same
 * disclosure is worse than either version on its own. The only permitted divergence is
 * cross-links: /activity is a dapp route and is reached with appUrl(), while the risk list and
 * the mechanics are pages on this domain.
 *
 * DELIBERATELY ABSENT: no wallet, no chain read, no "I accept" button, no geo gate and no
 * cookie banner. Access is restricted by the Terms of Use at /terms and not by a technical
 * control, which the page says outright and links; shipping a checkbox here would imply a
 * perimeter that does not exist. Whether use-based acceptance is defensible for this perimeter
 * is a counsel question, tracked in ops/launch-legal.md.
 *
 * The "Reporting a vulnerability" section at the bottom is the `Policy:` target of
 * /.well-known/security.txt (app/.well-known/security.txt/route.ts) and SECURITY.md §6 points
 * here too. It renders the security contact from lib/legal.ts or says there is none yet; it
 * does not invent one. This section has no twin on web/app/legal/page.tsx — the disclosure
 * address belongs on the indexed domain, once.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { NOT_YET_DESIGNATED, SECURITY_CONTACT_EMAIL } from "@/lib/legal";
import { MARKET, SHARE_TICKER, appUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Legal",
  description:
    "Geographic restrictions and the legal form of Robinhood Chain Stock Tokens used as collateral.",
  alternates: { canonical: "/legal" },
};

export default function LegalPage() {
  return (
    <div className="prose">
      <div className="page-head">
        <div className="eyebrow">Legal</div>
        <h1>Who this is for, and what the collateral actually is</h1>
      </div>

      {/* The two phrases below are required, verbatim, by scripts/copy-lint.mjs.
          They come from README "Frontend copy" and are compliance text. Do not reword. */}
      <div className="notice" data-tone="bad">
        <strong>This interface is not available to US persons.</strong>
        The same perimeter applies as to the underlying Stock Tokens. If you are a US person, or you
        are accessing this from a jurisdiction where these instruments are not offered, do not use
        this interface.
      </div>

      <h2>Geographic restrictions</h2>
      <ul className="tight">
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
          Access is restricted by the <Link href="/terms">Terms of Use</Link>, not by a technical
          control. You are responsible for your own eligibility, and for any tax or reporting
          consequence of using this interface.
        </li>
        <li>
          No know-your-customer process is run here, and none is implied. This is a permissionless
          smart contract on a public chain.
        </li>
      </ul>

      <h2>What a Stock Token is</h2>
      <ul className="tight">
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
          The issuer can <strong>freeze or restrict transfers</strong>, and the token can pause its
          own price oracle. Either event can stop this vault writing, settling, or paying out until
          it is lifted. No contract in this repository can override that.
        </li>
        <li>
          Corporate actions — splits, dividend adjustments — are expressed through an ERC-8056
          display multiplier rather than by rebasing balances. The app shows the adjusted figure
          clearly labelled as display-only; all vault accounting uses raw balances.
        </li>
      </ul>

      <h2>What {SHARE_TICKER} is</h2>
      <ul className="tight">
        <li>
          {SHARE_TICKER} is a vault share. It represents a pro-rata claim on the {MARKET} Stock
          Tokens the vault holds, plus separately accrued USDG. It is not itself a Stock Token, not a
          deposit, and not a claim on Callhouse, Overcall, Valorem or any Robinhood entity.
        </li>
        <li>
          There is no protocol token, no points programme and no airdrop attached to this vault.
        </li>
        <li>
          Premium is paid only when a buyer fills the weekly listing. A week with no buyer pays
          nothing, and an exercised call takes collateral at the strike.{" "}
          <Link href="/risks">The risks page</Link> carries the full risk list, and{" "}
          <Link href="/how-it-works">how it works</Link> describes the cycle those outcomes come from.
        </li>
      </ul>

      <h2>No advice, no guarantee</h2>
      <ul className="tight">
        <li>
          Nothing on this site is investment, legal, tax or accounting advice, and nothing here is an
          offer of securities.
        </li>
        <li>
          The smart contracts in this repository have not been audited. They are provided as-is,
          under the MIT licence, with no warranty of any kind. You can lose the collateral you
          deposit.
        </li>
        <li>
          Past weekly results, including any published on{" "}
          <a className="ext" href={appUrl("/activity")} target="_blank" rel="noreferrer noopener">
            the activity page
          </a>
          , describe what has already happened and say nothing about what any future week will do.
        </li>
      </ul>

      <h2>No affiliation</h2>
      <p>
        Callhouse is an independent project. It is not affiliated with, endorsed by, or operated by
        Robinhood Markets, Inc., Robinhood Assets (Jersey) Limited, Overcall, Valorem, or the issuers
        of USDG or Seaport. Those names appear here only to identify the third-party contracts and
        services this vault interacts with.
      </p>

      <h2 id="reporting">Reporting a vulnerability</h2>
      <p>
        If you believe you have found a vulnerability in the contracts or either domain, do not
        post it publicly.{" "}
        {SECURITY_CONTACT_EMAIL ? (
          <>
            Send it to <a href={`mailto:${SECURITY_CONTACT_EMAIL}`}>{SECURITY_CONTACT_EMAIL}</a>.
            The same address is published, machine-readably, at{" "}
            <a href="/.well-known/security.txt">/.well-known/security.txt</a>.
          </>
        ) : (
          <>
            Disclosure address: <strong>{NOT_YET_DESIGNATED}</strong>. No mailbox for reports
            exists yet, and for that reason <code>/.well-known/security.txt</code> returns 404
            rather than a file with no contact line. Setting one is a launch step.
          </>
        )}{" "}
        A bug bounty with its own disclosure channel opens in the second week after mainnet
        launch. Until then the contracts are unaudited, and a report is a favour, not a claim.
      </p>
      <p>
        The <Link href="/terms">Terms of Use</Link> and the <Link href="/privacy">privacy notice</Link>{" "}
        are separate pages and are drafts pending review by counsel.
      </p>
    </div>
  );
}
