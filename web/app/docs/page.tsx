/**
 * The in-app docs: the weekly cycle in one page, what it costs, and the unabridged risk list.
 *
 * This page is a condensation, not the source of truth. The canonical documents are
 * docs/ARCHITECTURE.md at the repo root, contracts/README.md, contracts/SECURITY.md and
 * contracts/docs/ACCOUNTING.md (the contracts submodule, leekzor/callhouse-contracts) and the
 * operator material in ops/runbooks/. Where this page and those disagree, this page is the one
 * that is wrong.
 */
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { CardTitle, ExternalLink, PageHead, Panel, WarnIcon } from "@/components/ui";
import { addressUrl } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { ASSET, CLEARINGHOUSE, MARKET, SEAPORT, SHARE_TICKER, USDG, VAULT } from "@/lib/contracts";

export const metadata: Metadata = {
  title: "Docs — Callhouse",
  description: "How the weekly covered-call cycle works, what it costs, and everything that can go wrong.",
};

const ADDRESSES: Array<[string, string | undefined, string]> = [
  ["Callhouse vault", VAULT, "shares, deposits, the queue, the phase machine; the offerer AND the zone of every listing"],
  ["NVDA Stock Token", ASSET, "the collateral, 18 decimals"],
  ["USDG", USDG, "premium and strike currency, 6 decimals"],
  ["Valorem Clear", CLEARINGHOUSE, "holds the option types; the vault writes into it at each fill and settles assignment through it"],
  ["Seaport 1.6", SEAPORT, "the fill venue; the vault validates its order on chain and answers Seaport's zone hooks"],
];

/**
 * The page's h2s, in render order. The section list and the headings both read from here, so the
 * two cannot drift.
 */
const SECTIONS = {
  product: { id: "product-in-one-paragraph", title: "The product in one paragraph" },
  week: { id: "week-step-by-step", title: "A week, step by step" },
  costs: { id: "what-it-costs", title: "What it costs" },
  numbers: { id: "numbers-on-this-site", title: "The numbers on this site" },
  queue: { id: "deposits-withdrawals-queue", title: "Deposits, withdrawals, and the queue" },
  stranded: { id: "stranded-claim", title: "The stranded claim" },
  risks: { id: "risk-list", title: "Risks" },
  addresses: { id: "contract-addresses", title: "Addresses" },
  roles: { id: "vault-roles", title: "Roles" },
} as const satisfies Record<string, TocEntry>;

export default function DocsPage() {
  return (
    <>
      <PageHead
        eyebrow="Docs"
        title="How this works, and what can go wrong"
        lede="The short version of the spec, then the whole risk list. Nothing here is marketing."
      />

      <DocShell toc={Object.values(SECTIONS)}>
        <Panel as="section" pad="lg" aria-labelledby={SECTIONS.product.id} className={MEASURE}>
          <CardTitle
            id={SECTIONS.product.id}
            className="scroll-mt-8 text-[length:clamp(22px,2.4vw,26px)]! leading-[1.2]! tracking-[-0.02em]!"
          >
            {SECTIONS.product.title}
          </CardTitle>
          <div className="mt-4 space-y-4">
            <p>
              You deposit {MARKET} Stock Tokens and receive {SHARE_TICKER} shares. Once a week the keeper creates one
              out-of-the-money option type on Valorem Clear and the vault arms it after checking the strike, the lot and
              the window itself; the vault then authorises one Seaport order for it and this site&apos;s{" "}
              <Link href="/vault/nvda/cycle" className={DOC_LINK}>fill page</Link> is where the order is sold. Nothing is written when the
              week opens: every fill writes exactly the contracts it buys, inside the buyer&apos;s transaction, so the vault
              never holds an unsold call and can never be assigned on more than it was paid for. After expiry the keeper
              reclaims: an out-of-the-money call returns the collateral, an exercised one returns the strike in USDG
              instead. 5% of the premium goes to the protocol fee address; the rest of the premium, and any strike USDG
              in full, becomes claimable pro rata. There is no protocol token.
            </p>
            <p>
              If nobody buys the call, the week earns nothing. That is a normal outcome, not a failure
              of the machinery, and it is published as a row on{" "}
              <Link href="/activity" className={DOC_LINK}>the activity page</Link> like any other week.
            </p>
          </div>
        </Panel>

        <DocSection {...SECTIONS.week}>
          <StepList>
            <Step>
              <strong>The option type.</strong> The keeper creates it on the clearinghouse with{" "}
              <code>newOptionType</code> (permissionless): {MARKET} in, USDG out, one token per contract, an exercise time
              at the NYSE close on the cycle&apos;s Friday (16:00 Eastern, which is 20:00 UTC in daylight time and 21:00
              UTC from November; the Thursday before a Friday market holiday) and an expiry 24 hours later. Every page
              prints those two instants from the chain, in UTC and on the Eastern clock.
            </Step>
            <Step>
              <strong>Arm.</strong> <code>rollOpen(optionId)</code> reads the type back from the clearinghouse and
              refuses it unless the underlying is this vault&apos;s asset, the exercise asset is USDG, the lot is exactly one
              token, the exercise time is at least an hour out, the window at least a day and the tenor at most three
              weeks, Valorem&apos;s fee is off or accepted, the oracle is live, and the strike sits inside the vault&apos;s
              out-of-the-money band, both bounds. It writes nothing. There is no registry.
            </Step>
            <Step>
              <strong>List.</strong> <code>approveListing</code> checks the keeper&apos;s Seaport order field by field —
              the vault is offerer and zone, PARTIAL_RESTRICTED, one ERC-1155 offer of the armed id sized at most to the
              vault&apos;s capacity, one USDG leg to the vault that divides by the size, the unit price at or below the
              strike, an end time at or before the exercise time — then validates it on Seaport by hash. At most three
              listings a cycle, cancelled or not: a relist is a reprice.
            </Step>
            <Step>
              <strong>Fill, and write.</strong> A buyer fills k of N on the fill page (or with any Seaport 1.6 client).
              Seaport calls the vault&apos;s <code>authorizeOrder</code> before moving anything; the vault re-checks its gate
              at today&apos;s spot — the strike still above the band floor, the premium above its floor (plus Valorem&apos;s
              fee valued at spot when it is on), the total size within capacity, the sale window still open, the oracle
              live, writes not halted — and writes exactly k contracts into Valorem. Seaport moves them to the buyer and
              the USDG to the vault; <code>validateOrder</code> reverts the fill unless no token stayed behind.
            </Step>
            <Step>
              <strong>Sale window closes.</strong> From the option&apos;s exercise time the hook refuses every fill and
              deposits close (<code>maxDeposit() == 0</code>), whether or not anyone calls <code>lockBook</code>. The calls
              sold are exercisable until expiry.
            </Step>
            <Step>
              <strong>Expiry, then settle.</strong> <code>rollClose</code> redeems the Valorem claim, harvests the USDG,
              settles the redemption queue and returns the vault to Idle. The keeper can call it from expiry; anyone can
              call it an hour later, so a dead keeper cannot strand the week. If Valorem&apos;s redeem reverts (a USDG pause
              or freeze, a Stock Token blocklist) the vault still goes to Idle with the claim kept: the stranded state,
              below.
            </Step>
          </StepList>
        </DocSection>

        <DocSection {...SECTIONS.costs}>
          <DocList>
            <li>
              <strong>Callhouse: 5% of the premium.</strong> Taken at harvest from the premium that reached the vault, on
              filled weeks only. Strike proceeds from an assignment carry no fee: they are your collateral sold at the
              strike, not income. An unfilled week costs nothing because nothing was collected. There is no third-party
              venue fee: the listing has one payment leg, to the vault, and the buyer pays exactly the unit price.
            </li>
            <li>
              <strong>Valorem: 15 bps of notional, currently off.</strong> If the switch flips on, the vault refuses to
              arm or sell until an admin explicitly accepts it, and while accepted the fill hook adds the fee, valued at
              spot, to the premium floor a buyer must clear — 15 bps of notional can eat a whole weekly out-of-the-money
              premium.
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.numbers}>
          <DocList>
            <li>
              <strong>Share price is collateral only.</strong> Idle plus locked Stock Tokens, minus what settled redeemers
              are owed, divided by shares, using raw balances. Premium is not folded in. The short call is valued at zero.
            </li>
            <li>
              <strong>USDG is tracked separately.</strong> It accrues per share and is pulled with{" "}
              <code>claimUsdg()</code>, so a share price that has not moved does not mean nothing was
              earned — and vice versa.
            </li>
            <li>
              <strong>Calls sold equals calls written.</strong> <code>contractsWritten()</code> is the sum of the
              week&apos;s fills; there is no separate sold count and no unsold inventory. Capacity remaining is{" "}
              <code>Policy.maxContracts(totalAssets) − contractsWritten</code>, re-sized at every fill.
            </li>
            <li>
              <strong>Last week realized</strong> is net premium per share, plus that net premium over
              the collateral valued at the feed spot recorded at harvest.
            </li>
            <li>
              <strong>Strike proceeds are not premium.</strong> On an assigned week the USDG that came
              back for the collateral taken at the strike is credited to holders and claimable, but it
              is the collateral&apos;s sale price, not earnings. It is shown on its own line as
              &ldquo;Strike proceeds (assignment)&rdquo; and is left out of every premium figure.
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
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.queue}>
          <DocList>
            <li>
              Deposits are accepted while the vault is Idle or Listed, and closed by one gate (<code>DepositsClosed</code>,{" "}
              <code>maxDeposit() == 0</code>) from the moment the sale window closes, while a week settles, while a
              contract is assigned and its claim not yet redeemed, while a claim is stranded, or while an issuer burn has
              left the reserve unbacked. The deposit form says which.
            </li>
            <li>
              A deposit made while Listed buys into the open call: shares are priced as if the call were worth nothing, so
              if the week is assigned the loss is spread over every share, new ones included, and every later fill this
              week is sized against a balance that includes the deposit. Premium paid into the vault before the deposit is
              not shared with it. The form says so whenever the vault is Listed.
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
              A queue entry made while the vault is Idle does not have to wait for the next week to be
              armed. Anyone can call <code>settleQueue</code> while the vault is Idle; it settles the
              current epoch at the same price an instant redemption would pay, and{" "}
              <code>completeRedeem</code> then pays it out.
            </li>
            <li>
              A queued redemption is never a promise of a fixed number of tokens. If the week was
              assigned, part of your payout arrives as USDG at the strike. The Stock Token leg is paid whatever USDG is
              doing; the USDG leg may be deferred if USDG cannot move, and is paid when it can.
            </li>
            <li>
              Halting writes never blocks a redemption, a claim, or the close of a week. It blocks
              exactly one thing: arming or selling a new call.
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.stranded}>
          <p>
            <code>rollClose</code> redeems the week&apos;s Valorem claim, and Valorem pushes USDG and then {MARKET} to the
            vault in one call. Either token&apos;s issuer can make that revert: USDG paused, the vault or the clearinghouse
            frozen on USDG, or the vault blocklisted on the Stock Token in a week that was not fully assigned. Rather than
            hold every unit of idle collateral and the whole queue hostage to a stablecoin action, the vault goes to Idle
            anyway and keeps the claim. While it is stranded: deposits are refused and instant redemption is off (nobody
            buys in or leaves at a NAV that cannot yet see the claim&apos;s USDG); no new week can be armed; the queue keeps
            settling on the idle balance, and every epoch that settles takes a pro-rata share of the claim, paid when it
            is redeemed. Anyone can call <code>retryStrandedClaim</code> at any time; it fails harmlessly while the cause
            persists and settles the claim the first time Valorem lets it through. The pages show a banner with your
            pending share and a Retry button whenever this state holds.
          </p>
        </DocSection>

        <DocSection {...SECTIONS.risks}>
          <p className="text-[15px] text-ink-3">
            The list the build plan carries, unabridged. Read it before depositing.
          </p>
          <RiskList>
            <RiskItem>
              <strong>No buyer.</strong> The most likely failure mode, and an economic one rather than a
              technical one. The week&apos;s premium is zero. The mitigation is transparency: the fill page on{" "}
              <Link href="/vault/nvda/cycle" className={DOC_LINK}>the cycle page</Link> publishes the order so anyone can buy it, and the zero
              is published as a row.
            </RiskItem>
            <RiskItem>
              <strong>A fill refused after a rally.</strong> The vault re-prices its floors at every fill against live
              spot. If {MARKET} rallies after the week is armed, a strike that was in the band on Monday can be below the
              floor on Thursday and the vault refuses to sell it (<code>StrikeBelowBand</code>,{" "}
              <code>PremiumBelowFloorAtFill</code>) until the keeper reprices, at most three listings a week. That
              protects depositors from selling a near-the-money call for an out-of-the-money premium; it can also mean an
              unfilled week.
            </RiskItem>
            <RiskItem>
              <strong>Assignment.</strong> An exercised call takes the collateral at the strike. Upside
              above it is gone for that week and the vault can end the week holding USDG instead of
              tokens. v1 does not automatically buy the token back. Because every contract the vault wrote was sold, it
              is never assigned on more than it was paid for.
            </RiskItem>
            <RiskItem>
              <strong>Partial assignment.</strong> Valorem assigns pro rata by amount written across every writer of the
              option id, by bucket, so the vault can be assigned on some contracts and not others.
            </RiskItem>
            <RiskItem>
              <strong>Late depositor.</strong> A deposit while Listed buys into the open short and is sized against by
              later fills that week. The share price does not value the short, so an assigned week reaches every share.
            </RiskItem>
            <RiskItem>
              <strong>Issuer freeze, and a stranded claim.</strong> Robinhood Assets (Jersey) Limited can halt Stock Token
              transfers, and the token can pause its own oracle; USDG&apos;s issuer can pause or freeze. Any of these can
              stop the write or the settlement. The vault refuses to sell while the oracle is paused, keeps a claim it
              cannot redeem rather than freezing the whole book, and pays the Stock Token leg of a redemption whatever
              USDG is doing. Nothing can be coded around a frozen token itself.
            </RiskItem>
            <RiskItem>
              <strong>NAV under an issuer burn.</strong> If the issuer burns tokens out of the vault, NAV is stated
              honestly, deposits close while the reserve is unbacked, and settled redeemers are paid pro rata
              (<code>ReserveHaircut</code>).
            </RiskItem>
            <RiskItem>
              <strong>Valorem fee switch.</strong> 15 bps of notional, currently off. Gated behind{" "}
              <code>feesEnabled</code> plus an explicit admin acceptance.
            </RiskItem>
            <RiskItem>
              <strong>Admin misconfiguration.</strong> The policy bounds live in bytecode — a minimum
              out-of-the-money floor, a maximum ceiling, a utilization ceiling of 99.85%, a fee ceiling — so an
              admin cannot quietly sell at-the-money. Within those bounds they can still set the knobs
              badly. At launch one deployer key holds the admin role with no timelock until the handover.
            </RiskItem>
            <RiskItem>
              <strong>Keeper or admin compromise.</strong> The vault checks every field of every order, sizes every fill
              itself, and the keeper can never move a token. What a compromised keeper can do is list badly, inside the
              policy floors: the bound is about 1.1% to 2.2% of the notional sold per week, for at most three listings,
              before the guardian must act.
            </RiskItem>
            <RiskItem>
              <strong>Keeper failure mid-week.</strong> The guardian can close the week after expiry,
              and the close is permissionless an hour after that. Settling the queue and retrying a stranded claim are
              permissionless too.
            </RiskItem>
            <RiskItem>
              <strong>Sequencer or feed outage into the sale window.</strong> The vault refuses to sell on a stale feed
              (<code>StalePrice</code>) or a paused oracle; the keeper alerts.
            </RiskItem>
            <RiskItem>
              <strong>This vault is unaudited.</strong> Valorem Clear was audited by Zellic under its
              former name; the Callhouse vault and its libraries have not been audited by anyone outside the project. The
              test suite and the fork rehearsal are the whole gate. Treat the deposit cap as the real statement of
              confidence.
            </RiskItem>
          </RiskList>
        </DocSection>

        <DocSection {...SECTIONS.addresses}>
          <Panel pad="md" className="py-1.5! sm:py-2.5!">
            <div role="table" aria-labelledby={SECTIONS.addresses.id} className="text-[14px] leading-[1.5]">
              <div role="rowgroup">
                <div
                  role="row"
                  className="flex flex-wrap items-baseline border-b border-line-2 pb-2.5 pt-2 text-[12px] font-semibold leading-tight text-ink-3"
                >
                  <span role="columnheader" className="sm:mr-6 sm:w-[9.5rem] sm:shrink-0">
                    Contract
                  </span>
                  <span role="columnheader" className={cn(LEDGER_SEP, "sm:before:hidden")}>
                    Address
                  </span>
                  <span role="columnheader" className={LEDGER_SEP}>
                    Role
                  </span>
                </div>
              </div>
              <div role="rowgroup" className="divide-y divide-line">
                {ADDRESSES.map(([label, address, role]) => (
                  <div
                    key={label}
                    role="row"
                    className="grid grid-cols-1 gap-y-1 py-3.5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-x-6"
                  >
                    <span role="cell" className="font-semibold leading-snug text-ink sm:row-span-2 sm:text-[14.5px]">
                      {label}
                    </span>
                    <span role="cell" className="min-w-0">
                      {address ? (
                        <ExternalLink
                          href={addressUrl(address)}
                          srNote={false}
                          className="link num break-all text-[12.5px] text-ink sm:text-[13.5px]"
                        >
                          {address}
                        </ExternalLink>
                      ) : (
                        <span className="text-ink-3">not deployed</span>
                      )}
                    </span>
                    <span role="cell" className="min-w-0 text-ink-2">
                      {role}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          <p className="text-[13.5px] leading-[1.6] text-ink-3">
            Chain 4663 (Robinhood Chain), an Arbitrum Orbit L2. The clearinghouse is a deploy-time choice recorded in the
            vault (<code>clear()</code>); the two linked libraries (ValoremLib, SeaportOrderLib) are part of the vault&apos;s
            deployment and are verified with it.
          </p>
        </DocSection>

        <DocSection {...SECTIONS.roles}>
          <DocList>
            <li>
              <strong>Admin.</strong> Sets policy inside the bytecode caps, the deposit cap, the fee recipient; accepts
              the Valorem fee; lifts a halt. At launch this is one deployer key with no timelock, until the handover to
              a multisig; the deposit cap stays small for as long as that holds.
            </li>
            <li>
              <strong>Keeper (hot key).</strong> Creates the week&apos;s option type, arms it, authorises listings, cancels
              them, locks the book, closes the week. It can never move funds and never holds the option tokens; every
              contract is written inside a buyer&apos;s fill.
            </li>
            <li>
              <strong>Guardian (single key).</strong> Halts writes and kills listings. Nothing else.
            </li>
            <li>
              <strong>Anyone.</strong> Fills the order; closes a week an hour after expiry; settles the queue while the
              vault is Idle; retries a stranded claim.
            </li>
          </DocList>
        </DocSection>

        <div className={cn("mt-14", MEASURE)}>
          <p className="text-[15px] text-ink-3">
            Read <Link href="/legal" className={DOC_LINK}>the legal page</Link> for the Stock Token&apos;s legal form and the
            geographic restrictions.
          </p>
        </div>
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
 * The address ledger's header separator: a middle dot before a column label that sits on the same
 * line as the one before it (all three below 560px; only Role above, where Contract has its own column).
 */
const LEDGER_SEP = "before:mx-1.5 before:content-['·']";

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

/**
 * The week's steps: numbered circles joined by a rule, the landing's step track at reading size.
 * The number is a CSS counter, so the list stays a plain <ol> of <li> (role="list" keeps its
 * semantics in Safari, which drops them from a list-style:none list).
 */
function StepList({ children }: { children: ReactNode }) {
  return (
    <ol role="list" className="grid gap-6 [counter-reset:step]">
      {children}
    </ol>
  );
}

function Step({ children }: { children: ReactNode }) {
  return (
    <li
      className={cn(
        "relative pl-10 [counter-increment:step] sm:pl-12",
        "before:absolute before:left-0 before:top-0.5 before:grid before:size-[26px] before:place-items-center before:rounded-full before:border before:border-line-2 before:bg-surface before:font-mono before:text-[12px] before:font-semibold before:leading-none before:text-ink-2 before:content-[counter(step)] sm:before:top-0 sm:before:size-[30px] sm:before:text-[13px]",
        "after:absolute after:-bottom-4 after:left-[12.5px] after:top-[34px] after:w-px after:bg-line-2 last:after:hidden sm:after:left-[14.5px] sm:after:top-[38px]",
      )}
    >
      {children}
    </li>
  );
}

/** The risk list: a warning triangle per entry and a hairline between them, as on callhouse.finance. */
function RiskList({ children }: { children: ReactNode }) {
  return (
    <ul role="list" className="border-t border-line">
      {children}
    </ul>
  );
}

function RiskItem({ children }: { children: ReactNode }) {
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3.5 border-b border-line py-4 last:border-b-0 last:pb-0">
      <WarnIcon className="mt-[6px] text-warn" />
      <div>{children}</div>
    </li>
  );
}
