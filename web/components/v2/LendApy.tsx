"use client";

/**
 * The public interest on /earn (was /lend): realised (net of the cut), the venue's own rate, and the net estimate,
 * each with the window it covers and, when there is no figure, why. The decisions live in lib/v2/lendApy.ts.
 */
import { ExternalLink, InfoTip, Row, Rows } from "@/components/ui";
import type { ApyFigure, LendApyView } from "@/lib/v2/lendApy";

const NOT_SENT = "The vault's interest rate isn't reported yet.";
const NO_VENUE = "No lending venue is attached, so idle USDG earns nothing.";

function sentence(note: string): string {
  const text = note.charAt(0).toUpperCase() + note.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function lendRateStat(view: LendApyView): { value: string | null; tip: string } {
  if (view.kind === "unconfigured") return { value: null, tip: "The Earn vault is not live yet, so there is no rate." };
  if (view.kind === "not-sent") return { value: null, tip: NOT_SENT };
  if (view.venue === null) return { value: null, tip: NO_VENUE };
  const net = view.venue.net;
  return {
    value: net.text,
    tip: net.text === null ? sentence(net.note) : `${sentence(net.note)} Annualised. Not a promise of future rates.`,
  };
}

function FigureRow({ label, figure }: { label: string; figure: ApyFigure }) {
  return <Row k={label} tip={sentence(figure.note)} v={figure.text ?? "—"} />;
}

export function LendApy({ view }: { view: LendApyView }) {
  if (view.kind === "unconfigured") return null;
  if (view.kind === "not-sent") {
    return <section aria-label="Interest rate" className="grid gap-2">
      <h3 className="font-display text-[15px] font-bold text-ink">Interest rate</h3>
      <p>{NOT_SENT}</p>
    </section>;
  }
  return <section aria-label="Interest rate" className="grid gap-2">
    <h3 className="flex items-center gap-1.5 font-display text-[15px] font-bold text-ink">Interest rate
      <InfoTip label="About these rates" align="start" text="Annualised from what was measured over the window on each figure. Not a promise of future rates." />
    </h3>
    <Rows>
      <FigureRow label="Earned · 7 days (after our cut)" figure={view.realised7d} />
      <FigureRow label="Earned · 30 days (after our cut)" figure={view.realised30d} />
    </Rows>
    {view.venue === null
      ? <p>{NO_VENUE}</p>
      : <>
        <p className="mt-2">
          Idle USDG is lent to{" "}
          {view.venue.href
            ? <ExternalLink href={view.venue.href} arrow className="font-semibold text-ink underline underline-offset-2">{view.venue.name ?? "the venue"}</ExternalLink>
            : <span className="font-semibold text-ink">{view.venue.name ?? "the venue"}</span>}
          . Its rate is measured on chain; our cut{view.skimPercent ? ` (${view.skimPercent})` : ""} comes out of it.
        </p>
        <Rows>
          <FigureRow label="Venue · 24 hours" figure={view.venue.apy24h} />
          <FigureRow label="Venue · 7 days" figure={view.venue.apy7d} />
          <FigureRow label="Your net · estimate" figure={view.venue.net} />
        </Rows>
      </>}
  </section>;
}
