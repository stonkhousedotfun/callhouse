"use client";

import { fmtAsset } from "@/lib/format";

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
    { label: "Idle", value: idle ?? 0n, color: "var(--accent)", hint: "free collateral" },
    { label: "Sold", value: sold ?? 0n, color: "var(--warn)", hint: "written at its fill, can be assigned" },
    { label: "Assigned", value: assigned ?? 0n, color: "var(--danger)", hint: "taken at the strike" },
  ];

  const total = segments.reduce((acc, s) => acc + (s.value > 0n ? s.value : 0n), 0n);
  const visible = segments.filter((s) => s.value > 0n);

  return (
    <div>
      <div className="split" role="img" aria-label="Collateral split">
        {total === 0n ? (
          <div className="split-seg" style={{ width: "100%", background: "var(--line)" }} />
        ) : (
          visible.map((s) => (
            <div
              key={s.label}
              className="split-seg"
              style={{ width: `${(Number((s.value * 10_000n) / total) / 100).toFixed(2)}%`, background: s.color }}
            />
          ))
        )}
      </div>
      <div className="split-legend">
        {segments.map((s) => (
          <span key={s.label} className="legend-item" title={s.hint}>
            <span className="legend-swatch" style={{ background: s.color }} />
            <span>{s.label}</span>
            <span className="mono" style={{ color: "var(--fg)" }}>
              {fmtAsset(s.value)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
