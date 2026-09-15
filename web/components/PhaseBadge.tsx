"use client";

/**
 * The phase chips.
 *
 * Four phases — Idle, Listed, Exercisable, Settling — read from the chain, where they are paced
 * by the option type the vault armed (its exercise and expiry timestamps), never by the
 * browser's wall clock. A visitor in any timezone sees the same week in the same state.
 */
import { phaseLabel } from "@/lib/hooks";
import { deriveFillState, FILL_STATE_COPY, vaultGuards, type FillState } from "@/lib/vaultStatus";

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

const GUARD_TONE: Record<"bad" | "warn" | "info", Tone> = {
  bad: "bad",
  warn: "warn",
  info: "info",
};

export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="badge" data-tone={tone === "neutral" ? undefined : tone} title={title}>
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

/** Fill-state chip from the snapshot and the clock. Pages pass `useNow()` so SSR and the first client frame agree. */
export function VaultPhaseBadge({
  snapshot,
  nowSeconds,
  showPhase = true,
}: {
  snapshot: Parameters<typeof deriveFillState>[0];
  nowSeconds: number;
  showPhase?: boolean;
}) {
  return (
    <PhaseBadge
      phase={snapshot.phase}
      fillState={deriveFillState(snapshot, nowSeconds)}
      sold={snapshot.contractsWritten}
      showPhase={showPhase}
    />
  );
}

/** Conditions that stop the vault selling at all. Shown only when they are true. */
export function GuardBadges({ snapshot }: { snapshot: Parameters<typeof vaultGuards>[0] }) {
  const guards = vaultGuards(snapshot);
  if (guards.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {guards.map((g) => (
        <Badge key={g.key} tone={GUARD_TONE[g.tone]} title={g.title}>
          {g.label}
        </Badge>
      ))}
    </span>
  );
}
