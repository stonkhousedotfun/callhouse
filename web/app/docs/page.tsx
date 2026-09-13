/**
 * The in-app docs: the weekly cycle in one page, what it costs, and the unabridged risk list.
 *
 * This page is a condensation, not the source of truth. The canonical documents are
 * docs/ARCHITECTURE.md at the repo root, contracts/docs/ACCOUNTING.md (the contracts submodule,
 * leekzor/callhouse-contracts) and the operator material in ops/runbooks/.
 * Where this page and those disagree, this page is the one that is wrong.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { addressUrl } from "@/lib/chain";
import {
  ASSET,
  CLEARINGHOUSE,
  MARKET,
  OVERCALL_FEE_RECIPIENT,
  REGISTRY,
  SEAPORT,
  SHARE_TICKER,
  USDG,
  VAULT,
} from "@/lib/contracts";

export const metadata: Metadata = {
  title: "Docs — Callhouse",
  description: "How the weekly covered-call cycle works, what it costs, and everything that can go wrong.",
};

const ADDRESSES: Array<[string, string | undefined, string]> = [
  ["Callhouse vault", VAULT, "shares, deposits, the queue, the phase machine"],
  ["NVDA Stock Token", ASSET, "the collateral, 18 decimals"],
  ["USDG", USDG, "premium and strike currency, 6 decimals"],
  ["Overcall registry (NVDA)", REGISTRY, "the cycle, the five strikes, the write deadline"],
  ["Valorem Clear", CLEARINGHOUSE, "writes the call, holds the collateral, settles assignment"],
  ["Seaport 1.6", SEAPORT, "the listing venue; the vault is the offerer"],
  ["Overcall fee recipient", OVERCALL_FEE_RECIPIENT, "receives 5% of every premium"],
];

export default function DocsPage() {
  return (
    <div className="prose">
      <div className="page-head">
        <div className="eyebrow">Docs</div>
        <h1>How this works, and what can go wrong</h1>
        <p className="lede">
          The short version of the spec, then the whole risk list. Nothing here is marketing.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>The product in one paragraph</h2>
        <p>
          You deposit {MARKET} Stock Tokens and receive {SHARE_TICKER} shares. Once a week, when the
          Overcall registry opens a cycle, a keeper locks idle collateral in Valorem Clear, writes
          one call per whole token, and lists the resulting option on Seaport for USDG. If a buyer
          fills, the vault receives 95% of the premium and Overcall receives 5%. After expiry the
          keeper reclaims: an out-of-the-money call returns the collateral, an exercised one returns
          the strike in USDG instead. 5% of the premium goes to the protocol fee address; the rest
          of the premium, and any strike USDG in full, becomes claimable pro rata. There is no
          protocol token.
        </p>
        <p style={{ marginBottom: 0 }}>
          If nobody buys the call, the week earns nothing. That is a normal outcome, not a failure
          of the machinery, and it is published as a row on{" "}
          <Link href="/activity">the activity page</Link> like any other week.
        </p>
      </div>

      <h2>A week, step by step</h2>
      <ol className="tight">
        <li>
          <strong>The registry opens a cycle.</strong> The keeper watches{" "}
          <code>registry.isWritingOpen()</code>, never a calendar. The registry publishes up to five
          strikes, the write deadline (its <code>exerciseTimestamp</code>) and the expiry.
        </li>
        <li>
          <strong>Strike choice.</strong> The vault writes the nearest rung that sits inside its
          out-of-the-money band. If no rung qualifies, it writes nothing and holds the collateral.
        </li>
        <li>
          <strong>Write.</strong> <code>rollOpen</code> approves the clearinghouse and writes whole
          lots, capped by the utilization limit and the contract cap. One lot is 1.0 Stock Token.
        </li>
        <li>
          <strong>List.</strong> The vault authorises the Seaport order by hash on-chain with{" "}
          <code>approveListing</code>, then the keeper posts it to Overcall&apos;s book. The vault is
          the offerer and answers EIP-1271; the keeper never holds the option tokens and can never
          move funds.
        </li>
        <li>
          <strong>Book close.</strong> After the write deadline nothing more can be written or
          listed. <code>lockBook</code> is permissionless from that moment.
        </li>
        <li>
          <strong>Expiry, then settle.</strong> <code>rollClose</code> redeems the Valorem claim,
          harvests the USDG, settles the redemption queue and returns the vault to Idle. The keeper
          can call it from expiry; anyone can call it an hour later, so a dead keeper cannot strand
          the week.
        </li>
      </ol>

      <h2>What it costs</h2>
      <ul className="tight">
        <li>
          <strong>Overcall: 5% of the premium.</strong> Built into every listing as a second Seaport
          consideration item. Charged only when a buyer fills.
        </li>
        <li>
          <strong>Callhouse: 5% of the premium.</strong> Taken at harvest from the premium that
          reached the vault, on filled weeks only. Strike proceeds from an assignment carry no fee:
          they are your collateral sold at the strike, not income. An unfilled week costs nothing
          because nothing was collected.
        </li>
        <li>
          <strong>Valorem: 15 bps of notional, currently off.</strong> If the switch flips on, the
          vault refuses to write until an admin explicitly accepts it — 15 bps of notional can eat a
          whole weekly out-of-the-money premium.
        </li>
      </ul>

      <h2>The numbers on this site</h2>
      <ul className="tight">
        <li>
          <strong>Share price is collateral only.</strong> Idle plus locked Stock Tokens, divided by
          shares, using raw balances. Premium is not folded in.
        </li>
        <li>
          <strong>USDG is tracked separately.</strong> It accrues per share and is pulled with{" "}
          <code>claimUsdg()</code>, so a share price that has not moved does not mean nothing was
          earned — and vice versa.
        </li>
        <li>
          <strong>Last week realized</strong> is net USDG harvested per share, plus that net over
          the collateral valued at the feed spot recorded at harvest.
        </li>
        <li>
          <strong>The uiMultiplier is display only.</strong> The Stock Token uses ERC-8056 to express
          splits and dividend adjustments without rebasing. The vault&apos;s maths, the deposit cap
          and every transaction built on this site use the raw balance. Anywhere the site shows an
          adjusted figure it is labelled as display-only.
        </li>
        <li>
          <strong>The short call is never marked to market.</strong> The share price moves when USDG
          arrives or when collateral is assigned away, and at no other time.
        </li>
        <li>
          We do not publish an APY, an APR or any annualised figure, and there is no price chart on this site.{/* copy-lint-allow */}
        </li>
      </ul>

      <h2>Deposits, withdrawals, and the queue</h2>
      <ul className="tight">
        <li>
          Deposits are accepted while the vault is Idle or Listed. New money lands in idle
          collateral and is not added to a call that is already open.
        </li>
        <li>
          A redemption settles instantly only while the vault is flat — Idle with nothing written.
          The preview returns zero at any other time rather than quoting an amount you cannot get.
        </li>
        <li>
          Otherwise the redemption is queued. Your shares are escrowed and tagged with an epoch;
          when the keeper closes the week the epoch is settled into a pot of collateral and USDG and
          you draw a pro-rata slice with <code>completeRedeem</code>.
        </li>
        <li>
          A queued redemption is never a promise of a fixed number of tokens. If the week was
          assigned, part of your payout arrives as USDG at the strike.
        </li>
        <li>
          Halting writes never blocks a redemption, a claim, or the close of a week. It blocks
          exactly one thing: opening a new short.
        </li>
      </ul>

      <h2>Risks</h2>
      <p className="small muted">
        The list the build plan carries, unabridged. Read it before depositing.
      </p>
      <ul className="tight">
        <li>
          <strong>No buyer.</strong> The most likely failure mode, and an economic one rather than a
          technical one. The week&apos;s premium is zero. The mitigation is transparency plus a
          fallback fill path on <Link href="/vault/nvda/cycle">the cycle page</Link>, where the
          signed order is published so a buyer can fill it directly from here.
        </li>
        <li>
          <strong>Assignment.</strong> An exercised call takes the collateral at the strike. Upside
          above it is gone for that week and the vault can end the week holding USDG instead of
          tokens. v1 does not automatically buy the token back.
        </li>
        <li>
          <strong>Partial assignment.</strong> Valorem assigns by bucket, not perfectly pro rata, so
          the vault can be assigned on some contracts and not others.
        </li>
        <li>
          <strong>Issuer freeze.</strong> Robinhood Assets (Jersey) Limited can halt Stock Token
          transfers, and the token can pause its own oracle. Either can brick the write or the
          settlement. There is no way to code around it; the vault refuses to write while the oracle
          is paused, and the keeper alerts.
        </li>
        <li>
          <strong>Valorem fee switch.</strong> 15 bps of notional, currently off. Gated behind
          <code> feesEnabled</code> plus an explicit admin acceptance.
        </li>
        <li>
          <strong>Stacked fees.</strong> 5% to Overcall on the gross premium, then 5% to the protocol
          on the 95% that reaches the vault: 9.75% of what the buyer paid, both only on filled
          weeks, neither on strike proceeds.
        </li>
        <li>
          <strong>Order book access.</strong> Overcall&apos;s listings API takes no key and has no
          maker allowlist, and its validator explicitly accepts a contract offerer that answers
          EIP-1271. If that ever changes, the fallback fill page is the answer.
        </li>
        <li>
          <strong>Admin misconfiguration.</strong> The policy bounds live in bytecode — a minimum
          out-of-the-money floor, a maximum ceiling, a utilization ceiling, a fee ceiling — so an
          admin cannot quietly sell at-the-money. Within those bounds they can still set the knobs
          badly.
        </li>
        <li>
          <strong>Keeper failure mid-week.</strong> The guardian can close the week after expiry,
          and the close is permissionless an hour after that.
        </li>
        <li>
          <strong>Sequencer or API outage into the write window.</strong> The keeper retries with
          backoff and refuses to write if it cannot list — an unlisted short is all of the risk and
          none of the premium.
        </li>
        <li>
          <strong>This vault is unaudited.</strong> Valorem Clear was audited by Zellic under its
          former name; the Callhouse vault has not been audited. Treat the deposit cap as
          the real statement of confidence.
        </li>
      </ul>

      <h2>Addresses</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Address</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {ADDRESSES.map(([label, address, role]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  {address ? (
                    <a href={addressUrl(address)} target="_blank" rel="noreferrer noopener">
                      {address}
                    </a>
                  ) : (
                    "not deployed"
                  )}
                </td>
                <td style={{ whiteSpace: "normal" }}>{role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="tiny faint">
        Chain 4663 (Robinhood Chain), an Arbitrum Orbit L2. There are eleven per-market Overcall
        registries; the one above is the {MARKET} market specifically.
      </p>

      <h2>Roles</h2>
      <ul className="tight">
        <li>
          <strong>Admin (multisig).</strong> Sets policy inside the bytecode caps, the deposit cap,
          the fee recipient; accepts the Valorem fee; lifts a halt.
        </li>
        <li>
          <strong>Keeper (hot key).</strong> Opens the week, authorises listings, cancels them,
          locks the book, closes the week. It can never move funds and never holds the option
          tokens.
        </li>
        <li>
          <strong>Guardian (single key).</strong> Halts writes and kills listings. Nothing else.
        </li>
      </ul>

      <p className="small muted">
        Read <Link href="/legal">the legal page</Link> for the Stock Token&apos;s legal form and the
        geographic restrictions.
      </p>
    </div>
  );
}
