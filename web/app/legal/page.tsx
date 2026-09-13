/**
 * Compliance surface, not marketing. The disclosures this page is required to carry — the
 * US-person perimeter and the legal form of the Stock Token — are enforced verbatim by
 * scripts/copy-lint.mjs, which fails CI if the wording drifts. Treat every sentence here as
 * legal text: do not reword, soften, or tidy up phrasing without running that script first.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { MARKET, SHARE_TICKER } from "@/lib/contracts";
import { TERMS_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Legal — Callhouse",
  description:
    "Geographic restrictions and the legal form of Robinhood Chain Stock Tokens used as collateral.",
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
          Access is restricted by the{" "}
          <a href={TERMS_URL} target="_blank" rel="noreferrer noopener">
            Terms of Use ↗
          </a>
          , not by a technical control. You are responsible for your own eligibility, and for any
          tax or reporting consequence of using this interface.
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
          it is lifted. No Callhouse contract can override that.
        </li>
        <li>
          Corporate actions — splits, dividend adjustments — are expressed through an ERC-8056
          display multiplier rather than by rebasing balances. This interface shows the adjusted
          figure clearly labelled as display-only; all vault accounting uses raw balances.
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
          <Link href="/docs">The docs page</Link> carries the full risk list.
        </li>
      </ul>

      <h2>No advice, no guarantee</h2>
      <ul className="tight">
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
          <Link href="/activity">the activity page</Link>, describe what has already happened and say
          nothing about what any future week will do.
        </li>
      </ul>

      <h2>No affiliation</h2>
      <p>
        Callhouse is an independent project. It is not affiliated with, endorsed by, or operated by
        Robinhood Markets, Inc., Robinhood Assets (Jersey) Limited, Overcall, Valorem, or the issuers
        of USDG or Seaport. Those names appear here only to identify the third-party contracts and
        services this vault interacts with.
      </p>
    </div>
  );
}
