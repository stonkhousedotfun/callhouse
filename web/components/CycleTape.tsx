"use client";

import { Card, CardHead, CardMeta, CardTitle, Row, Stat } from "@/components/ui";
import { fmtCountdown, fmtEastern, fmtUtc, windowProgress } from "@/lib/format";
import { useNow, type VaultSnapshot } from "@/lib/hooks";

/**
 * The week's clock.
 *
 * Every timestamp here comes from the vault's own snapshot of the option type it armed at
 * rollOpen: `cycleExerciseTs` (the end of the sale window, when the exercise window opens) and
 * `cycleExpiryTs`. Both were read from the clearinghouse's immutable tuple and are what the
 * vault's hooks enforce. NOTHING here is derived from a calendar: the keeper chooses the type,
 * the vault records it, and a hardcoded weekday would keep counting down to a deadline the vault
 * never had. The keeper's own rule is the NYSE close, 16:00 America/New_York on the cycle's
 * Friday (Thursday before a Friday market holiday), with expiry 24 hours later; that is 20:00 UTC
 * in daylight time and 21:00 UTC from November, so each deadline is printed in UTC AND on the
 * Eastern clock (fmtEastern) to make the same instant readable both ways.
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
    <Card>
      <CardHead>
        <CardTitle>Cycle tape</CardTitle>
        <CardMeta>
          cycle #{cycleNumber ?? "—"} · {state}
        </CardMeta>
      </CardHead>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat
          label="Sale window closes in"
          value={now === 0 || !armed ? "—" : fmtCountdown(exerciseTs, now)}
          sub={armed ? `${fmtUtc(exerciseTs)} · ${fmtEastern(exerciseTs)}` : "nothing armed"}
          className="rounded-md bg-surface-2 p-4 sm:p-5"
        />
        <Stat
          label="Expiry in"
          value={now === 0 || !armed ? "—" : fmtCountdown(expiryTs, now)}
          sub={armed ? `${fmtUtc(expiryTs)} · ${fmtEastern(expiryTs)}` : "nothing armed"}
          className="rounded-md bg-surface-2 p-4 sm:p-5"
        />
      </div>

      <div className="mt-6">
        <div aria-hidden="true" className="relative h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-accent-soft to-accent"
            style={{ width: `${(progress * 100).toFixed(1)}%` }}
          />
        </div>
        <div className="mt-3 max-w-[60em] text-[12.5px] leading-[1.55] text-ink-3">
          The sale window closes at the option&apos;s exercise time: the last moment a fill can write a call. The keeper
          creates each week&apos;s type to open its exercise window at the NYSE close (16:00 Eastern, so the UTC hour
          moves with daylight time) and to expire a day later; the times shown are the chain&apos;s, not a
          calendar&apos;s. Between exercise and expiry the calls sold are exercisable, so assignment happens in that
          window. After expiry the keeper reclaims, harvests and settles the queue.
        </div>
      </div>
    </Card>
  );
}

/** The same two deadlines, compressed to one line for the home card. */
export function CycleTapeInline({ snapshot }: { snapshot: VaultSnapshot }) {
  const now = useNow();
  const exerciseTs = snapshot.cycleExerciseTs;
  const expiryTs = snapshot.cycleExpiryTs;
  const armed = exerciseTs !== undefined && exerciseTs > 0;
  return (
    <>
      <Row k="Sale window closes" v={now === 0 || !armed ? "—" : fmtCountdown(exerciseTs, now)} />
      <Row k="Expiry" v={now === 0 || !armed ? "—" : fmtCountdown(expiryTs, now)} />
    </>
  );
}
