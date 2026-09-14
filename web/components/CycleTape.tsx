"use client";

import { fmtCountdown, fmtUtc, windowProgress } from "@/lib/format";
import { useNow, type VaultSnapshot } from "@/lib/hooks";

/**
 * The week's clock.
 *
 * Every timestamp here comes from the vault's own snapshot of the option type it armed at
 * rollOpen: `cycleExerciseTs` (the end of the sale window, when the exercise window opens) and
 * `cycleExpiryTs`. Both were read from the clearinghouse's immutable tuple and are what the
 * vault's hooks enforce. NOTHING here is derived from "Friday 20:00 UTC": the keeper chooses the
 * type, the vault records it, and a hardcoded weekday would keep counting down to a deadline the
 * vault never had.
 *
 * Likewise the open/closed state is the vault's `phase` against its own clock, not a comparison
 * this component invents: a fill goes through only while Listed and before `cycleExerciseTs`
 * (WriteWindowClosed otherwise), whether or not anyone has called lockBook.
 */
export function CycleTape({ snapshot }: { snapshot: VaultSnapshot }) {
  const now = useNow();

  const exerciseTs = snapshot.cycleExerciseTs;
  const expiryTs = snapshot.cycleExpiryTs;
  const cycleNumber = snapshot.cycleNumber;
  const armed = exerciseTs !== undefined && exerciseTs > 0;

  const state =
    snapshot.phase === undefined
      ? "—"
      : snapshot.isStranded
        ? "claim stranded"
        : snapshot.phase === 0
          ? "no cycle armed"
          : snapshot.phase === 1
            ? now > 0 && exerciseTs !== undefined && now >= exerciseTs
              ? "sale window closed"
              : "selling"
            : snapshot.phase === 2
              ? "exercisable"
              : "settling";

  // The rail runs from "one week before the sale window closes" to expiry. It is a visual aid
  // only; the numbers beside it are the truth.
  const railStart = exerciseTs !== undefined ? exerciseTs - 7 * 86400 : undefined;
  const progress =
    railStart !== undefined && expiryTs !== undefined && now > 0
      ? windowProgress(railStart, expiryTs, now)
      : 0;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Cycle tape</span>
        <span className="tiny faint mono">
          cycle #{cycleNumber ?? "—"} · {state}
        </span>
      </div>

      <div className="grid grid-2">
        <div className="stat">
          <div className="stat-label">Sale window closes in</div>
          <div className="stat-value">{now === 0 || !armed ? "—" : fmtCountdown(exerciseTs, now)}</div>
          <div className="stat-sub">{armed ? fmtUtc(exerciseTs) : "nothing armed"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Expiry in</div>
          <div className="stat-value">{now === 0 || !armed ? "—" : fmtCountdown(expiryTs, now)}</div>
          <div className="stat-sub">{armed ? fmtUtc(expiryTs) : "nothing armed"}</div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="rail">
          <div className="rail-fill" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
        </div>
        <div className="tiny faint" style={{ marginTop: 6 }}>
          The sale window closes at the option&apos;s exercise time: the last moment a fill can write a call. Between
          then and expiry the calls sold are exercisable, so assignment happens in that window. After expiry the
          keeper reclaims, harvests and settles the queue.
        </div>
      </div>
    </div>
  );
}

/** The same two deadlines, compressed to one line for the home card. */
export function CycleTapeInline({ snapshot }: { snapshot: VaultSnapshot }) {
  const now = useNow();
  const exerciseTs = snapshot.cycleExerciseTs;
  const expiryTs = snapshot.cycleExpiryTs;
  const armed = exerciseTs !== undefined && exerciseTs > 0;
  return (
    <div className="row tiny">
      <span className="k">Sale window closes</span>
      <span className="v">{now === 0 || !armed ? "—" : fmtCountdown(exerciseTs, now)}</span>
      <span className="k">Expiry</span>
      <span className="v">{now === 0 || !armed ? "—" : fmtCountdown(expiryTs, now)}</span>
    </div>
  );
}
