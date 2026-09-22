"use client";

import { useEffect, useState } from "react";

import type { ConfigResponse, SeriesStatus } from "@/lib/v2/api-types";
import { HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS } from "@/lib/v2/houseCopy";

export type WithdrawalTiming = Pick<ConfigResponse["constants"],
  "settlementWindow" | "finalizeDelay" | "snapshotGrace" | "resolveDelay">;

type CommonProps = { className?: string; now?: number | null };

export type WithdrawalTermsProps = CommonProps & (
  | { surface: "writer"; asset: string; free: string | null; locked: string | null;
      latestExpiry: number | null; timing: WithdrawalTiming | null }
  | { surface: "lending" }
  | { surface: "house"; boundaryAt: number | null }
  | { surface: "redemption"; expiry: number; status: SeriesStatus;
      timing: WithdrawalTiming | null; candidateFinalizableAt?: number | null; settledAt?: number | null }
);

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

export function newYorkWithdrawalTime(unixSeconds: number): string {
  return NEW_YORK.format(new Date(unixSeconds * 1_000));
}

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

function TimingRows({ label, at, now, unavailable }: {
  label: string; at: number | null; now: number | null; unavailable: string;
}) {
  return <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
    <dt className="font-semibold text-ink">{label}</dt>
    <dd className="text-ink-2">{at === null ? unavailable : newYorkWithdrawalTime(at)}</dd>
    <dt className="font-semibold text-ink">Countdown</dt>
    <dd className="text-ink-2">{at === null ? unavailable : now === null ? "Calculating…" : withdrawalCountdown(at, now)}</dd>
  </dl>;
}

export function WithdrawalTerms(props: WithdrawalTermsProps) {
  const now = useWithdrawalClock(props.now);
  const className = `rounded-sm border border-line-2 bg-surface-2 p-3 ${props.className ?? ""}`.trim();

  if (props.surface === "lending") return <aside aria-label="Withdrawal terms" className={className}>
    <p className="text-xs font-bold uppercase tracking-wide text-ink-3">When can I withdraw?</p>
    <p className="mt-2 text-xs text-ink-2">Redeeming creates a queued request. The queue is served in order by <code>processQueue()</code> when the vault has enough liquid USDG; submitting a request is not an instant withdrawal.</p>
    <TimingRows label="Queue service time" at={null} now={now}
      unavailable="No fixed time — it depends on available liquidity" />
  </aside>;

  if (props.surface === "house") return <aside aria-label="Withdrawal terms" className={className}>
    <p className="text-xs font-bold uppercase tracking-wide text-ink-3">When can I withdraw?</p>
    <p className="mt-2 text-xs text-ink-2">{HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS}</p>
    <TimingRows label="Next boundary" at={props.boundaryAt} now={now}
      unavailable="Boundary timing is unavailable" />
  </aside>;

  if (props.surface === "writer") {
    const times = props.latestExpiry !== null && props.timing
      ? settlementWithdrawalTimes(props.latestExpiry, props.timing) : null;
    const noLock = props.locked === "0";
    return <aside aria-label="Withdrawal terms" className={className}>
      <p className="text-xs font-bold uppercase tracking-wide text-ink-3">When can I withdraw?</p>
      <p className="mt-2 text-xs text-ink-2">Free {props.asset} can be withdrawn at any time. Collateral in an open short stays locked until that series settles and you collect it.</p>
      <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="font-semibold text-ink">Free now</dt><dd className="num text-ink-2">{props.free ?? "Unavailable"} {props.asset}</dd>
        <dt className="font-semibold text-ink">Locked in shorts</dt><dd className="num text-ink-2">{props.locked ?? "Unavailable"} {props.asset}</dd>
      </dl>
      <TimingRows label="Latest shown unlock from" at={noLock ? null : times?.routineAt ?? null} now={now}
        unavailable={noLock ? "No locked short collateral is shown" : "Unlock timing is unavailable"} />
      {times ? <p className="mt-2 text-xs text-ink-3">That is the earliest routine settlement time for the latest shown expiry, not a guarantee. If settlement is held, admin resolution only becomes eligible at {newYorkWithdrawalTime(times.adminEligibleAt)}.</p> : null}
    </aside>;
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

  return <aside aria-label="Withdrawal terms" className={className}>
    <p className="text-xs font-bold uppercase tracking-wide text-ink-3">When can I withdraw?</p>
    <p className="mt-2 text-xs text-ink-2">You can resell before expiry while the market is open. On-chain redemption starts only after settlement is final.</p>
    <TimingRows label={timingLabel} at={availableAt} now={now} unavailable={unavailable} />
    {props.candidateFinalizableAt && !settled
      ? <p className="mt-2 text-xs text-ink-3">This uses the live settlement candidate time. A hold, missing source, or restarted candidate can make it later.</p>
      : held ? <p className="mt-2 text-xs text-ink-3">The timestamp is when the admin path becomes eligible, not a promised withdrawal time.</p>
        : !settled ? <p className="mt-2 text-xs text-ink-3">This is the earliest routine checkpoint, not a guarantee; final settlement may take longer.</p> : null}
    {times ? <p className="mt-2 text-xs text-ink-3">The price window starts {newYorkWithdrawalTime(times.windowStartsAt)} and ends at expiry. Snapshot grace ends {newYorkWithdrawalTime(times.snapshotClosesAt)}. If normal settlement cannot finish, admin resolution only becomes eligible {newYorkWithdrawalTime(times.adminEligibleAt)}.</p> : null}
  </aside>;
}
