/**
 * The in-app docs: the weekly cycle in one page, what it costs, and the risk list.
 *
 * This page is a condensation, not the source of truth. The canonical documents are
 * docs/ARCHITECTURE.md at the repo root, contracts/README.md, contracts/SECURITY.md and
 * contracts/docs/ACCOUNTING.md (the contracts submodule, leekzor/callhouse-contracts) and the
 * operator material in ops/runbooks/. Where this page and those disagree, this page is the one
 * that is wrong.
 *
 * Live values quoted below (policy, cap, fee, role holders, verification) were read on chain and
 * on Sourcify on 2026-09-15. The admin can change the parameters at any time; when it does, this
 * page must change with them.
 */
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { CardTitle, ExternalLink, PageHead, Panel, WarnIcon } from "@/components/ui";
import { addressUrl } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { ASSET, CLEARINGHOUSE, MARKET, SEAPORT, SHARE_TICKER, USDG, VAULT } from "@/lib/contracts";

export const metadata: Metadata = {
  title: "Docs — Stonkhouse",
  description: "How the weekly covered-call cycle works, what it costs, and everything that can go wrong.",
};

const ADDRESSES: Array<[string, string | undefined, string]> = [
  [
    "Stonkhouse vault",
    VAULT,
    "shares, deposits, the queue, the phase machine; the offerer and the zone of every listing. Its on-chain name, “Callhouse NVDA” (cNVDA), predates the rename",
  ],
  ["NVDA Stock Token", ASSET, "the collateral, 18 decimals"],
  ["USDG", USDG, "premium and strike currency, 6 decimals"],
  [
    "Valorem Clear",
    CLEARINGHOUSE,
    "holds the option types and the calls; the vault writes into it at each fill, holders exercise on it, and the vault redeems its claim from it",
  ],
  ["Seaport 1.6", SEAPORT, "the fill venue; the vault validates its order on chain and answers Seaport's zone hooks"],
];

/** Role holders and the Clear's fee switch, read on chain on 2026-09-15 (hasRole, feeRecipient, feeTo). */
const ADMIN_KEY = "0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b";
const KEEPER_KEY = "0x06c131cfEd73A56893f5eB52D17252856FAFC1d2";
const GUARDIAN_KEY = "0x29741A8d283a253E8Ce10aDfd04C6507438b6F39";
const CLEAR_FEE_SAFE = "0xff1454009F024507f3E455eb2027E98fAF4ccF61";
/** The vault's `clear()`, read on chain on 2026-09-15. Fixed at deployment, so it cannot change. */
const LIVE_CLEAR = "0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6";

/**
 * The page's h2s, in render order. The section list and the headings both read from here, so the
 * two cannot drift.
 */
const SECTIONS = {
  product: { id: "product-in-one-paragraph", title: "The product in one paragraph" },
  week: { id: "week-step-by-step", title: "A week, step by step" },
  exercise: { id: "exercising-a-call", title: "Exercising a call you bought" },
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
              the window itself; the vault then authorises one Seaport order for it, and this site&apos;s{" "}
              <Link href="/vault/nvda/cycle" className={DOC_LINK}>cycle page</Link> is where the order is sold. Nothing is written when the
              week opens: every fill writes exactly the contracts it buys, inside the buyer&apos;s transaction, so the vault
              never holds an unsold call and can never be assigned on more than it was paid for. After expiry{" "}
              <code>rollClose</code> redeems the vault&apos;s claim: an unexercised call returns the collateral, an exercised
              one returns the strike in USDG instead. 5% of the premium goes to the fee recipient; the rest of the premium,
              and any strike USDG in full, becomes claimable pro rata. There is no protocol token.
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
              at the NYSE close on the cycle&apos;s Friday (4:00pm New York, which is 8:00pm UTC in daylight time and 9:00pm
              UTC from November; the Thursday before a Friday market holiday) and an expiry 24 hours later. The cycle page
              prints those two instants from the chain, in UTC and on the New York clock.
            </Step>
            <Step>
              <strong>Arm.</strong> <code>rollOpen(optionId)</code> reads the type back from the clearinghouse and
              refuses it unless the underlying is this vault&apos;s asset, the exercise asset is USDG, the lot is exactly one
              token, the exercise time is at least an hour out, the window at least a day and the expiry at most 21 days
              out, Valorem&apos;s fee is off or accepted, the feed is fresh and the oracle not paused, and the strike sits
              inside the vault&apos;s out-of-the-money band, both bounds (3% to 12% above spot under today&apos;s policy). It
              writes nothing. There is no registry.
            </Step>
            <Step>
              <strong>List.</strong> <code>approveListing</code> checks the keeper&apos;s Seaport order field by field —
              the vault is offerer and zone, PARTIAL_RESTRICTED, one ERC-1155 offer of the armed id sized at most to the
              vault&apos;s capacity, one USDG leg to the vault that divides by the size, the unit price at or below the
              strike, an end time at or before the exercise time — then validates it on Seaport, so the order needs no
              signature. At most three listings a cycle, cancelled or not: a relist is a reprice. The keeper prices a new
              week from Cboe&apos;s free, delayed {MARKET} option quotes: a strike near 0.15 delta, kept 5% to 11.5% above
              spot under today&apos;s policy, and an ask that is the larger of the vault&apos;s premium floor raised by 0.5%
              of itself (a 50 bps margin on the floor, not on spot) and the quoted fair value plus 10%, never above the
              strike. If the quotes are missing, stale or
              inconsistent when a week opens, the keeper skips that week. The cycle page shows the inputs the keeper
              reports; the chain cannot check them.
            </Step>
            <Step>
              <strong>Fill, and write.</strong> A buyer fills k of N on the cycle page (or with any Seaport 1.6 client,
              from the order the page lets you copy). Seaport calls the vault&apos;s <code>authorizeOrder</code> before
              moving anything; the vault re-checks its gate at the feed&apos;s current price — the strike still at or above
              the band floor, the premium at or above its floor (0.10% of spot per contract today, plus Valorem&apos;s fee
              valued at spot when it is on), the total size within capacity, the sale window still open, the feed fresh
              and the oracle not paused, writes not halted — and writes exactly k contracts into Valorem. Seaport moves
              them to the buyer and the USDG to the vault; <code>validateOrder</code> reverts the fill unless no token
              stayed behind.
            </Step>
            <Step>
              <strong>Sale window closes, exercise opens.</strong> From the option&apos;s exercise time the hook refuses
              every fill and deposits close (<code>maxDeposit() == 0</code>), whether or not anyone calls{" "}
              <code>lockBook</code>. From then until expiry a holder can exercise on the Clear (next section). Valorem
              assigns the exercise to writers of the option id inside the holder&apos;s own transaction, and when that
              reaches the vault&apos;s claim the share price falls there and then.
            </Step>
            <Step>
              <strong>Expiry, then settle.</strong> <code>rollClose</code> redeems the Valorem claim, harvests the USDG,
              settles the redemption queue and returns the vault to Idle. The keeper can call it from expiry; anyone can
              call it an hour later, so a dead keeper cannot strand the week. If Valorem&apos;s redeem reverts (in an assigned
              week a USDG pause or freeze; in a week not fully assigned a Stock Token pause or blocklist) the vault still goes to Idle with the claim kept: the stranded state,
              below.
            </Step>
          </StepList>
        </DocSection>

        <DocSection {...SECTIONS.exercise}>
          <p>
            A call bought on the cycle page is an ERC-1155 token on the Valorem Clear whose id is the vault&apos;s{" "}
            <code>optionId()</code>. Each one is the right to buy one {MARKET} Stock Token for the week&apos;s strike in
            USDG, from the option&apos;s exercise time until its expiry: the Clear accepts an exercise only while{" "}
            <code>exerciseTimestamp ≤ now &lt; expiryTimestamp</code>. Nothing is exercised automatically, and a call
            that is not exercised before expiry is worthless.
          </p>
          <DocList>
            <li>
              <strong>The Exercise card.</strong> On the <Link href="/vault/nvda/cycle" className={DOC_LINK}>cycle page</Link>,
              a connected wallet that holds this week&apos;s option sees an Exercise card: its option balance, the strike,
              the {MARKET} received per contract, and the exact USDG totals. You pick a number of contracts, up to your
              balance.
            </li>
            <li>
              <strong>When it works.</strong> The Exercise button is enabled only inside the exercise window, judged by
              the timestamp of the chain&apos;s latest block, the clock the Clear uses. That block can trail the chain by one
              block interval, so right at expiry the button can stay on a moment too long; the simulation run just
              before sending catches that, and a refused exercise moves no tokens. Before the window the card shows when
              exercise opens, in UTC and Eastern time. After expiry it says the options expired, but only until the week
              is closed: <code>rollClose</code> clears the vault&apos;s <code>optionId()</code>, and from then on the card
              no longer appears.
            </li>
            <li>
              <strong>What it sends.</strong> If the wallet&apos;s USDG allowance to the Clear is below the total (the
              strike cost, plus Valorem&apos;s fee if that switch is ever turned on), first an approval of exactly that
              total; an allowance that already covers it is left as it is. Then <code>exercise(optionId, amount)</code>. In the exercise
              transaction the Clear burns your calls, takes the USDG and sends you the {MARKET}. The card simulates it
              first and shows the revert reason if it would fail.
            </li>
            <li>
              <strong>Out of the money.</strong> The card compares the vault&apos;s feed price with the total cost: the
              strike, plus Valorem&apos;s fee when it is on. When the {MARKET} received is worth no more than that total,
              or when the feed cannot be read (<code>spotUsdg()</code> reverts once the price is older than{" "}
              <code>maxPriceAge</code>), it warns you and asks for explicit confirmation, because exercising may then
              cost at least as much as the {MARKET} is worth. The feed price can be up to four days old today, so check
              the market yourself. The Clear itself never checks this.
            </li>
            <li>
              <strong>Without this site.</strong> From the wallet holding the calls, approve the vault&apos;s Clear (the
              address the vault&apos;s <code>clear()</code> returns, <Addr address={LIVE_CLEAR} />) to spend at least strike × amount
              USDG (plus the fee, if it is on), then call{" "}
              <code>exercise(uint256 optionId, uint112 amount)</code> on it. It reverts <code>ExerciseTooEarly</code> before
              the exercise time, <code>ExpiredOption</code> from expiry, and <code>CallerHoldsInsufficientOptions</code>{" "}
              above your balance.
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.costs}>
          <DocList>
            <li>
              <strong>Stonkhouse: 5% of the premium.</strong> <code>protocolFeeBps</code> is 500 today; the admin can
              change it with <code>setPolicy</code>, up to 2,000 (20%), and the rate in force when premium is harvested is
              the one applied, including to premium that arrived earlier that week. It is paid to the vault&apos;s{" "}
              <code>feeRecipient</code>, today the admin key (see Roles). Strike proceeds from an assignment carry no fee:
              they are your collateral sold at the strike, not income. An unfilled week costs nothing because nothing was
              collected. There is no third-party venue fee: the listing has one payment leg, to the vault, and the buyer
              pays exactly the unit price.
            </li>
            <li>
              <strong>Valorem: 15 bps, currently off.</strong> When switched on, the Clear charges 15 bps to the writer on
              the {MARKET} written and to the exerciser on the strike USDG paid. The switch belongs to the Clear&apos;s{" "}
              <code>feeTo</code>, a Safe with one owner and a threshold of one (
              <Addr address={CLEAR_FEE_SAFE} />
              ), not to the vault. If it is turned on, the vault refuses to arm or sell until the admin explicitly accepts
              the fee, and while accepted the fill hook adds the fee, valued at spot, to the premium floor a buyer must
              clear. 15 bps is more than today&apos;s 0.10% premium floor. An exerciser pays it whether or not the vault
              accepted it.
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
              earned — and vice versa. Premium from a fill sits in the vault from the moment of the fill but becomes
              claimable only when it is harvested: at the next deposit, <code>settleQueue</code>, <code>rollClose</code>{" "}
              or <code>retryStrandedClaim</code>. Claiming does not harvest.
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
              <strong>The short call is never marked to market.</strong> USDG never moves the share price. It moves when
              an exercise assigns collateral away, and otherwise only when Stock Tokens reach or leave the vault other
              than through a deposit or a redemption, such as an issuer burn.
            </li>
            <li>
              We do not publish an APY, an APR or any annualised figure, and there is no price chart on this site.{/* copy-lint-allow */}
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.queue}>
          <DocList>
            <li>
              Deposits are accepted while the vault is Idle or Listed, up to the deposit cap, 20 {MARKET} today, measured
              on <code>totalAssets()</code> (<code>DepositCapExceeded</code>). The admin sets the cap with no bound, so it
              can also close deposits by setting it to zero. Deposits are closed by one gate (<code>DepositsClosed</code>,{" "}
              <code>maxDeposit() == 0</code>) from the moment the sale window closes, while a week settles, while a
              contract is assigned and its claim not yet redeemed, while a claim is stranded, while an issuer burn has
              left the reserve unbacked, or while the book is worth less than a millionth of a token per share.
              The deposit form says which.
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
              when <code>rollClose</code> closes the week the epoch is settled into a pot of collateral and USDG and
              you draw a pro-rata slice with <code>completeRedeem</code>. A queue entry cannot be cancelled, and escrowed
              shares stay exposed to the week&apos;s result until their epoch settles.
            </li>
            <li>
              A queue entry made while the vault is Idle does not have to wait for the next week to be
              armed. Anyone can call <code>settleQueue</code> while the vault is Idle; it settles the
              current epoch pro rata on the vault&apos;s idle collateral, which is the price an instant redemption would
              pay while nothing is written. While a claim is stranded (when instant redemption is off) the epoch also
              takes a pro-rata share of that claim, paid when it is redeemed. <code>completeRedeem</code> then pays it
              out.
            </li>
            <li>
              A queued redemption is never a promise of a fixed number of tokens. If the week was
              assigned, part of your payout arrives as USDG at the strike. The Stock Token leg is paid whatever USDG is
              doing; the USDG leg may be deferred if USDG cannot move, and stays owed until a later{" "}
              <code>completeRedeem</code> can pay it.
            </li>
            <li>
              Halting writes never blocks a deposit, a redemption, a claim, or the close of a week. It blocks arming,
              listing and selling a call (<code>rollOpen</code>, <code>approveListing</code> and every fill), and nothing
              else.
            </li>
          </DocList>
        </DocSection>

        <DocSection {...SECTIONS.stranded}>
          <p>
            <code>rollClose</code> redeems the week&apos;s Valorem claim, and Valorem pushes USDG and then {MARKET} to the
            vault in one call. Valorem skips a leg with nothing to send, so either token&apos;s issuer can make that revert
            only when its leg is due: in a week with any assignment, USDG paused or the vault or the clearinghouse
            frozen on USDG; in a week that was not fully assigned, the Stock Token paused or the vault blocklisted on
            it. Rather than
            hold every unit of idle collateral and the whole queue hostage to a stablecoin action, the vault goes to Idle
            anyway and keeps the claim. While it is stranded: deposits are refused and instant redemption is off (nobody
            buys in or leaves at a NAV that cannot yet see the claim&apos;s USDG); no new week can be armed; the queue keeps
            settling on the idle balance, and every epoch that settles takes a pro-rata share of the claim, paid when it
            is redeemed. Anyone can call <code>retryStrandedClaim</code> for as long as the claim is stranded; it fails
            harmlessly while the cause persists and settles the claim the first time Valorem lets it through. The pages
            show a banner with your pending share and a Retry button whenever this state holds.
          </p>
        </DocSection>

        <DocSection {...SECTIONS.risks}>
          <p className="text-[15px] text-ink-3">
            Read these before depositing.
          </p>
          <RiskList>
            <RiskItem>
              <strong>No buyer.</strong> The most likely failure mode, and an economic one rather than a
              technical one. The week&apos;s premium is zero. The mitigation is transparency:{" "}
              <Link href="/vault/nvda/cycle" className={DOC_LINK}>the cycle page</Link> publishes the order so anyone can buy
              it, and the zero is published as a row.
            </RiskItem>
            <RiskItem>
              <strong>A fill refused after a rally.</strong> The vault re-checks its floors at every fill against the
              feed&apos;s current price. If {MARKET} rallies after the week is armed, a strike that was in the band when the
              week opened can fall below the band floor, and the vault refuses to sell it (<code>StrikeBelowBand</code>).
              The strike is fixed for the week, so only a fall in spot reopens the sale. A premium that has fallen below
              the floor at the new spot (<code>PremiumBelowFloorAtFill</code>) can be fixed by a reprice, within the
              cycle&apos;s three listings. Both protect depositors from selling a near-the-money call for an out-of-the-money
              premium; both can also mean an unfilled week.
            </RiskItem>
            <RiskItem>
              <strong>Assignment.</strong> An exercised call takes the collateral at the strike. Upside
              above it is gone for that week and the vault can end the week holding USDG instead of
              tokens. v1 does not automatically buy the token back. Because every contract the vault wrote was sold, it
              is never assigned on more than it was paid for.
            </RiskItem>
            <RiskItem>
              <strong>Partial assignment.</strong> Valorem assigns bucket by bucket, pro rata by amount written within a
              bucket, across every writer of the option id, so the vault can be assigned on some contracts and not
              others.
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
              <strong>Valorem fee switch.</strong> 15 bps, currently off. The Clear&apos;s <code>feeTo</code> Safe can turn it
              on at any time; the vault then stops arming and selling until the admin accepts it, and exercisers pay it
              regardless.
            </RiskItem>
            <RiskItem>
              <strong>Admin misconfiguration.</strong> The policy bounds live in bytecode (<code>Policy.validate</code>): a
              strike band starting at least 1% and ending at most 25% above spot, a premium floor of at least 0.10% of
              spot per contract, utilization at most 99.85%, a protocol fee at most 20%. So an admin cannot sell a call
              whose strike is less than 1% above the feed&apos;s price. That price can be up to <code>maxPriceAge</code>{" "}
              old (seven days at most), so after a rally such a strike can be at or in the money against the market.
              Within those bounds they can still set the knobs badly; the deposit cap has no bound, and the per-cycle
              contract cap no upper bound. Every change applies at once, mid-week included. The
              premium floor is at its compiled minimum today (<code>minPremiumBps</code> 10); the admin can raise it.
            </RiskItem>
            <RiskItem>
              <strong>Keeper or admin compromise.</strong> The vault checks every field of every order and sizes every
              fill itself, and no function lets the keeper or the admin withdraw the vault&apos;s collateral. A compromised keeper
              can still sell cheaply inside today&apos;s policy, to itself if it likes: a strike as close as 3% above spot,
              a premium as low as 0.10% of spot per contract, on up to 95% of the collateral and at most 50 contracts a
              cycle, until the guardian halts writes. The caps are per cycle, not per week: the vault accepts an
              exercise time one hour after arming and an expiry one day after that, and the keeper can close a cycle at
              expiry and arm the next at once, so a compromised keeper could run a new cycle about every 25 hours. A compromised admin can grant itself the keeper role and do the same
              with the policy loosened to its bytecode bounds, raise the fee to 20% of premium and send it anywhere, or
              let the vault sell on a price up to 7 days old.
            </RiskItem>
            <RiskItem>
              <strong>Keeper failure mid-week.</strong> From expiry only the keeper can close the week. An hour later{" "}
              <code>rollClose</code> is open to anyone, the guardian and the admin included. Locking the book, settling
              the queue and retrying a stranded claim are permissionless too. A live listing can still be filled without
              the keeper, but the cycle page gets the order from the keeper and cannot offer it while the keeper is down.
            </RiskItem>
            <RiskItem>
              <strong>Sequencer or feed outage into the sale window.</strong> The vault refuses to arm, list or sell when
              the RHNVDA/USD feed is older than <code>maxPriceAge</code> (<code>StalePrice</code>; 345,600 seconds, four
              days, today, and the admin can set it anywhere from one hour to seven days) or when the Stock Token&apos;s
              oracle is paused. Inside that limit a fill checks its floors against the feed&apos;s last posted price, however
              old: up to four days today. There is no
              sequencer-uptime check. Nothing watches this for you: the keeper keeps its alerts in its own log and
              delivers none.
            </RiskItem>
            <RiskItem>
              <strong>This vault is unaudited.</strong> The Stonkhouse vault and its libraries have had no external audit.
              The project&apos;s own internal reviews and its test suite are the whole gate; the latest review, on
              2026-09-14, reported no critical, high or medium findings, and its one low finding is fixed. Valorem&apos;s repository, at the
              commit the Clear deployed here is built from (valorem-core 6436c823, November 2023), carries a March 2022
              review, Zellic audit reports from December 2022 and April 2023, and a Zellic patch review from August 2023,
              all older than that commit. There is no bug bounty; report a vulnerability to{" "}
              <a href="mailto:security@stonkhouse.fun" className={DOC_LINK}>security@stonkhouse.fun</a>. Treat the
              deposit cap as the real statement of confidence.
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
                        <span className="text-ink-3">not configured in this build</span>
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
            Chain 4663 (Robinhood Chain), an Arbitrum chain. The clearinghouse is fixed when the vault is deployed and
            recorded in it (<code>clear()</code>). The vault and its two linked libraries (ValoremLib, SeaportOrderLib)
            are verified on Sourcify as a partial match (Sourcify&apos;s &ldquo;match&rdquo;, not
            &ldquo;exact_match&rdquo;): the bytecode matches the published source, but the contracts were compiled
            without an embedded metadata hash, so Sourcify cannot confirm the exact metadata. For the vault both the
            creation and the runtime bytecode matched; for the libraries only the runtime bytecode was matched. The Clear is not source-verified; its runtime bytecode is identical, apart from the metadata
            hash, to a Sourcify-verified deployment of Valorem&apos;s published clearinghouse source (valorem-core
            6436c823).
          </p>
        </DocSection>

        <DocSection {...SECTIONS.roles}>
          <DocList>
            <li>
              <strong>Admin.</strong> Sets policy inside the bytecode caps, the deposit cap, the fee recipient and the
              price-age limit; accepts the Valorem fee; halts writes and lifts a halt; grants and revokes every role. Today
              this is one hot key, <Addr address={ADMIN_KEY} />, the address that deployed the vault, with no timelock,
              and it is also the fee recipient. A handover of the admin role to a multisig is planned and has not
              happened.
            </li>
            <li>
              <strong>Keeper (hot key).</strong> Held today by <Addr address={KEEPER_KEY} />. Creates the week&apos;s
              option type, arms it, authorises listings, cancels them, locks the book, closes the week. It cannot change
              parameters or halt, has no withdrawal function, and never holds the option tokens; every contract is
              written inside a buyer&apos;s fill.
            </li>
            <li>
              <strong>Guardian (single key).</strong> Held today by <Addr address={GUARDIAN_KEY} />. Halts writes and
              kills listings. Nothing else: only the admin can lift a halt.
            </li>
            <li>
              <strong>Anyone.</strong> Fills the order; exercises a call it holds; locks the book from the exercise time;
              closes a week an hour after expiry; settles the queue while the vault is Idle; retries a stranded claim;
              pushes the accrued fee to the fee recipient (<code>sweepFee</code>).
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

/** A role holder's address, linked to the explorer. */
function Addr({ address }: { address: string }) {
  return (
    <ExternalLink href={addressUrl(address)} srNote={false} className="link num break-all text-[0.9em] text-ink">
      {address}
    </ExternalLink>
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

/** The risk list: a warning triangle per entry and a hairline between them, as on stonkhouse.fun. */
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
