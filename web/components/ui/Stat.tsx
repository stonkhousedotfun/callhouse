import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Panel } from "./Panel";

/**
 * One headline figure: a small label, the value in JetBrains Mono, and a line under it. The app's
 * counterpart of the site's <Figure>, sized for a dashboard ("Collateral 1.0600 NVDA").
 *
 *   <Stat label="Shares" value={fmtAsset(v.totalSupply)} unit="cNVDA" sub="1.000000 NVDA per share" />
 *
 * `size`: md 24px (default, the three-up rows) · lg 32px (the one figure a card is about) · sm 18px.
 * `tone` colours the value only. `mono={false}` when the value is words ("open").
 *
 * The unit is a smaller, muted <small> after a space, exactly as the site's Figure renders it, so
 * the value's text reads "1.0600 NVDA" to a screen reader and to the run alike.
 *
 * TEST HOOKS: `data-slot` stat / stat-label / stat-value / stat-sub. The fork acceptance run reads figures by them.
 */
export type StatTone = "ink" | "accent" | "usdg" | "warn" | "danger";

const TONE: Record<StatTone, string> = {
  ink: "text-ink",
  accent: "text-accent-text",
  usdg: "text-usdg",
  warn: "text-warn",
  danger: "text-danger",
};

const SIZE = {
  sm: "text-[18px] leading-[1.25]",
  md: "text-[22px] leading-[1.2] sm:text-[24px]",
  lg: "text-[28px] leading-[1.1] sm:text-[32px]",
} as const;

export type StatProps = {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  size?: keyof typeof SIZE;
  mono?: boolean;
  /** Hover text for the whole figure (what the number is, precisely). */
  title?: string;
  className?: string;
};

export function Stat({ label, value, unit, sub, tone = "ink", size = "md", mono = true, title, className }: StatProps) {
  return (
    <div data-slot="stat" title={title} className={cn("grid min-w-0 content-start gap-1", className)}>
      <div data-slot="stat-label" className="text-[13px] font-medium text-ink-3">
        {label}
      </div>
      <div
        data-slot="stat-value"
        className={cn("font-semibold [overflow-wrap:anywhere]", SIZE[size], mono ? "num" : "font-display", TONE[tone])}
      >
        {value}
        {unit ? (
          <>
            {" "}
            <small className="text-[0.6em] font-medium tracking-normal text-ink-3">{unit}</small>
          </>
        ) : null}
      </div>
      {sub !== undefined && sub !== null ? (
        <div data-slot="stat-sub" className="text-[13px] leading-snug text-ink-3 [overflow-wrap:anywhere]">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A Stat in its own card, with an optional action slot under it: the Portfolio
 * tiles (Realised P&L, Net maker premium, Fees paid, Fill rebates) each carry a "View rows" link to the ledger rows
 * the figure is summed from, and the Wins tiles carry none.
 *
 *   <StatTile label="Fees paid" value="0.00" unit="USDG" action={<Button size="sm" variant="ghost" href="#fees">View rows</Button>} />
 *
 * The tile is a Panel, so it keeps the `card` test hook; the figure inside keeps the Stat hooks, and the action sits
 * in `stat-tile-action`.
 */
export type StatTileProps = StatProps & { action?: ReactNode };

export function StatTile({ action, className, ...stat }: StatTileProps) {
  return (
    <Panel pad="sm" data-tile="stat" className={cn("flex flex-col justify-between gap-4", className)}>
      <Stat {...stat} />
      {action ? <div data-slot="stat-tile-action">{action}</div> : null}
    </Panel>
  );
}
