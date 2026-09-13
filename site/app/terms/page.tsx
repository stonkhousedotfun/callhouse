/**
 * /terms — Terms of Use for both domains. A DRAFT, and it says so at the top and the bottom.
 *
 * WHY THIS PAGE EXISTS: /legal says access is restricted by the Terms of Use rather than by a
 * technical control, and until 2026-09-12 there was no such document. A restriction that points
 * at nothing is not a restriction. This page is the thing that sentence points at, on the
 * indexed domain, canonical here and linked from app.callhouse.xyz rather than duplicated there.
 *
 * WHAT IT IS NOT: adopted terms. No operating entity has been designated, no governing law has
 * been chosen and no counsel has reviewed this text. The page renders those gaps in plain words
 * from lib/legal.ts instead of hiding them behind a placeholder, and shows a warn notice while
 * operatorIsDesignated() is false. ops/launch-legal.md is the list of decisions that closes it.
 *
 * The eligibility section is copied VERBATIM from app/legal/page.tsx, because the terms cannot
 * describe the perimeter differently from the page that announces it. "not available to US
 * persons" on this page is a literal match required by scripts/copy-lint.mjs, as is "Draft"; if
 * either is reworded the build fails. Keep this page and /legal in the same commit when the
 * perimeter wording changes.
 *
 * DELIBERATELY ABSENT: an "I accept" control (there is no account to attach acceptance to and a
 * checkbox would imply a gate that does not exist — whether use-based acceptance is defensible
 * for this perimeter is a counsel question, listed in ops/launch-legal.md), clause numbering
 * (the sections are not cross-referenced, so numbers would be decoration), a geoblock, and any
 * sentence that promises an outcome. Nothing here is legal advice.
 */
import type { Metadata } from "next";
import Link from "next/link";

import {
  GOVERNING_LAW,
  LEGAL_CONTACT_EMAIL,
  LEGAL_DOCS_ARE_DRAFT,
  LEGAL_DOCS_VERSION,
  NOT_YET_DESIGNATED,
  OPERATOR_GAP_NOTICE,
  OPERATOR_JURISDICTION,
  OPERATOR_LEGAL_NAME,
  operatorIsDesignated,
} from "@/lib/legal";
import { MARKET, SHARE_TICKER, VENUE_NAME, VENUE_URL, appUrl } from "@/lib/site";

// The draft sentence is appended from the same flag the in-page marker reads, so the search
// snippet and the page stop saying "draft" in the same build rather than one lagging the other.
export const metadata: Metadata = {
  title: "Terms of Use",
  description:
    "Terms of Use for callhouse.xyz and app.callhouse.xyz: who may use the interface, what it is, and what it does not promise." +
    (LEGAL_DOCS_ARE_DRAFT ? " Draft, pending review by counsel." : ""),
  alternates: { canonical: "/terms" },
};

/** The marker the page carries at the top and the bottom while LEGAL_DOCS_ARE_DRAFT. */
function DraftMarker() {
  if (!LEGAL_DOCS_ARE_DRAFT) return null;
  return (
    <p className="muted">
      <strong>Draft — pending review by counsel.</strong> Version {LEGAL_DOCS_VERSION}.
    </p>
  );
}

export default function TermsPage() {
  const designated = operatorIsDesignated();

  return (
    <div className="prose">
      <div className="page-head">
        <div className="eyebrow">Terms of Use</div>
        <h1>Terms of Use for this interface</h1>
      </div>

      <DraftMarker />

      {designated ? null : (
        <div className="notice" data-tone="warn">
          <strong>Not yet adopted.</strong>
          {OPERATOR_GAP_NOTICE}
        </div>
      )}

      <p>
        These terms cover callhouse.xyz and app.callhouse.xyz (together, &ldquo;the
        interface&rdquo;). Using either domain is use under these terms. If you do not agree with
        them, do not use the interface. The smart contracts the interface points at are on a public
        chain and are not governed by these terms; nothing here can change what they do.
      </p>

      {/* Copied verbatim from app/legal/page.tsx. The two phrases in bold are required, literally,
          by scripts/copy-lint.mjs. Do not reword here without rewording there. */}
      <h2>Who may use this</h2>
      <div className="notice" data-tone="bad">
        <strong>This interface is not available to US persons.</strong>
        The same perimeter applies as to the underlying Stock Tokens. If you are a US person, or you
        are accessing this from a jurisdiction where these instruments are not offered, do not use
        this interface.
      </div>
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
          Access is restricted by these terms, not by a technical control. You are responsible for
          your own eligibility, and for any tax or reporting consequence of using this interface.
        </li>
        <li>
          No know-your-customer process is run here, and none is implied. This is a permissionless
          smart contract on a public chain.
        </li>
      </ul>

      <h2>What this interface is</h2>
      <ul className="tight">
        <li>
          A front-end to public smart contracts on Robinhood Chain. It builds transactions; your
          wallet signs them; the chain executes them. The interface never holds a key and never
          holds a token.
        </li>
        <li>
          There is no custody. {MARKET} Stock Tokens you deposit are held by the vault contract and,
          during a written week, by the Valorem clearinghouse. The vault has no upgrade path and no
          function that moves a depositor&apos;s tokens anywhere but back to the depositor or into
          the written call; the Admin Safe can change policy inside compiled-in caps and cannot
          move a token.
        </li>
        <li>
          There is no account. Nothing is registered, no password exists, and no know-your-customer
          check is run. Your wallet address is the only identity the interface sees, and it is
          public chain data.
        </li>
        <li>
          The same contracts are reachable without this interface, from any tool that can send a
          transaction. Withdrawing does not depend on this site staying up.
        </li>
      </ul>

      <h2>No advice, no offer</h2>
      <p>
        Nothing on the interface is investment, legal, tax or accounting advice, and nothing here is
        an offer of securities or an invitation to buy or sell anything. Published weekly results
        describe what has already happened and say nothing about what any future week will do. The
        interface does not know your circumstances and does not try to.
      </p>

      <h2>Risks</h2>
      <p>
        Premium is paid only if a buyer fills the weekly listing; a week with no buyer pays nothing.
        Assignment can take the collateral at the strike. The collateral is a debt security whose
        issuer can freeze transfers, and the vault cannot override that. You can lose the collateral
        you deposit. <Link href="/risks">The risks page</Link> is the full list and is part of these
        terms by reference; read it before depositing.
      </p>

      <h2>Smart-contract and third-party risk</h2>
      <ul className="tight">
        <li>
          The Callhouse contracts have not been audited. They are published under the MIT licence,
          as-is, and there is no upgrade path: a bug means a new vault and a migration, not a patch.
        </li>
        <li>
          <a className="ext" href={VENUE_URL} target="_blank" rel="noreferrer noopener">
            {VENUE_NAME}
          </a>
          , Valorem Clear, Seaport, the {MARKET} Stock Token, USDG and the RPC providers are third
          parties. None of them is operated by, or answerable to, the people who publish this
          interface. Their contracts can be paused or upgraded by their own admin keys, and the
          Stock Token issuer can freeze transfers or pause its oracle. When any of them stops, this
          vault stops with it.
        </li>
        <li>
          The weekly cycle is set by a third-party registry key. A hostile or mistaken cycle is
          bounded by the vault&apos;s compiled-in checks to a skipped week, and no better than that.
        </li>
      </ul>

      <h2>No warranty</h2>
      <p>
        The interface and the contracts it points at are provided as-is and as-available, with no
        warranty of any kind, express or implied, including of merchantability, fitness for a
        purpose, accuracy, or uninterrupted operation. Figures shown on app.callhouse.xyz are read
        from the chain or from an indexer and may lag or be wrong; the chain is the record, not the
        page.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the extent the applicable law allows, the people who publish this interface are not
        liable for any loss arising from its use or from the contracts it points at, including lost
        collateral, lost premium, assignment, a frozen token, a failed third party, an error on the
        page, or downtime. Where that exclusion is not permitted, liability is limited to the
        smallest amount the law allows. Nothing here excludes liability that cannot lawfully be
        excluded.
      </p>

      <h2>Changes</h2>
      <p>
        These terms are versioned. The version in force is <code>{LEGAL_DOCS_VERSION}</code>, shown
        at the top of this page. A change is a new version and a new date; there is no other notice.
        Continuing to use the interface after a change is use under the new version.
      </p>

      <h2>Governing law</h2>
      <p>
        {GOVERNING_LAW ? (
          <>These terms are governed by {GOVERNING_LAW}.</>
        ) : (
          <>
            Governing law: <strong>{NOT_YET_DESIGNATED}</strong>. No law and no forum has been
            chosen for these terms. That is a decision counsel has not yet made, and this page will
            say which when it has.
          </>
        )}
      </p>

      <h2>Contact</h2>
      <p>
        {OPERATOR_LEGAL_NAME ? (
          <>
            These terms are published by {OPERATOR_LEGAL_NAME}
            {OPERATOR_JURISDICTION ? <> ({OPERATOR_JURISDICTION})</> : null}.{" "}
          </>
        ) : (
          <>
            Operating entity: <strong>{NOT_YET_DESIGNATED}</strong>.{" "}
          </>
        )}
        {LEGAL_CONTACT_EMAIL ? (
          <>
            Notices about these terms go to{" "}
            <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
          </>
        ) : (
          <>
            Legal contact: <strong>{NOT_YET_DESIGNATED}</strong>. There is no address for notices
            about these terms yet.
          </>
        )}
      </p>
      <p>
        The privacy notice is at <Link href="/privacy">/privacy</Link>, the perimeter and the legal
        form of the collateral are at <Link href="/legal">/legal</Link>, and {SHARE_TICKER} itself
        lives at{" "}
        <a className="ext" href={appUrl("/vault/nvda")} target="_blank" rel="noreferrer noopener">
          app.callhouse.xyz
        </a>
        .
      </p>

      <DraftMarker />
    </div>
  );
}
