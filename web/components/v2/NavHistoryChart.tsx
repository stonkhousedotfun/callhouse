/**
 * Block G of the House page: share price after each close.
 *
 * FACTS ONLY. One point per close, y = navUsdg * 1e18 / supply. `supply` is not on the wire until the indexer
 * sends it; until EVERY point has it, this renders "No chart yet" and nothing else -- it never
 * divides by a guess and never draws a partial line that would read as a trend. Connectors are dashed and the legend
 * says they are not prices. No smoothing, no fill, no since-inception headline.
 *
 * Accessibility: the SVG is role="img" with an aria-label naming the last point, and `aria-describedby` points at the
 * page's per-epoch table (the table is the accessible path).
 */
import { fmtUsdg } from "@/lib/format";
import type { NavPoint } from "@/lib/v2/houseRows";

export type { NavPoint };

export const NO_CHART_YET = "No chart yet";

/** USDG base units (6 dp) per 1e18 shares. Null when supply is absent or zero. */
export function perShareUsdg(point: NavPoint): bigint | null {
  if (point.supply === null || point.supply === 0n) return null;
  return (point.navUsdg * 10n ** 18n) / point.supply;
}

/** perShareUsdg as a float, for plotting only. */
export function perShare(point: NavPoint): number | null {
  const raw = perShareUsdg(point);
  return raw === null ? null : Number(raw) / 1e6;
}

/** The last point's share price as text, through the shared money rules: "1.0342", never "1.0000". */
export function sharePriceText(point: NavPoint): string {
  return fmtUsdg(perShareUsdg(point), 4);
}

export function NavHistoryChart({ points, tableId, width = 640, height = 200 }: { points: NavPoint[]; tableId: string; width?: number; height?: number }) {
  const values = points.map(perShare);
  if (points.length === 0 || values.some((v) => v === null)) {
    return <p className="text-sm text-ink-2" data-chart="none">{NO_CHART_YET}</p>;
  }
  const ys = values as number[];
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const pad = 12;
  const x = (i: number) => (points.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (points.length - 1));
  const y = (v: number) => (max === min ? height / 2 : height - pad - ((v - min) * (height - 2 * pad)) / (max - min));
  const last = points[points.length - 1]!;
  return (
    <figure>
      <svg role="img" aria-label={`Share price after close #${last.epoch}: ${sharePriceText(last)} USDG`} aria-describedby={tableId}
        viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
        <polyline fill="none" stroke="currentColor" strokeDasharray="4 4" strokeWidth={1}
          points={ys.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
        {ys.map((v, i) => (
          <g key={points[i]!.epoch}>
            <circle cx={x(i)} cy={y(v)} r={3} fill="currentColor" />
            {points[i]!.feeTaken ? <text x={x(i)} y={y(v) - 8} textAnchor="middle" fontSize={10}>▲</text> : null}
          </g>
        ))}
      </svg>
      <figcaption className="text-xs text-ink-3">One dot per close. The lines between dots are not prices. ▲ fee taken.</figcaption>
    </figure>
  );
}
