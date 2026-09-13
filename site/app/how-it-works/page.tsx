/**
 * callhouse.xyz/how-it-works — the mechanics, for someone who has not connected anything.
 *
 * This is the public sibling of the dapp's /docs page. The difference is the reader: there,
 * a depositor is looking at their own position, so the page can say "your tokens" and sit
 * next to live state. Here nobody has deposited, nothing is connected, and the vault is not
 * even deployed — so everything below is a fixed parameter, an address, or a rule, and the
 * reader is told which is which.
 *
 * DELIBERATELY ABSENT: every number that could move. No cycle number, no strike, no premium,
 * no realized week, no TVL, no "current" anything — this package makes zero chain reads and
 * has no wallet code, and a live figure rendered before launch would be a zero next to a word
 * like "realized", which reads as a result rather than as an absence. Also absent: any figure
 * scaled past one week, any chart, and any statement of what a week will pay. The only weekly
 * numbers on this page are policy floors and ceilings compiled into the contracts.
 *
 * Every "go do something" link leaves for app.callhouse.xyz via appUrl(). A relative href on
 * this domain is a 404, not a route into the dapp.
 */
import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  ADDRESS_ROWS,
  CHAIN_ID,
  CHAIN_NAME,
  MARKET,
  SHARE_TICKER,
  VENUE_NAME,
  VENUE_URL,
  addressUrl,
  appUrl,
} from "@/lib/site";

const DESCRIPTION =
  "The weekly covered-call cycle in detail: the timeline, the three ways a week can end, the phase machine, the fees, the policy bounds and the contracts.";

/**
 * `title` is the bare route name: the layout carries the "%s — Callhouse" template, so
 * repeating the suffix here would render it twice. `alternates.canonical` is not optional —
 * the layout's default canonical is "/", and inheriting it would point every crawler at the
 * landing page instead of this one. The Open Graph title is stated in full because the
 * template does not apply inside openGraph.
 */
export const metadata: Metadata = {
  title: "How it works",
  description: DESCRIPTION,
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    title: "How it works — Callhouse",
    description: DESCRIPTION,
    url: "/how-it-works",
    siteName: "Callhouse",
    type: "article",
  },
};

/**
 * `.card + .card` in the stylesheet is a vertical-stack rule: 16px between two cards that
 * follow one another down the page. Inside a `.grid` the grid's own gap already does that, and
 * the inherited margin would drop every card except the first out of line with its row.
 * Cancelling it per element is cheaper than adding a selector to a stylesheet that has to stay
 * byte-compatible with the dapp's.
 */
const IN_GRID: CSSProperties = { marginTop: 0 };

/**
 * README "Policy (launch)", copied verbatim. These are the launch settings inside the hard
 * caps compiled into Policy.sol, not targets and not forecasts. Update from the README, never
 * the other way round.
 */
const POLICY: Array<[string, string]> = [
  ["Underlying", `${MARKET} only`],
  ["Min OTM", "3%"],
  ["Max OTM", "12%"],
  ["Min list premium", "0.40% of spot / week"],
  ["Max utilization", `95% of idle ${MARKET}`],
  ["Protocol fee", "10% of USDG harvested (filled weeks only)"],
  ["Deposit cap", `20–50 ${MARKET} at launch`],
  ["Max listings signed per cycle", "3"],
];

/** Who is charged what, and on which weeks. An unfilled week is charged nothing by anyone. */
const FEES: Array<{ who: string; size: string; when: string; note: string }> = [
  {
    who: VENUE_NAME,
    size: "5% of premium",
    when: "On fill",
    note: "A second Seaport consideration item inside the listing itself. Rounded per contract, not on the total — rounding on the total produces an order that signs and then cannot be partially filled.",
  },
  {
    who: "Callhouse",
    size: "10% of harvested USDG",
    when: "On fill",
    note: "Taken at harvest, on filled weeks only. A week with no buyer collected nothing, so it is charged nothing.",
  },
  {
    who: "Valorem engine",
    size: "15 bps of notional",
    when: "Currently off",
    note: "Off at Overcall launch. If that switch flips on, this vault refuses to write until an admin explicitly accepts it: 15 bps of notional can eat a whole weekly out-of-the-money premium.",
  },
];

/** The four phases, what each one permits, and who can move it to the next. */
const PHASES: Array<{
  phase: string;
  deposits: string;
  withdrawals: string;
  next: string;
}> = [
  {
    phase: "Idle",
    deposits: "Open, up to the cap",
    withdrawals: "Settle immediately while flat",
    next: "Keeper opens the week, only when the registry has a live cycle",
  },
  {
    phase: "Listed",
    deposits: "Open until the exercise timestamp",
    withdrawals: "Queued",
    next: "Anyone locks the book, from the exercise timestamp",
  },
  {
    phase: "Exercisable",
    deposits: "Closed",
    withdrawals: "Queued",
    next: "Keeper closes the week at expiry; anyone an hour later",
  },
  {
    phase: "Settling",
    deposits: "Closed",
    withdrawals: "Being settled",
    next: "Same transaction: reclaim, harvest, settle the queue, back to Idle",
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <div className="page-head">
        <div className="eyebrow">
          {CHAIN_NAME} {CHAIN_ID} · {VENUE_NAME} · Valorem Clear · Seaport 1.6
        </div>
        <h1>One week, start to finish</h1>
        <p className="lede">
          Deposit one tokenised stock, receive vault shares. Each week a keeper writes a call
          against the idle collateral, lists it for USDG, and pays out whatever actually filled.
          This page is the mechanics of that week: the timeline, the three ways it can end, and
          the rules the contracts enforce while it runs.
        </p>
      </div>

      {/* ---------------------------------------------------------------- 1. the week ----- */}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">The week</h2>
          <span className="badge">
            <span className="dot" />
            Cycle → expiry
          </span>
        </div>

        <p className="small muted">
          The keeper binds to the {VENUE_NAME} registry&apos;s cycle, not to a wall clock. It
          watches the registry for an open write window and reads the deadlines from it; the days
          and times below are the venue&apos;s current window, not a promise Callhouse makes. If
          the registry moves the window, the vault moves with it.
        </p>

        <ol className="steps">
          <li className="step">
            <strong>The cycle opens.</strong> The registry publishes the week: up to five strike
            rungs, the write deadline it calls the exercise timestamp, and the expiry. Nothing can
            be written before this, and the vault has no calendar of its own.
          </li>
          <li className="step">
            <strong>The keeper picks a rung.</strong> The nearest {VENUE_NAME} rung that sits
            inside the out-of-the-money band — at launch, 3% to 12% above spot. If no rung
            qualifies, the vault writes nothing and holds the collateral for the week. A skipped
            week is a normal outcome.
          </li>
          <li className="step">
            <strong>It writes <code>n</code> calls against idle collateral.</strong> Idle
            collateral is locked in Valorem Clear and written as whole contracts, one contract per
            1.0000 Stock Token, capped at 95% of the idle balance. Collateral already locked in
            last week&apos;s call is not touched, and neither is anything deposited after the
            calls are written.
          </li>
          <li className="step">
            <strong>It signs a Seaport listing for USDG.</strong> The vault authorises the order
            by hash on chain and answers EIP-1271 as the offerer; the keeper posts it to{" "}
            {VENUE_NAME}&apos;s book. At most three listings are signed per cycle. The keeper
            never holds the option tokens and can never move funds.
          </li>
          <li className="step">
            <strong>The book closes.</strong> Friday 20:00 UTC in the venue&apos;s current window
            — the registry&apos;s exercise timestamp is the real deadline. After it, nothing more
            is written and nothing more is listed. Closing the book is permissionless from that
            moment, so a dead keeper cannot hold the week open.
          </li>
          <li className="step">
            <strong>Expiry.</strong> Saturday 20:00 UTC. By then the call has either been
            exercised by whoever bought it, or it has expired worth nothing to them.
          </li>
          <li className="step">
            <strong>Reclaim, harvest, distribute.</strong> The vault redeems its Valorem claim —
            collateral back, or strike USDG instead where it was assigned — harvests the USDG,
            takes the protocol fee, credits the remainder per share, settles the redemption queue,
            and returns to Idle. The keeper may do this at expiry; anyone may do it an hour later.
          </li>
        </ol>
      </div>

      {/* ---------------------------------------------------------------- 2. outcomes ----- */}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">What happens at expiry</h2>
        </div>
        <p className="small muted">
          Three outcomes, and premium is paid only if a buyer fills the listing. Which one you get
          is decided by the order book and by where the stock closes, not by anything the vault
          does.
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
              The listing sat on a thin book and nobody filled it. The week pays zero USDG. Nobody
              owns the call, so nothing can be assigned: the collateral comes straight back out of
              Valorem at expiry. This is published as a row like any other week, not hidden as an
              error state.
            </p>
          </div>

          <div className="card" style={IN_GRID}>
            <div className="card-head">
              <h3 className="card-title">Bought, expired OTM</h3>
              <span className="badge" data-tone="good">
                Premium kept
              </span>
            </div>
            <p className="small" style={{ marginBottom: 0 }}>
              A buyer paid the premium and the stock finished below the strike, so exercising would
              have cost them money. The option expires worthless to them. The vault keeps the
              premium net of fees and the collateral returns intact.
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
              Assignment can take the collateral at the strike. Those tokens leave and come back as
              strike USDG instead. The premium is still kept, and the upside above the strike is
              gone for that week. v1 does not automatically buy the tokens back.
            </p>
          </div>
        </div>

        <div className="notice" data-tone="info" style={{ marginTop: 16 }}>
          <strong>Partial assignment is normal.</strong>
          Valorem assigns by bucket, not perfectly pro rata, so a week can end with some of the
          vault&apos;s contracts assigned and the rest not. The vault then holds a mix of
          collateral and USDG, and a queued withdrawal settled that week pays out in the same mix.
        </div>
      </div>

      {/* ---------------------------------------------------------------- 3. phases ------- */}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">The phase machine</h2>
        </div>

        <div className="flow">
          <div className="flow-node">Idle</div>
          <div className="flow-arrow" />
          <div className="flow-node">Listed</div>
          <div className="flow-arrow" />
          <div className="flow-node">Exercisable</div>
          <div className="flow-arrow" />
          <div className="flow-node">Settling</div>
          <div className="flow-arrow" />
          <div className="flow-node">Idle</div>
        </div>

        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th>Deposits</th>
                <th>Withdrawals</th>
                <th>Who moves it on</th>
              </tr>
            </thead>
            <tbody>
              {PHASES.map((p) => (
                <tr key={p.phase}>
                  <td>{p.phase}</td>
                  <td style={{ whiteSpace: "normal" }}>{p.deposits}</td>
                  <td style={{ whiteSpace: "normal" }}>{p.withdrawals}</td>
                  <td style={{ whiteSpace: "normal" }}>{p.next}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <hr className="hr" />

        <ul className="tight small">
          <li>
            <strong>Deposits close at the cycle&apos;s exercise timestamp.</strong> Not at expiry —
            at the moment the book closes. A deposit after the calls are written would buy into a
            position whose downside is already fixed and whose premium was already earned by
            somebody else&apos;s collateral, so the vault refuses it and the quote goes to zero at
            the same instant.
          </li>
          <li>
            <strong>A withdrawal requested while a call is open is queued, not refused.</strong>{" "}
            The shares are escrowed and tagged with the week. When the vault reclaims, that week is
            settled into a pot of collateral and USDG and each queued holder draws a pro-rata
            slice. A queued withdrawal is never a promise of a fixed number of tokens: if the week
            was assigned, part of it arrives as USDG at the strike.
          </li>
          <li>
            <strong>Withdrawing from idle collateral is never blocked by a pause.</strong> Halting
            writes stops exactly one thing — opening a new short. It does not stop a withdrawal, a
            claim, or the close of a week.
          </li>
        </ul>
      </div>

      {/* ---------------------------------------------------------------- 4. fees --------- */}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Fees</h2>
        </div>

        {/* Three short columns only. The explanation for each row is the list underneath: a
            paragraph-length cell would force a 400px reader to scroll the table sideways to
            read a sentence. */}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Charged by</th>
                <th>Size</th>
                <th>Charged when</th>
              </tr>
            </thead>
            <tbody>
              {FEES.map((f) => (
                <tr key={f.who}>
                  <td>{f.who}</td>
                  <td>{f.size}</td>
                  <td>{f.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="tight small" style={{ marginTop: 12 }}>
          {FEES.map((f) => (
            <li key={f.who}>
              <strong>{f.who}.</strong> {f.note}
            </li>
          ))}
        </ul>

        <p className="small muted" style={{ marginBottom: 0 }}>
          Both live fees are taken out of premium, and premium exists only when a buyer fills. A
          week with no buyer costs nothing because nothing was collected.
        </p>
      </div>

      {/* ---------------------------------------------------------------- 5. policy ------- */}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Policy (launch)</h2>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Param</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {POLICY.map(([param, value]) => (
                <tr key={param}>
                  <td>{param}</td>
                  <td style={{ whiteSpace: "normal" }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small muted" style={{ marginTop: 12 }}>
          Strike is the nearest {VENUE_NAME} rung inside the OTM band. If no rung qualifies, the
          vault holds spot and writes nothing.
        </p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          These are the launch settings. The hard floors and ceilings around them are compiled into
          the contracts — a minimum out-of-the-money floor, a maximum ceiling, a utilization
          ceiling and a fee ceiling — so an admin cannot quietly move the vault to selling
          at-the-money. Inside those bounds the knobs can still be set badly, which is on{" "}
          <Link href="/risks">the risk list</Link>.
        </p>
      </div>

      {/* ---------------------------------------------------------------- 6. roles -------- */}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Who can do what</h2>
        </div>

        <div className="grid grid-3">
          <div className="card" style={IN_GRID}>
            <h3 className="card-title" style={{ marginBottom: 8 }}>
              Admin · Safe 2/3
            </h3>
            <p className="small" style={{ marginBottom: 0 }}>
              Sets policy inside the compiled caps, the deposit cap and the fee recipient. Accepts
              the Valorem fee if it is ever switched on. Lifts a halt. Two of three signers.
            </p>
          </div>
          <div className="card" style={IN_GRID}>
            <h3 className="card-title" style={{ marginBottom: 8 }}>
              Keeper · hot key
            </h3>
            <p className="small" style={{ marginBottom: 0 }}>
              Opens the week, authorises listings, cancels them, locks the book, closes the week.
              It never holds the option tokens and can never move funds out of the vault.
            </p>
          </div>
          <div className="card" style={IN_GRID}>
            <h3 className="card-title" style={{ marginBottom: 8 }}>
              Guardian · single key
            </h3>
            <p className="small" style={{ marginBottom: 0 }}>
              Halts writes and cancels listings. Nothing else. It cannot touch collateral, cannot
              change policy, and cannot stop a withdrawal.
            </p>
          </div>
        </div>

        <div className="notice" data-tone="warn" style={{ marginTop: 16 }}>
          <strong>There is no proxy on v1.</strong>
          The vault cannot be upgraded in place. Fixing anything means deploying Vault v2 and
          migrating to it, in public, with depositors moving their own funds. That is deliberate:
          an upgradeable vault is a key that can rewrite the rules under a position that is already
          open. The contracts in this repository have not been audited.
        </div>
      </div>

      {/* ---------------------------------------------------------------- 7. contracts ---- */}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">The contracts</h2>
        </div>
        <p className="small muted">
          Everything the weekly cycle touches, on chain {CHAIN_ID}. All third party: the Callhouse
          vault itself is not listed here because it is not deployed yet. There is one{" "}
          <a className="ext" href={VENUE_URL} target="_blank" rel="noreferrer noopener">
            {VENUE_NAME}
          </a>{" "}
          registry per market, and the one below is the {MARKET} market specifically.
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Address</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {ADDRESS_ROWS.map((row) => (
                <tr key={row.address}>
                  <td>{row.label}</td>
                  <td>
                    <a href={addressUrl(row.address)} target="_blank" rel="noreferrer noopener">
                      {row.address}
                    </a>
                  </td>
                  <td style={{ whiteSpace: "normal" }}>{row.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
          <strong>Settlement never reads a price feed.</strong> Whether a call is exercised is
          decided by whoever bought it, and what the vault gets back is decided by Valorem. The
          Chainlink feed is used for two things only: showing a spot price, and gating the write so
          the vault refuses to sell a strike against a stale or paused oracle.
        </p>
      </div>

      {/* ---------------------------------------------------------------- 8. the tape ----- */}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Then it happens again</h2>
        </div>
        <p>
          Every week is published, including the zeros. The unfilled weeks are rows on the same
          tape as the filled ones, labelled as what they are, because a record that only shows the
          weeks that worked is not a record.
        </p>
        <p className="small muted">
          We do not publish an APY, an APR or any annualised figure, and there is no price chart on this site.{/* copy-lint-allow */}
          {" "}What is published is what a closed week actually paid, in USDG.
        </p>
        <div className="cta">
          <a
            className="btn ext"
            data-variant="primary"
            href={appUrl("/activity")}
            target="_blank"
            rel="noreferrer noopener"
          >
            See every published week
          </a>
          <a className="btn ext" href={appUrl("/vault/nvda")} target="_blank" rel="noreferrer noopener">
            Open the {SHARE_TICKER} vault
          </a>
        </div>
        <p className="tiny faint" style={{ marginTop: 16, marginBottom: 0 }}>
          Read <Link href="/risks">the risks</Link> before depositing, and{" "}
          <Link href="/legal">the legal page</Link> for the geographic restrictions and the legal
          form of the collateral. Stock Tokens are debt securities issued by Robinhood Assets
          (Jersey) Limited, not shares.
        </p>
      </div>
    </>
  );
}
