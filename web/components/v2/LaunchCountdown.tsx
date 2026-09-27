"use client";

/**
 * The launch gates' UI: the faded-out wrapper for a market that is registered but not enabled, and the House notice
 * that says deposits are shut until a vault quotes. Both are driven by chain facts (lib/v2/launchGates.ts and the
 * per-vault arming read in lib/v2/chainReads.ts) and neither shows a clock.
 *
 * NO COUNTDOWN. This file used to tick a clock down to the live v8 launch's scheduled Safe operations. The
 * zero-delay redeploy enables the markets and arms the House vaults inside the deploy window, so there is no launch
 * moment to count down to. What is left is static copy over the same fail-closed rules: a control stays off while
 * its chain fact is unread, errored or false. The file keeps its name so its importers need no edit.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { pendingHouseMarkets, readLaunchGates, type LaunchGates } from "@/lib/v2/launchGates";

const LAUNCH_GATES_KEY = ["v2", "launchGates"] as const;

/** `market.enabled` and the registry vaults' arming for every launch market; refetched every 15 s. */
export function useLaunchGates() {
  return useQuery<LaunchGates, Error>({
    queryKey: LAUNCH_GATES_KEY,
    queryFn: () => readLaunchGates(),
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

/** Shown when the enabled read failed: the controls stay off, and the reader is told why. */
export const TRADING_UNREAD = "Could not check whether trading is open. The buttons stay off until we can.";

/**
 * The market page while its market is registered but not enabled: the whole page renders, every control in it is
 * disabled by the fieldset (native buttons and inputs; the design system's Button is a <button>) and faded, and one
 * static line says why. Links still work: the page is readable, not usable.
 */
export function LockedMarket({ ticker, children }: { ticker: string; children: ReactNode }) {
  const gates = useLaunchGates();
  return <>
    <section aria-label={`${ticker} trading status`} className="mb-6 rounded-lg border border-line-2 bg-surface p-6 text-center">
      {/* Defence in depth after the 2026-09-22 indexer-veto bug: if this ever renders while the chain says trading is
          on, the headline must not contradict the chain. */}
      <p className="font-display text-xl font-bold">
        {gates.data?.trading[ticker] === true
          ? `${ticker} trading is open. This page is catching up.`
          : `${ticker} is listed. Trading is not open yet.`}
      </p>
      <p className="mt-3 text-sm text-ink-2">
        {gates.isError ? TRADING_UNREAD
          : "The buttons below stay off until it opens."}
      </p>
    </section>
    <fieldset disabled aria-disabled="true" aria-label={`${ticker} market controls, not open yet`}
      className="min-w-0 border-0 p-0 opacity-50 [&_a]:pointer-events-auto">
      {children}
    </fieldset>
  </>;
}

/** Shown when a House vault's arming read failed. */
export const HOUSE_ARMING_UNREAD = "The on-chain arming could not be read; deposits stay shut until it can.";

/** What a House holder can still do while deposits are shut (plain words, no "epoch roll"). */
const STILL_WORKS = "You can still ask to withdraw and claim.";

/** The House notice's one sentence for a vault that is read and not armed. No time is promised. */
export const houseNotQuoting = (ticker: string) =>
  `The ${ticker} house vault is not quoting yet. Deposits open when it is. ${STILL_WORKS}`;

/**
 * The House page's notice above the deposit panels while the vault is not quoting.
 *
 * COPY CHANGED: deposits are held shut until the vault is armed. The contract would take them --
 * `protocolAccountsConfirmed` gates quoting, not deposits -- and that is exactly why the app holds the door: a deposit
 * before the arming buys into a vault that quotes nothing, and the depositor cannot tell that from the form.
 *
 * `armed` is the arming of THE VAULT THE DEPOSIT WRITES TO, read with the page's other vault facts. Only
 * `true` hides the notice; `undefined` (still reading), `null` (failed) and `false` keep it up.
 */
export function HouseArmNotice({ ticker, armed, isError = false }: { ticker: string; armed: boolean | null | undefined; isError?: boolean }) {
  if (armed === true) return null;
  const unread = isError || armed === null;
  return <section aria-label={`${ticker} house vault status`} className="mb-5 rounded-lg border border-line-2 bg-surface p-6">
    <p className="text-center text-sm text-ink-2">
      {armed === false ? houseNotQuoting(ticker)
        : unread ? `${HOUSE_ARMING_UNREAD} ${STILL_WORKS}`
        : `Checking whether the ${ticker} house vault is quoting. Deposits stay shut until it is. ${STILL_WORKS}`}
    </p>
  </section>;
}

/**
 * The /vaults House card's gate, for an index that stands for every launch market. `open` only once the gates are read
 * and no launch House vault is pending; `pending` is null while unread (fail closed: the card stays shut).
 */
export function useHouseIndexGate(): { open: boolean; pending: string[] | null; isError: boolean } {
  const gates = useLaunchGates();
  const pending = pendingHouseMarkets(gates.data?.house);
  return { open: pending !== null && pending.length === 0, pending, isError: gates.isError };
}
