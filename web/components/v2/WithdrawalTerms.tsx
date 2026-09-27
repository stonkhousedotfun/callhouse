"use client";

import { useEffect, useState, type ReactNode } from "react";

import type { ConfigResponse, SeriesStatus } from "@/lib/v2/api-types";
import { houseWithdrawalDisclosure, type HouseCadence } from "@/lib/v2/houseCopy";
import { cutoffSentences } from "@/lib/v2/houseEpoch";
import { EARN_QUEUE_PRICING } from "@/lib/v2/vaultCopy";
import { InfoTip } from "@/components/ui/InfoTip";
import { Time } from "@/components/ui/Time";

export type WithdrawalTiming = Pick<ConfigResponse["constants"],
  "settlementWindow" | "finalizeDelay" | "snapshotGrace" | "resolveDelay">;

type CommonProps = { className?: string; now?: number | null };

export type WithdrawalTermsProps = CommonProps & (
  | { surface: "writer"; asset: string; free: string | null; locked: string | null;
      latestExpiry: number | null; timing: WithdrawalTiming | null }
  | { surface: "lending" }
  // required. A missing cadence used to default to "weekly", which printed the weekly disclosure and a
  // "Fri 4:00 pm ET" cutoff on a daily vault. A caller that does not know the cadence renders houseExitLine instead
  // (HouseVault does), so there is no honest default to fall back to here.
  // `marketListsDailies` (the registry's listing; absent = lists them) swaps in the Friday-only disclosure.
  // `settlementWindow` is the chain's SETTLEMENT_WINDOW() read; the cutoff sentences need it and wait for it.
  | { surface: "house"; boundaryAt: number | null; cadence: HouseCadence; marketListsDailies?: boolean; settlementWindow?: number | null }
  | { surface: "redemption"; expiry: number; status: SeriesStatus;
      timing: WithdrawalTiming | null; candidateFinalizableAt?: number | null; settledAt?: number | null }
);

export function withdrawalCountdown(target: number, now: number): string {
  const remaining = Math.max(0, target - now);
  if (remaining === 0) return "available now";
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return minutes ? `${minutes}m` : "under 1m";
}

export function settlementWithdrawalTimes(expiry: number, timing: WithdrawalTiming) {
  return {
    windowStartsAt: expiry - timing.settlementWindow,
    routineAt: expiry + timing.finalizeDelay,
    snapshotClosesAt: expiry + timing.snapshotGrace,
    adminEligibleAt: expiry + timing.resolveDelay,
  };
}

function useWithdrawalClock(provided: number | null | undefined): number | null {
  const [clock, setClock] = useState<number | null>(null);
  useEffect(() => {
    if (provided !== undefined && provided !== null) return;
    const tick = () => setClock(Math.floor(Date.now() / 1_000));
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [provided]);
  return provided ?? clock;
}

function TermsBox({ className, tip, rows }: {
  className?: string;
  tip: ReactNode;
  rows: readonly (readonly [ReactNode, ReactNode])[];
}) {
  return <aside aria-label="Withdrawal terms"
    className={`rounded-md border border-line bg-field px-3.5 py-3 text-[13px] leading-snug ${className ?? ""}`.trim()}>
    <p className="flex items-center gap-1.5 font-semibold text-ink">When can I withdraw?
      <InfoTip label="More about withdrawals" align="start" text={tip} /></p>
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
      {rows.map(([label, value], index) => <div key={index} className="contents">
        <dt className="text-ink-3">{label}</dt>
        <dd className="text-right text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{value}</dd>
      </div>)}
    </dl>
  </aside>;
}

const para = (text: ReactNode, first = false) => <span className={first ? "block" : "mt-1.5 block"}>{text}</span>;

function countdownText(at: number | null, now: number | null, unavailable: string): ReactNode {
  return at === null ? unavailable : now === null ? "Calculating…" : withdrawalCountdown(at, now);
}

export function WithdrawalTerms(props: WithdrawalTermsProps) {
  const now = useWithdrawalClock(props.now);
  const className = props.className;

  if (props.surface === "lending") return <TermsBox className={className}
    tip={<>{para(<>Redeeming makes a queued request, paid in order when the vault has enough USDG. It isn&apos;t an instant withdrawal.</>, true)}
      {para(EARN_QUEUE_PRICING)}</>}
    rows={[["Queue service time", "No fixed time — it depends on available liquidity"]]} />;

  if (props.surface === "house") {
    // The deposit and withdrawal cutoffs are different rules (houseEpoch.cutoffSentences), stated apart;
    // the weekday wording follows the vault's own cadence, which the caller must supply (no default).
    const cadence = props.cadence;
    const windowS = props.settlementWindow ?? null;
    const cut = props.boundaryAt === null || windowS === null ? null : cutoffSentences(cadence, props.boundaryAt, windowS);
    return <TermsBox className={className}
      tip={<>{para(houseWithdrawalDisclosure(cadence, props.marketListsDailies ?? true), true)}
        {cut ? para(<>{cut.deposit} {cut.withdraw}</>) : null}</>}
      rows={[["Next close", props.boundaryAt === null ? "Close timing is unavailable" : <Time at={props.boundaryAt} market />],
        ["Countdown", countdownText(props.boundaryAt, now, "Close timing is unavailable")]]} />;
  }

  if (props.surface === "writer") {
    const times = props.latestExpiry !== null && props.timing
      ? settlementWithdrawalTimes(props.latestExpiry, props.timing) : null;
    const noLock = props.locked === "0";
    const unlockAt = noLock ? null : times?.routineAt ?? null;
    const unavailable = noLock ? "Nothing is locked" : "Unlock timing is unavailable";
    return <TermsBox className={className}
      tip={<>{para(<>Free {props.asset} can be withdrawn any time. Collateral behind a sold option stays locked until it settles and you collect it.</>, true)}
        {times ? para(<>The unlock time is the earliest routine settlement time for the latest shown expiry, not a guarantee. If settlement is held, admin resolution only becomes eligible at <Time at={times.adminEligibleAt} market />.</>) : null}</>}
      rows={[["Free now", props.free === null ? "Unavailable" : `${props.free} ${props.asset}`],
        ["Locked in sold options", props.locked === null ? "Unavailable" : `${props.locked} ${props.asset}`],
        ["Latest shown unlock from", unlockAt === null ? unavailable : <Time at={unlockAt} market />],
        ...(unlockAt !== null ? [["Countdown", countdownText(unlockAt, now, unavailable)] as const] : [])]} />;
  }

  const times = props.timing ? settlementWithdrawalTimes(props.expiry, props.timing) : null;
  const held = props.status === "held";
  const settled = props.status === "settled";
  const availableAt = settled
    ? props.settledAt ?? times?.routineAt ?? null
    : held ? times?.adminEligibleAt ?? null
      : props.candidateFinalizableAt ?? times?.routineAt ?? null;
  const timingLabel = settled ? "Withdraw from" : held ? "Admin resolution eligible" : "Earliest withdraw from";
  const unavailable = held
    ? "No guaranteed withdrawal time while settlement is held"
    : "Settlement timing is unavailable";

  return <TermsBox className={className}
    tip={<>{para("You can resell before expiry while the market is open. On-chain redemption starts only after settlement is final.", true)}
      {props.candidateFinalizableAt && !settled
        ? para("This uses the live settlement candidate time. A hold, missing source, or restarted candidate can make it later.")
        : held ? para("The timestamp is when the admin path becomes eligible, not a promised withdrawal time.")
          : !settled ? para("This is the earliest routine checkpoint, not a guarantee; final settlement may take longer.") : null}
      {times ? para(<>The price window starts <Time at={times.windowStartsAt} market /> and ends at expiry. Snapshot grace ends <Time at={times.snapshotClosesAt} market />. If normal settlement cannot finish, admin resolution only becomes eligible <Time at={times.adminEligibleAt} market />.</>) : null}</>}
    rows={[[timingLabel, availableAt === null ? unavailable : <Time at={availableAt} market />],
      ["Countdown", countdownText(availableAt, now, unavailable)]]} />;
}
