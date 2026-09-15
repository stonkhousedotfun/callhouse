"use client";

import { cn } from "@/lib/cn";
import { fmtAsset } from "@/lib/format";

/** `color` is a Tailwind background token class: the bar and the legend swatch share it. */
type Segment = { label: string; value: bigint; color: string; hint?: string };

/**
 * Where the vault's Stock Tokens are right now.
 *
 *   idle     — free collateral. Redeemable instantly while the vault is flat, and the base every
 *              fill is sized against.
 *   sold     — locked behind calls a buyer owns. This is the slice that can be assigned. Under
 *              write on fill it is ALL the locked collateral: nothing is written until it is sold,
 *              so there is no "listed but unsold" slice and no third segment for it.
 *   assigned — already taken at the strike. Shown because it explains why the token balance fell.
 *
 * All three are RAW balances. The NVDA-eq figure elsewhere on the page multiplies by
 * uiMultiplier() for display; this bar deliberately does not, because it is describing what the
 * vault can actually move.
 */
export function PositionSplit({
  idle,
  sold,
  assigned,
}: {
  idle?: bigint;
  sold?: bigint;
  assigned?: bigint;
}) {
  const segments: Segment[] = [
    { label: "Idle", value: idle ?? 0n, color: "bg-accent", hint: "free collateral" },
    { label: "Sold", value: sold ?? 0n, color: "bg-warn", hint: "written at its fill, can be assigned" },
    { label: "Assigned", value: assigned ?? 0n, color: "bg-danger", hint: "taken at the strike" },
  ];

  const total = segments.reduce((acc, s) => acc + (s.value > 0n ? s.value : 0n), 0n);
  const visible = segments.filter((s) => s.value > 0n);

  return (
    <div>
      <div role="img" aria-label="Collateral split" className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-2">
        {total === 0n ? (
          <div className="h-full w-full bg-line" />
        ) : (
          visible.map((s) => (
            <div
              key={s.label}
              className={cn("h-full rounded-full", s.color)}
              style={{ width: `${(Number((s.value * 10_000n) / total) / 100).toFixed(2)}%` }}
            />
          ))
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px]">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-2" title={s.hint}>
            <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", s.color)} />
            <span className="text-ink-2">{s.label}</span>
            <span className="num font-medium text-ink">{fmtAsset(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
