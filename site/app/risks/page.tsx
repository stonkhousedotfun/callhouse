/**
 * /risks — the unabridged failure list for callhouse.xyz.
 *
 * This page is a product feature, not a legal appendix. The pitch is that the bad weeks are
 * published, so the bad weeks are described here in the same register an engineer would use in
 * a postmortem: what the failure is, how often to expect it, what it costs the depositor, and
 * what the system actually does about it — which for several of these is nothing, and the page
 * says so rather than inventing a mitigation.
 *
 * Sources, in order of authority: SECURITY.md (threat model, the keys table, the accepted
 * risks), the root README ("Risks (short)", the policy table, the phase machine) and the dapp's
 * own /docs risk section. Where this page and those disagree, this page is the one that is wrong.
 *
 * DELIBERATELY ABSENT:
 *   - Any number that is not a fixed policy parameter. No live state, no fetch, no chain read;
 *     the vault is not deployed and a zero rendered next to a risk would read as a measurement.
 *   - Any probability expressed as a percentage. "Most weeks" is an honest ordering of
 *     likelihood; "12% chance of assignment" would be a model we do not have.
 *   - Any reassurance the bytecode does not enforce. Every "what the system does" line below
 *     maps to a check in contracts/ or to an explicit "there is no mitigation".
 *   - Wallet code of any kind. Every link that does something is an absolute URL into
 *     app.callhouse.xyz, built with appUrl().
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import { MARKET, SHARE_TICKER, appUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Risks — Callhouse",
  description:
    "Every way a week here pays nothing, or costs you the collateral: no buyer, assignment, issuer freeze, unaudited contracts, a keeper that can stop.",
  alternates: { canonical: "/risks" },
  openGraph: {
    title: "Risks — Callhouse",
    description:
      "Every way a week here pays nothing, or costs you the collateral: no buyer, assignment, issuer freeze, unaudited contracts, a keeper that can stop.",
    url: "/risks",
    siteName: "Callhouse",
    type: "article",
  },
};

/** Badge tones, narrowed so a typo is a build error rather than an unstyled badge. */
type Tone = "good" | "warn" | "bad" | "info";

/**
 * One failure mode. The likelihood badge is a short ordering, never a probability, and the
 * `response` line is the last thing in the box on purpose: the honest answer is sometimes
 * "nothing", and it should be read after the cost rather than instead of it.
 */
function Risk({
  title,
  likelihood,
  tone,
  response,
  children,
}: {
  title: string;
  likelihood: string;
  tone: Tone;
  response: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">{title}</h3>
        <span className="badge" data-tone={tone}>
          <span className="dot" />
          {likelihood}
        </span>
      </div>
      {children}
      <hr className="hr" />
      <p className="small muted" style={{ marginBottom: 0 }}>
        <strong>What the system does.</strong> {response}
      </p>
    </section>
  );
}

/** A group of related failure modes. The note under the heading says why they are grouped. */
function Group({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 34 }}>
      <h2>{title}</h2>
      <p className="small muted" style={{ maxWidth: "72ch" }}>
        {note}
      </p>
      <div className="stack">{children}</div>
    </section>
  );
}

export default function RisksPage() {
  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Risks</div>
        <h1>Everything that can go wrong</h1>
        <p className="lede">
          The whole list, in the order you are likely to meet it. Most of these are not bugs and
          have no fix: they are the shape of writing covered calls against a tokenised security on
          a one-week clock.
        </p>
      </div>

      <div className="notice" data-tone="bad">
        <strong>You can lose the collateral you deposit.</strong>
        The contracts in this repository have not been audited, the token&apos;s issuer can freeze
        it, and a clearinghouse can take the collateral at the strike. Deposit accordingly.
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2 className="card-title">How to read this page</h2>
        </div>
        <p>
          Premium is paid only if a buyer fills the listing. That single sentence generates the
          first two entries below and most of the rest: the vault sells something once a week, and
          a sale can fail to happen, happen at a bad price, or happen and then be exercised
          against you.
        </p>
        <p>
          Every box carries what the failure is, how likely it is, what it costs you, and what the
          system does about it. Several say the system does nothing, because nothing is what it
          does — a vault cannot outvote an issuer or conjure a bidder.
        </p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Nothing on this page is live. The figures quoted are fixed policy parameters compiled
          into the contracts, not readings from a running vault. The weekly results live on{" "}
          <a className="ext" href={appUrl("/activity")} target="_blank" rel="noreferrer noopener">
            the activity page
          </a>
          .
        </p>
      </div>

      <Group
        title="The ordinary outcomes"
        note="Not edge cases. On any given week, one of these three is what happens."
      >
        <Risk
          title="No buyer"
          likelihood="Most weeks"
          tone="warn"
          response={
            <>
              Nothing, and there is nothing to do. An empty book is a market fact, not an error
              state, so it is published as a row reading &quot;unfilled, 0&quot; alongside the
              weeks that filled. The one thing that is defended is visibility: if Overcall&apos;s
              listings API rejects the order, the signed Seaport payload is published in the app so
              a buyer can fill it directly. An invisible listing is an unfilled week.
            </>
          }
        >
          <p>
            The keeper writes the call and lists it. If nobody lifts the offer before the book
            closes on Friday, the option expires unsold and the collateral comes back at Saturday
            expiry. This is the most likely outcome on a thin book, and the order book for weekly
            calls on a tokenised stock is thin.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> the week&apos;s premium, which is zero. Your collateral is
            not touched — it was locked in Valorem for the week and returns whole. The protocol fee
            is a share of the premium harvested, so an unfilled week also collects no fee. You lose
            the time, not the tokens.
          </p>
        </Risk>

        <Risk
          title="Assignment"
          likelihood="Any week spot runs"
          tone="warn"
          response={
            <>
              v1 does not buy the token back. That is v2, and it is not in this repository — an
              automated market buy is its own risk, and shipping one badly is worse than holding
              USDG. The vault does defend the accounting around assignment: deposits close at the
              cycle&apos;s exercise timestamp, whether or not the keeper is alive, so nobody can
              mint shares into a position whose collateral has already left.
            </>
          }
        >
          <p>
            Whoever bought the call may exercise it inside the exercise window. Valorem takes the
            collateral at the strike and leaves the strike proceeds in USDG, which are credited to
            depositors in full: the protocol fee is charged on premium, never on them. The strike
            is the nearest Overcall rung inside a 3–12% out-of-the-money band, so it takes a move,
            but not an enormous one.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> every cent of upside above the strike for that week, and
            the position itself. The vault can end the week underweight {MARKET}, holding USDG
            where it used to hold tokens. If {MARKET} gaps up and keeps going, you sold the move
            for a week&apos;s premium.
          </p>
        </Risk>

        <Risk
          title="Partial assignment"
          likelihood="Whenever assigned"
          tone="info"
          response={
            <>
              Nothing. Which contracts get assigned is the clearinghouse&apos;s decision, not the
              vault&apos;s, and there is no call that makes it fairer. The vault pools the result:
              every depositor gets the same blend, nobody is singled out for the assigned half.
            </>
          }
        >
          <p>
            Valorem assigns by bucket, not perfectly pro rata. The vault can be assigned on some of
            the contracts it wrote and not on others, so the usual outcome of an exercised week is
            a mixture rather than a clean swap.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> predictability. A redemption is never a promise of a fixed
            number of tokens — part of what comes back can be USDG at the strike, and the split is
            not known until the week closes.
          </p>
        </Risk>
      </Group>

      <Group
        title="Third parties who can stop the week"
        note="Four contracts and one API in this path belong to somebody else. None of them can be overridden from here."
      >
        <Risk
          title="Issuer freeze or oracle pause"
          likelihood="Rare, unmitigable"
          tone="bad"
          response={
            <>
              There is no technical mitigation, and pretending otherwise would be the dishonest
              part. That is the asset: a Stock Token is a claim on its issuer. What the contracts
              do guarantee is that a freeze never traps you procedurally — queueing a redemption
              and claiming USDG keep working while token transfers are stopped, and the vault
              refuses to write against a paused oracle rather than writing blind.
            </>
          }
        >
          <p>
            Stock Tokens are debt securities issued by Robinhood Assets (Jersey) Limited. Not
            shares: no vote, no claim on the underlying company, and issuer credit risk on that
            entity. The issuer can freeze or restrict transfers and can upgrade the token proxy;
            the token can pause its own price oracle. Either event stops writing and stops
            settlement.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> in the mild case, weeks of nothing while the vault sits
            unable to write or settle. In the severe case, the instrument itself — if the issuer
            fails, the token does not survive independently of it. See{" "}
            <Link href="/legal">the legal page</Link> for the full legal form.
          </p>
        </Risk>

        <Risk
          title="Valorem engine fee switch"
          likelihood="One key away"
          tone="info"
          response={
            <>
              The vault stops writing rather than writing at a loss. While the engine reports fees
              enabled and governance has not explicitly accepted them, opening a week reverts. Turning
              that acceptance on is an Admin Safe decision, taken in the open, not something a
              keeper can do on a Friday afternoon.
            </>
          }
        >
          <p>
            Valorem Clear can charge 15 bps of <em>notional</em>, levied on top of the collateral.
            It is off at Overcall launch, and the switch belongs to a third party. On a weekly
            out-of-the-money call that number is not small change: the policy floor for a listing
            is 0.40% of spot, so 15 bps of notional can be a large share of a good week and more
            than the whole of a thin one.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> nothing directly, because the vault refuses to write. The
            cost is weeks of zero until governance decides whether the fee is worth paying.
          </p>
        </Risk>

        <Risk
          title="Sequencer or listings API down"
          likelihood="Occasional"
          tone="warn"
          response={
            <>
              The keeper retries with backoff, and refuses to write at all if it cannot list —
              a written call with no listing is all of the risk and none of the premium, which is
              strictly worse than doing nothing. A stale oracle reading blocks writes for the same
              reason. Both failures resolve to a skipped week, which is the safe direction.
            </>
          }
        >
          <p>
            Robinhood Chain runs a centralised sequencer with no uptime feed, and an outage
            surfaces here as a stale price. Overcall&apos;s listings API is a third-party service
            that can reject or drop an order. Either one, in the hours before the book closes,
            means there is no live listing when buyers are looking.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> the week&apos;s premium. Same outcome as no buyer, arrived
            at for an operational reason instead of an economic one.
          </p>
        </Risk>
      </Group>

      <Group
        title="Code and keys"
        note="What a bug costs, what a stolen key buys, and what the humans with permissions can still do wrong."
      >
        <Risk
          title="Smart contract risk"
          likelihood="Unquantified"
          tone="bad"
          response={
            <>
              The deposit cap is the real statement of confidence: 20–50 {MARKET} at launch, not an
              open door. There is no proxy and no upgrade key, so a bug means a v2 and a migration
              announced in advance rather than a silent patch. An external audit is on the plan and
              has not happened.
            </>
          }
        >
          <p>
            <strong>The contracts in this repository have not been audited.</strong> An internal
            adversarial review across thirteen surfaces raised 72 findings, of which 51 survived
            refutation; all of those are fixed and carry regression tests. That is a review by the
            people who wrote the code. It is not an audit, and it does not substitute for one.
          </p>
          <p>
            Valorem Clear was audited by Zellic in 2022–2023 under its former name,
            OptionSettlementEngine. That audit covers Valorem. It says nothing about this vault.
            Seaport, USDG and the Stock Token are third-party code with their own upgrade keys,
            outside anyone&apos;s control here.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> in the worst case, all of it.
          </p>
        </Risk>

        <Risk
          title="Keeper stops running"
          likelihood="Expect it eventually"
          tone="info"
          response={
            <>
              A dead keeper cannot strand collateral past the week. The Guardian can close the week
              after expiry, and closing becomes permissionless an hour later, so anyone can settle
              the queue and release the collateral. Halting writes never blocks a redemption, a
              USDG claim, or the close of a week — it blocks exactly one thing, opening a new short.
            </>
          }
        >
          <p>
            The keeper is one hot key running a weekly state machine against a third-party cycle.
            It can crash, run out of gas money, or be looking the wrong way when the window opens.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> a skipped week if it dies before the write. Nothing, beyond
            delay, if it dies after.
          </p>
        </Risk>

        <Risk
          title="Keeper key compromise"
          likelihood="Low, and bounded"
          tone="info"
          response={
            <>
              No off-chain component can move money. The vault is the Valorem writer and the
              Seaport offerer, it authorises each listing by hash on chain, and it re-validates
              every field the keeper proposes against caps compiled into the bytecode: the
              out-of-the-money band, the premium floor, the utilisation ceiling, the contract cap,
              and a 21-day ceiling on cycle length. The Admin Safe can move those knobs inside the
              caps and never outside them.
            </>
          }
        >
          <p>
            Assume the keeper key is stolen outright. The attacker can propose a strike, a size and
            an order, and can cancel listings. Every one of those goes through a contract that
            checks the proposal before acting on it.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> a wasted week and some gas. A fully compromised keeper
            cannot take a token out of the vault.
          </p>
        </Risk>

        <Risk
          title="Admin judgment"
          likelihood="Bounded, not zero"
          tone="warn"
          response={
            <>
              The bounds are enforced on chain, which rules out the worst version — nobody can
              quietly sell at the money, set the protocol fee above 20% of premium, or take a fee
              from strike proceeds. It does not rule out bad settings inside them, and there is no
              timelock in v1. You are trusting the judgment of a named 2-of-3 multisig, and the
              deposit cap is the honest size of that trust.
            </>
          }
        >
          <p>
            The Admin Safe sets policy within the compiled caps: the out-of-the-money band, the
            premium floor, the utilisation ceiling, the protocol fee, the deposit cap, the fee
            recipient, and whether the Valorem engine fee is accepted. The Guardian can halt writes
            and invalidate listings, and can do nothing else.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> a band set too tight means weeks where no rung qualifies
            and the vault simply holds spot. A band set too loose means assignment becomes routine.
            Both are legal moves inside the caps.
          </p>
        </Risk>
      </Group>

      <Group
        title="The shape of your position"
        note="Two things that are not failures at all. They are still the reasons people are unhappy."
      >
        <Risk
          title="Withdrawals queue"
          likelihood="Every open week"
          tone="warn"
          response={
            <>
              The queue is the mechanism, not a discretionary gate: shares are escrowed and tagged
              with an epoch, the epoch settles when the week closes, and you draw a pro-rata slice.
              No key can jump the queue, and no key can stop it — the close is permissionless an
              hour after expiry. Deposits close at the cycle&apos;s exercise timestamp for the same
              structural reason.
            </>
          }
        >
          <p>
            A redemption settles instantly only while the vault is flat, meaning idle with nothing
            written. Once a call is open the collateral is locked in Valorem until expiry, so an
            exit started mid-week completes after the week closes on Saturday, not before.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> the option to leave at a moment of your choosing. {SHARE_TICKER}{" "}
            is not listed anywhere, so there is no secondary market to sell into instead, and what
            the queue returns is a mix of collateral and USDG rather than a fixed token count.
          </p>
        </Risk>

        <Risk
          title="No subsidy behind a bad week"
          likelihood="By design"
          tone="info"
          response={
            <>
              Nothing, deliberately. There is no protocol token, no points programme and no airdrop
              at launch, so there is no emission quietly topping up a week that earned nothing. A
              zero week is displayed as zero because there is nothing available to paper over it.
            </>
          }
        >
          <p>
            Plenty of products make an empty week look survivable by paying it in their own token.
            This one has no token to pay with. Depositors keep the net premium after Overcall&apos;s
            cut and the stated protocol fee, and that is the entire return path.
          </p>
          <p style={{ marginBottom: 0 }}>
            <strong>Costs you:</strong> the cushion. There is no emission to offset an assigned
            week, and no airdrop to compensate for a run of empty ones.
          </p>
        </Risk>
      </Group>

      <div className="card" style={{ marginTop: 34 }}>
        <div className="card-head">
          <h2 className="card-title">Before you go further</h2>
        </div>
        <ul className="tight">
          <li>
            This interface is not available to US persons, and the legal form of the collateral is
            set out in full on <Link href="/legal">the legal page</Link>.
          </li>
          <li>
            Nothing here is investment, legal or tax advice, and nothing here is an offer of
            securities.
          </li>
          <li>
            Past weeks describe what already happened and say nothing about the next one. Every
            result, including the empty weeks, is published as it closes.
          </li>
        </ul>
        <div className="cta">
          <a
            className="btn ext"
            data-variant="ghost"
            href={appUrl("/activity")}
            target="_blank"
            rel="noreferrer noopener"
          >
            Read the weekly results
          </a>
          <Link className="btn" href="/how-it-works">
            How the week runs
          </Link>
        </div>
      </div>
    </>
  );
}
