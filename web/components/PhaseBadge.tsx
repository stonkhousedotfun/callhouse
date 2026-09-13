"use client";

/**
 * The phase chips.
 *
 * Four phases — Idle, Listed, Exercisable, Settling — read from the chain, where they are paced
 * by the Overcall registry's timestamps, never by the browser's wall clock. A visitor in any
 * timezone sees the same week in the same state.
 */
import { FILL_STATE_COPY, phaseLabel, type FillState } from "@/lib/hooks";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const FILL_TONE: Record<FillState, Tone> = {
  unknown: "neutral",
  flat: "neutral",
  listed: "info",
  partial: "good",
  filled: "good",
  locked: "warn",
  settling: "warn",
  assigned: "warn",
  unfilled: "neutral",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className="badge" data-tone={tone === "neutral" ? undefined : tone}>
      <span className="dot" />
      {children}
    </span>
  );
}

/**
 * The week's state in one chip.
 *
 * `phase` is the vault's own enum (Idle / Listed / Exercisable / Settling). `fillState` is the
 * part a depositor cares about, and it includes "Unfilled, 0" as a normal outcome rather than an
 * error state — an empty book is the most likely week, and the product publishes it plainly.
 */
export function PhaseBadge({
  phase,
  fillState,
  showPhase = true,
}: {
  phase?: number;
  fillState: FillState;
  showPhase?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      <Badge tone={FILL_TONE[fillState]}>{FILL_STATE_COPY[fillState]}</Badge>
      {showPhase ? <Badge tone="neutral">{phaseLabel(phase)}</Badge> : null}
    </span>
  );
}

/** Conditions that stop the vault writing at all. Shown only when they are true. */
export function GuardBadges({
  writesHalted,
  oraclePaused,
  spotStale,
  valoremFeeAccepted,
}: {
  writesHalted?: boolean;
  oraclePaused?: boolean;
  spotStale?: boolean;
  valoremFeeAccepted?: boolean;
}) {
  const badges: React.ReactNode[] = [];
  if (writesHalted) badges.push(<Badge key="halt" tone="bad">Writes halted</Badge>);
  if (oraclePaused) badges.push(<Badge key="oracle" tone="bad">Token oracle paused</Badge>);
  if (spotStale) badges.push(<Badge key="spot" tone="warn">Price feed stale</Badge>);
  if (valoremFeeAccepted) badges.push(<Badge key="fee" tone="warn">Valorem fee accepted</Badge>);
  if (badges.length === 0) return null;
  return <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>{badges}</span>;
}
