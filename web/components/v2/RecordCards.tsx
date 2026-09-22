/**
 * The card half of "card list below `sm`, table above" — the pattern `MarketDirectoryCard` already
 * demonstrates, generalised for tables whose rows are records rather than products.
 *
 * WHY THIS EXISTS. `MakersPage` set `minWidth={790}` and `TrustPage` `minWidth={760}`; at a 390px
 * phone that is two full screens of sideways scroll each. A table that wide on a phone is not a
 * table, it is a horizontal filmstrip of numbers with the row header scrolled off.
 *
 * EVERY FIELD SURVIVES. The obvious cheap fix is to drop columns under `sm`, and it is the wrong
 * one: a column a phone user cannot see and cannot know about is the same defect as the nav mask
 * that fades links away with no affordance — the information is gone and nothing says so. So a
 * card carries EVERY cell its table row carried, each under its own column heading. The layout
 * changes; the content does not.
 *
 * PRESENTATIONAL ONLY. It takes already-rendered cells, so the page keeps one source of truth for
 * how a value is formatted and the card and the row cannot drift into disagreeing about the same
 * number.
 */
import type { ReactNode } from "react";

import { Panel } from "@/components/ui";

export type RecordCardField = {
  /** The column heading this value sat under. Never omitted — it is what replaces the header row. */
  label: string;
  value: ReactNode;
  /** A value that needs the full card width (an address list, a long label) rather than a column. */
  wide?: boolean;
};

export type RecordCard = {
  /** Stable key, and the card's own heading — the equivalent of the row's first cell. */
  id: string;
  title: ReactNode;
  /** Optional line under the title, for a value that identifies the row rather than measuring it. */
  subtitle?: ReactNode;
  fields: RecordCardField[];
  /** Mirrors a highlighted table row, e.g. the connected wallet's own line. */
  highlighted?: boolean;
};

/**
 * `aria-label` is required rather than optional: this list replaces a labelled `<table>` below
 * `sm`, and dropping the label would mean the mobile layout is the less accessible one — the
 * opposite of the point.
 */
export function RecordCards({ label, cards, className }: {
  label: string;
  cards: RecordCard[];
  className?: string;
}) {
  return <ul aria-label={label} className={`space-y-3 ${className ?? ""}`.trim()}>
    {cards.map((card) => <li key={card.id}>
      <Panel as="article" className={card.highlighted ? "bg-accent-soft" : undefined}>
        <div className="min-w-0">
          <h3 className="font-display text-lg font-bold">{card.title}</h3>
          {card.subtitle ? <p className="mt-1 text-sm text-ink-2">{card.subtitle}</p> : null}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          {card.fields.map((field) => <div key={field.label} className={field.wide ? "col-span-2" : undefined}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-3">{field.label}</dt>
            <dd className="num mt-1 text-sm font-semibold">{field.value}</dd>
          </div>)}
        </dl>
      </Panel>
    </li>)}
  </ul>;
}

/**
 * The responsive pair. One call site, so a page cannot ship the table and forget the cards, and so
 * the breakpoint is stated once instead of being repeated as two opposing utility classes that
 * someone later changes on only one of them.
 */
export function TableOrCards({ cards, cardsLabel, className, children }: {
  cards: RecordCard[];
  cardsLabel: string;
  className?: string;
  /** The `<Table>` to show at `sm` and above. */
  children: ReactNode;
}) {
  return <>
    <div className="hidden sm:block">{children}</div>
    <RecordCards label={cardsLabel} cards={cards} className={`sm:hidden ${className ?? ""}`.trim()} />
  </>;
}
