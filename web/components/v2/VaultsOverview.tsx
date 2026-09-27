"use client";

/**
 * /vaults — the one nav entry that used to be three.
 *
 * WHY THIS PAGE EXISTS. The two vaults differ in exactly the way a depositor needs to know before choosing: WHAT
 * GOES IN and WHEN IT COMES BACK OUT. This is the page behind the nav's one Vaults entry. It states the difference
 * once, in the same terms, and links onward.
 *
 * THE TWO VAULTS: Earn is the EarnVault, where you deposit USDG
 * and it is lent out for interest (lending-only at launch, the page is /earn, which was the hidden
 * /lend), and House. Selling options on your own Stock Tokens is not a vault: it moved to /sell ("Sell options") and
 * is linked from the market pages, not from here.
 *
 * NO FIGURES ARE SHOWN HERE, DELIBERATELY. An index that quotes a number has to source it, and the two vaults source
 * theirs differently: House from settled epoch boundaries (never a live NAV: houseEpoch.ts returns NAV_NOT_AVAILABLE
 * mid-epoch), Earn from its own on-chain reads and the indexer's realised interest (LendVault.tsx, lib/v2/lendApy.ts).
 * Each vault's page shows its own numbers, with its own source and its own staleness. There is no clock either
 * the House card's open/shut state is the chain's arming read (lib/v2/launchGates.ts), with no launch
 * moment to count down to. The Earn card's pill follows whether this build resolves the vault's address from the
 * registry (lendTx.earnVaultAddress()).
 *
 * THE NEON LOOK (the Vaults screen, night and day): "Be the
 * house." over two cards, each with its status pill, what it is, and the facts a depositor compares down the card.
 * Before the House vault quotes (spec 8.1), the House card says which vault is not quoting yet and Deposit is a
 * disabled button that says why. The House withdrawal line follows the listed vaults' kind (v2/house
 * `kind`), not the mockup's fixed "weekly": one cadence when every vault shares it, both named otherwise.
 */
import { HOUSE_ARMING_UNREAD, useHouseIndexGate } from "@/components/v2/LaunchCountdown";
import { TIP_CONTAIN } from "@/components/v2/house/tipContain";
import { Button, InfoTip, PageHead, Panel, StatusPill } from "@/components/ui";
import type { HouseVaultKind } from "@/lib/v2/api-types";
import { useHouse } from "@/lib/v2/hooks";
import { houseKindsOpenForDeposit } from "@/lib/v2/houseWindDown";
import { earnVaultAddress } from "@/lib/v2/lendTx";

type VaultFact = { term: string; value: string };

/**
 * The card detail that used to sit on the cards, now behind each card's "?". Also:
 * Earn is the USDG lending vault; the risk sentence is LendVault.tsx's LEND_RISK_TIP, said the same way.
 */
export const EARN_CARD_TIP =
  "Your USDG goes into the Earn vault, which lends it out for interest. At launch it only lends. A loss at the lending venue falls on every depositor, in proportion.";
export const HOUSE_CARD_TIP =
  "Our bot quotes options on the order book with the pool's money, inside limits set on chain. Withdrawals are paid at the close, in kind: your share of the vault's USDG and its stock.";

/** The House withdrawal fact for the vaults the index stands for. Unknown or mixed kinds name both cadences. */
export function houseIndexWithdrawal(kinds: readonly (HouseVaultKind | undefined)[]): string {
  const known = kinds.length > 0 && kinds.every((kind) => kind === kinds[0]) ? kinds[0] : undefined;
  // short. "Paid in kind" is explained in the card's tip (HOUSE_CARD_TIP), not here.
  if (known === "daily") return "Daily, at the 4:00 pm ET close";
  if (known === "weekly") return "Weekly, at the week's last 4:00 pm ET close";
  // A House vault is weekly or daily; with no kind read, or kinds that differ, the
  // index covers both, so it names both.
  return "At the vault's close: once a day, or once a week for a weekly vault";
}

/**
 * The summary table for the Earn vault: what goes in, where the yield comes from, and how it comes out.
 * The withdrawal line is LendVault.tsx's LEND_QUEUE_FLAT in short: the vault pays now when the lending venue can, and
 * otherwise queues the request and pays in order.
 */
export const EARN_FACTS: readonly VaultFact[] = [
  { term: "You deposit", value: "USDG" },
  { term: "Your yield", value: "Interest from lending it out" },
  { term: "You can withdraw", value: "Now if the venue can pay; otherwise in the vault's queue, in order" },
];

export function houseFacts(withdrawal: string): readonly VaultFact[] {
  return [
    { term: "You deposit", value: "Stock Tokens and USDG" },
    { term: "Your yield", value: "What the bot's option trades make, or lose" },
    { term: "You can withdraw", value: withdrawal },
  ];
}

function Facts({ facts }: { facts: readonly VaultFact[] }) {
  return <dl className="mt-5 grid rounded-md border border-line bg-field px-4 text-[14.5px]">
    {facts.map((fact) => <div key={fact.term} className="grid gap-0.5 border-b border-line py-3 last:border-b-0 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-ink-3">{fact.term}</dt>
      <dd className="font-semibold text-ink">{fact.value}</dd>
    </div>)}
  </dl>;
}

function VaultIcon({ kind }: { kind: "earn" | "house" }) {
  return <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {kind === "earn"
        ? <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" /><path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" /></>
        : <><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9.5h13V10" /><path d="M10 19.5V14h4v5.5" /></>}
    </svg>
  </span>;
}

function CardHead({ kind, name, status }: { kind: "earn" | "house"; name: string; status: "live" | "soon" }) {
  return <div className="flex items-center gap-3.5">
    <VaultIcon kind={kind} />
    <h2 className="min-w-0 flex-1 font-display text-[22px] font-extrabold tracking-[-0.02em]">{name}</h2>
    <StatusPill status={status} />
  </div>;
}

/** The pre-quoting line (spec 8.1) for the launch markets whose House vault is not armed yet. Static: no time is promised. */
export function houseIndexNotQuoting(pending: readonly string[]): string {
  const names = pending.join(" and ");
  return pending.length === 1
    ? `The ${names} house vault is not quoting yet. Deposits open when it is.`
    : `The ${names} house vaults are not quoting yet. Deposits open when they are.`;
}

/** Shown under a shut House card whenever the arming read failed. */
export const GATES_UNREAD = HOUSE_ARMING_UNREAD;

/**
 * The page, from its inputs. Split from the hooks so every state renders in a node test: `houseOpen` false covers
 * gates unread and gates pending alike, which both hold the House deposit shut (fail closed).
 */
export function VaultsIndex({ houseOpen, pending, gatesError, houseKinds, earnLive = false }: {
  houseOpen: boolean;
  /** Launch markets whose House vault is not armed; null while the gates are unread. */
  pending: readonly string[] | null;
  gatesError: boolean;
  houseKinds: readonly (HouseVaultKind | undefined)[];
  /** This build resolves the Earn vault's address. Unknown is "soon", never a Live pill. */
  earnLive?: boolean;
}) {
  return <div className={`relative min-w-0 ${TIP_CONTAIN}`}>
    <PageHead eyebrow="Vaults" title="Be the house."
      lede="Two vaults. They differ in what you deposit and when you can take it out." />
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel as="article" className="flex flex-col" data-vault="earn">
        <CardHead kind="earn" name="Earn" status={earnLive ? "live" : "soon"} />
        <p className="mt-4 text-[15px] text-ink-2">Deposit USDG. It&apos;s lent out for interest. <InfoTip label="About Earn" text={EARN_CARD_TIP} /></p>
        <Facts facts={EARN_FACTS} />
        <div className="mt-auto pt-5"><Button href="/earn" className="w-full">Deposit</Button></div>
      </Panel>
      <Panel as="article" className="flex flex-col" data-vault="house">
        <CardHead kind="house" name="House" status={houseOpen ? "live" : "soon"} />
        <p className="mt-4 text-[15px] text-ink-2">A bot trades the pool. You can lose money. <InfoTip label="About the House vault" text={HOUSE_CARD_TIP} /></p>
        <Facts facts={houseFacts(houseIndexWithdrawal(houseKinds))} />
        {!houseOpen && pending?.length ? <p data-slot="house-not-quoting" className="mt-4 rounded-md bg-warn-soft px-3.5 py-2.5 text-[13.5px] text-ink-2">{houseIndexNotQuoting(pending)}</p> : null}
        {!houseOpen && gatesError ? <p className="mt-3 text-[13px] text-ink-3">{GATES_UNREAD}</p> : null}
        <div className="mt-auto pt-5">
          {houseOpen
            ? <Button href="/house" className="w-full">Deposit</Button>
            // A disabled <button>, deliberately not a faded <a>: a link stays clickable and would land the
            // reader on a deposit form the app has just said is shut.
            : <Button disabled className="w-full">Deposit opens when quoting starts</Button>}
        </div>
      </Panel>
    </div>
  </div>;
}

/**
 * HOUSE DEPOSITS ARE HELD SHUT UNTIL THE VAULT IS ARMED. `setProtocolAccount(addr, blocked = true)`
 * flips `protocolAccountsConfirmed` and with it the vault's ability to quote; the zero-delay redeploy does that inside
 * the deploy window, and a vault created later does it whenever the Admin Safe's call lands. The contract would accept
 * a deposit before that -- quoting and deposits are separate -- so nothing on chain stops a depositor buying into a
 * vault that quotes nothing and cannot tell from the form. The app is the thing that tells them, so the CTA is a
 * disabled button (not a link) until the arming is read back true for every launch vault.
 */
export function VaultsOverview() {
  const gate = useHouseIndexGate();
  const house = useHouse();
  const kinds = house.isError ? [] : (house.data?.items ?? []).filter((item) => item.vault).map((item) => item.kind);
  // A weekly vault winding down (a daily one is listed) takes no deposits, so the card states the cadence of
  // the vaults a depositor can still choose -- daily -- rather than naming both.
  return <VaultsIndex houseOpen={gate.open} pending={gate.pending} gatesError={gate.isError} houseKinds={houseKindsOpenForDeposit(kinds)}
    earnLive={earnVaultAddress() !== null} />;
}
