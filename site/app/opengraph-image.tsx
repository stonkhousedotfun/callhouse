import { ImageResponse } from "next/og";

import { CHAIN_NAME, MARKET, SITE_URL } from "@/lib/site";

/**
 * The Open Graph card for callhouse.xyz — the image a link to this site unfurls into in Slack,
 * Telegram, X and iMessage. Next's app/opengraph-image file convention: exporting `alt`, `size`
 * and `contentType` alongside the default render is what makes Next emit the og:image tags, so
 * nothing imports this file and the layout needs no og.images entry.
 *
 * Rendered once at build time into a static PNG. It says what the product is and nothing more:
 * a wordmark, one line, the domain. No number appears on it, which is the point — an OG card is
 * cached by every platform that scrapes it, sometimes for weeks, so any figure baked in here
 * would go stale somewhere we cannot reach. Live numbers live on app.callhouse.xyz.
 *
 * TWO HARD CONSTRAINTS, both of which fail in ways that are not obvious from the error text:
 *
 *   1. NO NETWORK AT BUILD TIME. The common recipe for these fetches a .ttf from Google Fonts
 *      inside the render. A Railway build must not depend on an outbound request — it turns a
 *      deploy into a coin flip against somebody else's CDN. So this uses no `fonts` option at
 *      all and falls back to the face `next/og` already bundles. The system stack named in
 *      `SANS` below is therefore a statement of intent, not a lookup: Satori has no access to
 *      the host's installed fonts, and `fontWeight: 700` may render as the regular face because
 *      only one weight is bundled. That trade is accepted deliberately.
 *
 *   2. SATORI IS NOT A BROWSER. It implements a subset of flexbox and nothing else:
 *      - No CSS grid, no float, no position: absolute tricks beyond the basics.
 *      - EVERY <div> with more than one child MUST carry an explicit `display: "flex"`.
 *        Omitting it is the single most common cause of a build failing here, and the message
 *        ("Expected <div> to have explicit display: flex or none") does not name the element.
 *        Every container below sets it, including ones that currently have a single child, so
 *        that adding a sibling later cannot break the build.
 *      - Interpolated text is composed into a plain string before it is rendered (see `RAIL`),
 *        because a node with several adjacent text children hits the same rule.
 *
 * Colours are verbatim from app/globals.css. Do not introduce a value that is not a token there;
 * this card and the site it links to sit one click apart.
 *
 * Deliberately absent: a chart of any kind, a premium figure, a strike, a logo lockup for
 * Robinhood / Overcall / Valorem (we are not affiliated with any of them), and a per-route
 * variant — four pages share one card.
 */

const BG = "#0b0d10"; /* --bg */
const FG = "#e8edf2"; /* --fg */
const FG_MUTED = "#8a97a6"; /* --fg-muted */
const FG_FAINT = "#5d6874"; /* --fg-faint */
const LINE = "#212932"; /* --line */
const ACCENT = "#7ee0a8"; /* --accent */

/** --sans from globals.css. See constraint 1: intent, not a lookup. */
const SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * The bare host, so the card reads "callhouse.xyz" rather than "https://callhouse.xyz/". Derived
 * from SITE_URL rather than hardcoded so a preview build labels itself honestly.
 */
const DOMAIN = SITE_URL.replace(/^https?:\/\//, "");

/** Composed here, not interpolated in JSX — see constraint 2. */
const RAIL = `${MARKET} · ${CHAIN_NAME}`;

export const alt = "Callhouse — pooled covered calls on Robinhood Chain";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          background: BG,
          color: FG,
          padding: "76px 80px",
          fontFamily: SANS,
        }}
      >
        {/* Top: the accent rule, then the wordmark. The rule is the only ornament on the card —
            a flat bar in --accent, the same figure/ground relationship as app/icon.svg. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", width: 104, height: 6, background: ACCENT }} />
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              marginTop: 48,
              fontSize: 128,
              fontWeight: 700,
              letterSpacing: -5,
              lineHeight: 1,
            }}
          >
            <div style={{ display: "flex", color: FG }}>call</div>
            <div style={{ display: "flex", color: ACCENT }}>house</div>
          </div>
        </div>

        {/* Bottom: the one line, then a hairline rule with the domain on it. The sentence is the
            product's actual claim and its actual limit in the same breath; if this card ever
            promises more than the vault does, it is wrong. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              maxWidth: 920,
              fontSize: 34,
              lineHeight: 1.35,
              color: FG_MUTED,
            }}
          >
            Deposit one tokenised stock, receive vault shares. Premium is paid only if a buyer
            fills.
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 44,
              paddingTop: 28,
              borderTop: `1px solid ${LINE}`,
              fontSize: 26,
              letterSpacing: 1,
            }}
          >
            <div style={{ display: "flex", color: FG }}>{DOMAIN}</div>
            <div style={{ display: "flex", color: FG_FAINT }}>{RAIL}</div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
