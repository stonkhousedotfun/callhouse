"use client";

/**
 * The phase chips.
 *
 * Four phases — Idle, Listed, Exercisable, Settling — read from the chain, where they are paced
 * by the option type the vault armed (its exercise and expiry timestamps), never by the
 * browser's wall clock. A visitor in any timezone sees the same week in the same state.
 */
import { FILL_STATE_COPY, phaseLabel, type FillState } from "@/lib/hooks";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const FILL_TONE: Record<FillState, Tone> = {
  unknown: "neutral",
  flat: "neutral",
  stranded: "bad",
  armed: "info",
  selling: "good",
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
 * part a depositor cares about, and it includes "Window closed, unsold" as a normal outcome
 * rather than an error state — an empty week is the most likely week, and the product publishes
 * it plainly. `sold` is the contracts sold this week, which under write on fill is exactly the
 * contracts written.
 */
export function PhaseBadge({
  phase,
  fillState,
  sold,
  showPhase = true,
}: {
  phase?: number;
  fillState: FillState;
  sold?: bigint;
  showPhase?: boolean;
}) {
  const label =
    (fillState === "selling" || fillState === "filled" || fillState === "locked" || fillState === "assigned") && sold !== undefined
      ? `${FILL_STATE_COPY[fillState]} · ${sold.toString()} sold`
      : FILL_STATE_COPY[fillState];
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      <Badge tone={FILL_TONE[fillState]}>{label}</Badge>
      {showPhase ? <Badge tone="neutral">{phaseLabel(phase)}</Badge> : null}
    </span>
  );
}

/** Conditions that stop the vault selling at all. Shown only when they are true. */
export function GuardBadges({
  writesHalted,
  oraclePaused,
  spotStale,
  valoremFeeAccepted,
  stranded,
}: {
  writesHalted?: boolean;
  oraclePaused?: boolean;
  spotStale?: boolean;
  valoremFeeAccepted?: boolean;
  stranded?: boolean;
}) {
  const badges: React.ReactNode[] = [];
  if (stranded) badges.push(<Badge key="stranded" tone="bad">Claim stranded</Badge>);
  if (writesHalted) badges.push(<Badge key="halt" tone="bad">Writes halted</Badge>);
  if (oraclePaused) badges.push(<Badge key="oracle" tone="bad">Token oracle paused</Badge>);
  if (spotStale) badges.push(<Badge key="spot" tone="warn">Price feed stale</Badge>);
  if (valoremFeeAccepted) badges.push(<Badge key="fee" tone="warn">Valorem fee accepted</Badge>);
  if (badges.length === 0) return null;
  return <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>{badges}</span>;
}
