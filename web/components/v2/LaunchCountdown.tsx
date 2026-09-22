"use client";

/**
 * Countdowns for the launch gates the Safe still has to execute, and the faded-out wrapper for controls that
 * are not live yet. The dates come from the chain (lib/v2/launchGates.ts); this file only ticks and renders.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import { countdownLabel, houseDepositsOpen, launchGatePhase, readLaunchGates, soonestPendingHouseGate,
  type LaunchGate, type LaunchGates } from "@/lib/v2/launchGates";

const LAUNCH_GATES_KEY = ["v2", "launchGates"] as const;

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


/**
 * Whether this market's House deposit controls may be used, plus the gate behind the answer.
 *
 * NO PER-SECOND TICK HERE ON PURPOSE. The answer turns on `gate.done` alone — the arming read back from
 * chain — so it does not move with the clock, and a control that re-rendered every second would churn a
 * whole deposit form for nothing. What flips it is `useLaunchGates`' own 15 s refetch.
 *
 * `open` is false while the gate is unread, so a failed or in-flight chain read leaves deposits shut.
 */
export function useHouseDepositsOpen(ticker: string): { open: boolean; gate: LaunchGate | undefined; isError: boolean } {
  const gates = useLaunchGates();
  const gate = gates.data?.house[ticker];
  return { open: houseDepositsOpen(gate, Math.floor(Date.now() / 1000)), gate, isError: gates.isError };
}

/** A once-a-second clock in unix seconds; one interval per mounted countdown. */
function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export type GateCopy = {
  /** "Trading opens" / "House quoting starts". */
  subject: string;
  /** Shown once `done` is read back. */
  doneLabel: string;
  /** Shown while nothing is scheduled and the effect is absent. */
  unscheduledLabel: string;
};

/**
 * The clock itself: big ticking digits under a label, the absolute time beneath. Renders the same for a
 * market opening and a vault arming; only the copy changes. "Due" (scheduled time passed, execute not yet
 * sent) shows 00:00:00 with the state spelled out, never a negative number.
 */
export function CountdownClock({ gate, label, doneLabel, unscheduledLabel, size = "lg" }: {
  gate: LaunchGate | undefined; label: string; doneLabel: string; unscheduledLabel: string; size?: "lg" | "md";
}) {
  const now = useNowSeconds();
  const digits = size === "lg" ? "text-5xl sm:text-6xl" : "text-3xl";
  const phase = gate ? launchGatePhase(gate, now) : null;
  const at = gate && gate.scheduledAt ? new Date(gate.scheduledAt * 1000) : null;
  return <div className="text-center" role="timer" aria-live="off" aria-label={label}>
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-2">{label}</p>
    <p className={`num mt-1 font-display font-bold leading-none tabular-nums ${digits}`}>
      {phase === null ? "--:--:--"
        : phase === "done" ? "LIVE"
        : phase === "unscheduled" ? "--:--:--"
        : countdownLabel(Math.max(0, gate!.scheduledAt - now))}
    </p>
    <p className="mt-2 text-sm text-ink-2">
      {phase === null ? "Reading the schedule on chain…"
        : phase === "done" ? doneLabel
        : phase === "unscheduled" ? unscheduledLabel
        : phase === "due" ? "Due now — waiting for the Admin Safe to send the execute."
        : `${at!.toISOString().slice(11, 16)} UTC · ${at!.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} local`}
    </p>
  </div>;
}

/** One gate's line: "Trading opens in 00:41:07 (10:24 UTC)" / "…is being enabled now" / done / unscheduled. */
export function GateLine({ gate, copy }: { gate: LaunchGate | undefined; copy: GateCopy }) {
  const now = useNowSeconds();
  if (!gate) return <span className="text-ink-3">{copy.subject}: checking on chain…</span>;
  const phase = launchGatePhase(gate, now);
  if (phase === "done") return <span>{copy.doneLabel}</span>;
  if (phase === "unscheduled") return <span>{copy.unscheduledLabel}</span>;
  if (phase === "due") return <span>{copy.subject} as soon as the Admin Safe sends the execute — it is due now.</span>;
  const at = new Date(gate.scheduledAt * 1000);
  return <span>
    {copy.subject} in <span className="num font-semibold">{countdownLabel(gate.scheduledAt - now)}</span>
    {" "}({at.toISOString().slice(11, 16)} UTC, {at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} local)
  </span>;
}

export const TRADING_COPY = (ticker: string): GateCopy => ({
  subject: `${ticker} trading opens`,
  doneLabel: `${ticker} trading is enabled on chain.`,
  unscheduledLabel: `${ticker} trading is not enabled and no enable is scheduled yet.`,
});

export const HOUSE_COPY = (ticker: string): GateCopy => ({
  subject: `The ${ticker} house market maker starts quoting`,
  doneLabel: `The ${ticker} house vault is armed and can quote.`,
  unscheduledLabel: `The ${ticker} house vault is not armed and no arming is scheduled yet.`,
});

/**
 * The market page while its market is registered but not enabled: the whole page renders, every control in
 * it is disabled by the fieldset (native buttons and inputs; the design system's Button is a <button>) and
 * faded, and the countdown sits on top. Links still work: the page is readable, not usable.
 */
export function LockedMarket({ ticker, children }: { ticker: string; children: ReactNode }) {
  const gates = useLaunchGates();
  const t = TRADING_COPY(ticker); const h = HOUSE_COPY(ticker);
  return <>
    <section aria-label={`${ticker} launch countdown`} className="mb-6 rounded-lg border border-line-2 bg-surface p-6">
      {/* Defence in depth after the 2026-09-22 indexer-veto bug: if this ever renders while the chain says
          trading is on, the headline must not contradict the clock directly beneath it. */}
      <p className="mb-5 text-center font-display text-xl font-bold">
        {gates.data?.trading[ticker]?.done
          ? `${ticker} trading is enabled on chain. This page is still catching up.`
          : `${ticker} is listed. Trading is not open yet.`}
      </p>
      <div className="grid gap-8 sm:grid-cols-2">
        <CountdownClock gate={gates.data?.trading[ticker]} label={`${ticker} trading opens in`} doneLabel={t.doneLabel} unscheduledLabel={t.unscheduledLabel} />
        <CountdownClock gate={gates.data?.house[ticker]} label="House market maker quotes in" doneLabel={h.doneLabel} unscheduledLabel={h.unscheduledLabel} />
      </div>
      {gates.isError ? <p className="mt-4 text-center text-sm text-ink-3">The on-chain schedule could not be read; the controls stay off until it can.</p> : null}
    </section>
    <fieldset disabled aria-disabled="true" aria-label={`${ticker} market controls, not open yet`}
      className="min-w-0 border-0 p-0 opacity-50 [&_a]:pointer-events-auto">
      {children}
    </fieldset>
  </>;
}

/**
 * The house page's arming clock, above the deposit panels.
 *
 * COPY CHANGED 2026-09-22 (owner): deposits are held shut until the vault is armed, so this no longer says
 * the vault takes them. The contract still would — `protocolAccountsConfirmed` gates quoting, not deposits —
 * and that is exactly why the app holds the door: a deposit before the arming buys into a vault that quotes
 * nothing, and the depositor cannot tell that from the form.
 */
export function HouseArmNotice({ ticker }: { ticker: string }) {
  const { open, gate, isError } = useHouseDepositsOpen(ticker);
  if (open) return null;
  const h = HOUSE_COPY(ticker);
  return <section aria-label={`${ticker} house vault countdown`} className="mb-5 rounded-lg border border-line-2 bg-surface p-6">
    <CountdownClock gate={gate} label={`${ticker} house market maker quotes in`} doneLabel={h.doneLabel} unscheduledLabel={h.unscheduledLabel} />
    <p className="mt-4 text-center text-sm text-ink-2">
      Deposits open when it starts quoting. Withdrawal requests, claims and the epoch roll work now.
    </p>
    {isError ? <p className="mt-2 text-center text-sm text-ink-3">The on-chain arming could not be read; deposits stay shut until it can.</p> : null}
  </section>;
}

/**
 * The /vaults index row for House, which stands for every launch market at once and so has no single ticker
 * to read. Shows the soonest pending arming and nothing at all once every launch vault is armed.
 */
export function HouseIndexCountdown() {
  const gates = useLaunchGates();
  const pending = soonestPendingHouseGate(gates.data?.house, Math.floor(Date.now() / 1000));
  if (!pending) return null;
  const h = HOUSE_COPY(pending.ticker);
  return <div className="mt-5 border-t border-line pt-4">
    <CountdownClock gate={pending.gate} size="md"
      label={`${pending.ticker} house market maker quotes in`} doneLabel={h.doneLabel} unscheduledLabel={h.unscheduledLabel} />
    {gates.isError ? <p className="mt-2 text-center text-sm text-ink-3">The on-chain arming could not be read; deposits stay shut until it can.</p> : null}
  </div>;
}

/** True once at least one launch House vault is armed — the /vaults row's Deposit CTA opens then. */
export function useHouseIndexOpen(): boolean {
  const gates = useLaunchGates();
  return gates.data !== undefined && soonestPendingHouseGate(gates.data.house, Math.floor(Date.now() / 1000)) === null;
}
