import { ImageResponse } from "next/og";
import { cache } from "react";

import type { SeriesRef } from "@/lib/v2/api-types";
import { expiryLabel, seriesTitle } from "@/components/v2/PnlText";

/**
 * The series route's share image in the Neon night palette (the design's palette, type
 * and market page): black ground, lime mark and curve, Plus Jakarta Sans. The shared brand image
 * (components/v2/PnlImage.tsx) still carries the Daylight palette; its redesign is the receipt/OG row, so this route
 * draws its own rather than restyling a file another row owns.
 *
 * NOTHING HERE IS A QUOTE. The card names the series and its expiry and states the buyer's risk. The curve is the
 * brand shape of the payoff chart (flat at 0, then up), with no axis, price or figure on it, so it cannot be read as
 * a live payoff.
 */
export const NEON_NIGHT = {
  ground: "#000000", surface: "#0E0E0E", line: "#1C1C1C", ink: "#FFFFFF", ink3: "#9A9A9A", accent: "#C8FF2E",
  dangerText: "#FF8A7E",
} as const;

export type SeriesImageLines = { eyebrow: string; headline: string; detail: string; risk: string };

/** The copy for a live series. Pure, so the wording is tested without rendering an image. */
export function seriesImageLines(series: SeriesRef): SeriesImageLines {
  return {
    eyebrow: `${series.ticker} · ${series.isPut ? "Put" : "Call"} option`,
    headline: seriesTitle(series),
    detail: `Expires ${expiryLabel(series.expiry)} · settles on an averaged price`,
    risk: "Max loss is the amount paid",
  };
}

/** A route that cannot name a live series still gets a card, and it says nothing about a price. */
export function neutralSeriesImageLines(): SeriesImageLines {
  return { eyebrow: "Options on Stock Tokens", headline: "Know your upside. Know your max loss.",
    // Not "Daily": SPCX lists Friday closes only.
    detail: "NVDA and SPCX options on Robinhood Chain", risk: "You can lose the full amount paid" };
}

type Font = { name: string; data: ArrayBuffer; weight: 500 | 800; style: "normal" };

/** A glyph subset of one weight at render time; a failed fetch falls back to the renderer's sans rather than failing. */
const loadFont = cache(async (weight: 500 | 800, glyphs: string): Promise<Font | null> => {
  try {
    const text = encodeURIComponent([...new Set(glyphs)].join(""));
    const css = await fetch(`https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@${weight}&text=${text}`,
      { signal: AbortSignal.timeout(8_000), cache: "force-cache" });
    if (!css.ok) return null;
    const source = (await css.text()).match(/src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/)?.[1];
    if (!source) return null;
    const file = await fetch(source, { signal: AbortSignal.timeout(8_000), cache: "force-cache" });
    return file.ok ? { name: "Plus Jakarta Sans", data: await file.arrayBuffer(), weight, style: "normal" } : null;
  } catch {
    return null;
  }
});

export const SERIES_IMAGE_SIZE = { width: 1200, height: 630 } as const;

export async function renderSeriesImage(lines: SeriesImageLines): Promise<ImageResponse> {
  const c = NEON_NIGHT;
  const glyphs = `${Object.values(lines).join(" ")}stonkhouse app.stonkhouse.fun`;
  const [bold, regular] = await Promise.all([loadFont(800, glyphs), loadFont(500, glyphs)]);
  const fonts = bold && regular ? [bold, regular] : undefined;
  const family = fonts ? "Plus Jakarta Sans" : "sans-serif";
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
      backgroundColor: c.ground, color: c.ink, padding: "56px 64px", fontFamily: family, position: "relative" }}>
      <svg width="560" height="300" viewBox="0 0 560 300" style={{ position: "absolute", right: 40, bottom: 110 }}>
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={c.accent} stopOpacity="0.34" />
            <stop offset="1" stopColor={c.accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M0 290 C 180 290, 250 270, 330 200 S 470 40, 560 10 L 560 300 L 0 300 Z" fill="url(#fill)" />
        <path d="M0 290 C 180 290, 250 270, 330 200 S 470 40, 560 10" fill="none" stroke={c.accent} strokeWidth="7"
          strokeLinecap="round" />
      </svg>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 800, letterSpacing: "-0.03em" }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.accent }} />stonkhouse
        </div>
        <div style={{ color: c.ink3, fontSize: 20, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase" }}>{lines.eyebrow}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
        <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1, letterSpacing: "-0.045em" }}>{lines.headline}</div>
        <div style={{ color: c.ink3, fontSize: 28, fontWeight: 500 }}>{lines.detail}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `2px solid ${c.line}`,
        paddingTop: 22, fontSize: 24, fontWeight: 500 }}>
        <div style={{ color: c.dangerText }}>{lines.risk}</div><div style={{ color: c.ink3 }}>app.stonkhouse.fun</div>
      </div>
    </div>,
    { ...SERIES_IMAGE_SIZE, fonts },
  );
}
