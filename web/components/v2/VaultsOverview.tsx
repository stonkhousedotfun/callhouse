"use client";

/**
 * /vaults — the one nav entry that used to be three (W5, plan gap 9 and §5.4).
 *
 * WHY THIS PAGE EXISTS. Earn, Lend and House are three deposit surfaces that differ in exactly the
 * way a depositor needs to know before choosing: WHAT GOES IN and WHEN IT COMES BACK OUT. The old
 * nav spent three of its eight slots asserting that difference without ever stating it; the nav
 * now has five entries, and this is the page behind the one Vaults entry. It states the difference
 * once, in the plan's own §5.1 terms, and links onward. The three routes are unchanged.
 *
 * NO FIGURES ARE SHOWN HERE, DELIBERATELY. An index that quotes a number has to source it, and the
 * three surfaces source theirs differently — House from settled epoch boundaries (never a live NAV:
 * houseEpoch.ts returns NAV_NOT_AVAILABLE mid-epoch), Earn per market from the indexer, Lend from a
 * vault that IS NOT DEPLOYED (lendTx.ts earnVaultAddress() returns a hardcoded null). Putting a
 * figure here would mean inventing one for Lend or special-casing it into silence. Each surface
 * shows its own numbers, with its own source and its own staleness.
 *
 * THE LEND ROW SAYS SO. The plan is explicit — "Plan for it; do not fake it" — so the row carries
 * its undeployed state as visible copy rather than an empty figure a reader would read as zero.
 */
import { HouseIndexCountdown, useHouseIndexOpen } from "@/components/v2/LaunchCountdown";
import { Button, PageHead, Panel } from "@/components/ui";

/** The plan's §5.1 table, as the rows a depositor chooses between. Lend is out of the launch set (owner 2026-09-22). */
const VAULTS = [
  {
    href: "/earn",
    name: "Earn",
    what: "Stock Tokens, or USDG for puts",
    deposits: "You write the option and name the premium yourself.",
    withdrawal: "Your free balance any time. Collateral is locked until the series settles.",
    cta: "Deposit",
    note: null,
    /** Earn is a user-written book; it does not wait on the house vault's arming. */
    armGated: false,
  },
  {
    href: "/house",
    name: "House",
    what: "Stock Tokens and USDG",
    deposits: "The quoting bot writes against the pool, inside limits set on chain. You can lose money.",
    withdrawal: "Once a week at the epoch boundary, after that week's series settle, paid in kind.",
    cta: "Deposit",
    note: null,
    /** House deposits wait for `protocolAccountsConfirmed` — see LaunchCountdown.tsx. */
    armGated: true,
  },
] as const;

/**
 * HOUSE DEPOSITS ARE HELD SHUT UNTIL THE VAULT IS ARMED (owner, 2026-09-22). The six
 * `setProtocolAccount(addr, blocked = true)` calls sit behind a 24 h CONFIG_ADMIN delay; the first execute
 * flips `protocolAccountsConfirmed` and with it the vault's ability to quote. The contract would accept a
 * deposit before that — quoting and deposits are separate — so nothing on chain stops a depositor buying
 * into a vault that quotes nothing and cannot tell from the form. The app is the thing that tells them, so
 * the CTA is a disabled button (not a link) with the chain's own clock next to it.
 */
export function VaultsOverview() {
  const houseOpen = useHouseIndexOpen();
  return <>
    <PageHead
      eyebrow="Vaults"
      title="Two ways to put assets to work."
      lede="They differ in what you deposit and when you can take it back out. Read both columns before you choose." />
    <div className="grid gap-4 lg:grid-cols-2">
      {VAULTS.map((vault) => <Panel key={vault.href} as="article" className="flex flex-col">
        <h2 className="font-display text-2xl font-bold">{vault.name}</h2>
        <p className="mt-1 text-sm text-ink-2">{vault.deposits}</p>
        <dl className="mt-5 grid gap-3 border-t border-line pt-4 text-sm">
          <div><dt className="text-ink-3">You deposit</dt><dd className="mt-1 font-semibold">{vault.what}</dd></div>
          <div><dt className="text-ink-3">You can withdraw</dt><dd className="mt-1 font-semibold">{vault.withdrawal}</dd></div>
        </dl>
        {vault.note ? <p className="mt-4 text-sm text-ink-3">{vault.note}</p> : null}
        {vault.armGated && !houseOpen
          // A disabled <button>, deliberately not a faded <a>: a link stays clickable and would land the
          // reader on a deposit form the app has just said is shut.
          ? <Button size="sm" disabled className="mt-5 w-full">{vault.cta} — opens when quoting starts</Button>
          : <Button href={vault.href} size="sm" className="mt-5 w-full">{vault.cta}</Button>}
        {vault.armGated ? <HouseIndexCountdown /> : null}
      </Panel>)}
    </div>
  </>;
}
