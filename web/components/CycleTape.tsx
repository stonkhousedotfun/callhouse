"use client";

import { fmtCountdown, fmtUtc, windowProgress } from "@/lib/format";
import { useNow, type VaultSnapshot } from "@/lib/hooks";

/**
 * The week's clock.
 *
 * Every timestamp here comes from the Overcall registry — `cycle().exerciseTimestamp` (book
 * close, which the registry also exposes as `writeDeadline()`) and `cycle().expiryTimestamp`.
 * NOTHING here is derived from "Friday 20:00 UTC". The registry owner can move or replace a
 * cycle, and a hardcoded weekday would keep counting down to a deadline that no longer exists.
 *
 * Likewise the open/closed state is `isWritingOpen()` and `isCycleLive()`, not a comparison this
 * component invents. The registry struct has no status field — see ops/recon/R1.
 */
export function CycleTape({ snapshot }: { snapshot: VaultSnapshot }) {
  const now = useNow();

  // Prefer the registry's live cycle. Fall back to the cycle the vault recorded at rollOpen,
  // which is what is still relevant while the vault is settling a week the registry has moved on
  // from.
  const exerciseTs = snapshot.registryExerciseTs ?? snapshot.cycleExerciseTs;
  const expiryTs = snapshot.registryExpiryTs ?? snapshot.cycleExpiryTs;
  const cycleNumber = snapshot.registryCycleNumber ?? snapshot.cycleNumber;

  const bookOpen = snapshot.isWritingOpen === true;
  const cycleLive = snapshot.isCycleLive === true;

  // The rail runs from "one week before book close" to expiry. It is a visual aid only; the
  // numbers beside it are the truth.
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
          registry cycle #{cycleNumber ?? "—"} · {bookOpen ? "writing open" : cycleLive ? "writing closed" : "no live cycle"}
        </span>
      </div>

      <div className="grid grid-2">
        <div className="stat">
          <div className="stat-label">Book closes in</div>
          <div className="stat-value">{now === 0 ? "—" : fmtCountdown(exerciseTs, now)}</div>
          <div className="stat-sub">{fmtUtc(exerciseTs)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Expiry in</div>
          <div className="stat-value">{now === 0 ? "—" : fmtCountdown(expiryTs, now)}</div>
          <div className="stat-sub">{fmtUtc(expiryTs)}</div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="rail">
          <div className="rail-fill" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
        </div>
        <div className="tiny faint" style={{ marginTop: 6 }}>
          Book close is the last moment a call can be written or listed. Between book close and
          expiry the calls are exercisable, so assignment happens in that window. After expiry the
          keeper reclaims, harvests and settles the queue.
        </div>
      </div>
    </div>
  );
}

/** The same two deadlines, compressed to one line for the home card. */
export function CycleTapeInline({ snapshot }: { snapshot: VaultSnapshot }) {
  const now = useNow();
  const exerciseTs = snapshot.registryExerciseTs ?? snapshot.cycleExerciseTs;
  const expiryTs = snapshot.registryExpiryTs ?? snapshot.cycleExpiryTs;
  return (
    <div className="row tiny">
      <span className="k">Book close</span>
      <span className="v">{now === 0 ? "—" : fmtCountdown(exerciseTs, now)}</span>
      <span className="k">Expiry</span>
      <span className="v">{now === 0 ? "—" : fmtCountdown(expiryTs, now)}</span>
    </div>
  );
}
