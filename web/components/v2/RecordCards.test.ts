/**
 * The card half of card-below-sm (UX review item 6).
 *
 * AUTHORED, NOT RUN — this worktree is not hydrated (no node_modules; vitest and tsc both exit
 * 127). Reported to the operator rather than repaired, and recorded in the ledger.
 *
 * WHAT THESE ASSERT, and why it is not "cards render": the whole risk in this change is that a
 * card silently carries fewer fields than the row it replaces. That failure looks fine on a phone
 * — a tidy card with four of nine values — and there is nothing on screen to say a value is
 * missing. So every test below names fields and counts them rather than checking the markup is
 * non-empty.
 */
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RecordCards, TableOrCards, type RecordCard } from "./RecordCards";

const cards: RecordCard[] = [
  {
    id: "0xaaa",
    title: "0xaaa…aaa",
    subtitle: "Role ID 7",
    fields: [
      { label: "Score", value: "91.4" },
      { label: "Uptime", value: "99.1%" },
      { label: "Holders", wide: true, value: "two addresses" },
    ],
  },
  { id: "0xbbb", title: "0xbbb…bbb", highlighted: true, fields: [{ label: "Score", value: "12.0" }] },
];

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("RecordCards", () => {
  it("renders every field under its own column heading", () => {
    const html = render(createElement(RecordCards, { label: "Maker scores", cards }));
    for (const label of ["Score", "Uptime", "Holders"]) expect(html, label).toContain(label);
    for (const value of ["91.4", "99.1%", "two addresses", "12.0"]) expect(html, value).toContain(value);
  });

  it("emits one dt per field, so a dropped field is a count change and not a silent omission", () => {
    // The control for the whole file: three fields on the first card, one on the second.
    const html = render(createElement(RecordCards, { label: "Maker scores", cards }));
    expect(html.match(/<dt/g)?.length).toBe(4);
    expect(html.match(/<dd/g)?.length).toBe(4);
  });

  it("labels the list, so the phone layout is not the less accessible one", () => {
    expect(render(createElement(RecordCards, { label: "Maker scores", cards }))).toContain('aria-label="Maker scores"');
  });

  it("carries the subtitle and the highlight a table row would have had", () => {
    const html = render(createElement(RecordCards, { label: "Maker scores", cards }));
    expect(html).toContain("Role ID 7");
    expect(html).toContain("bg-accent-soft");
  });

  it("gives a wide field the full card width and a normal field half of it", () => {
    const html = render(createElement(RecordCards, { label: "Maker scores", cards }));
    expect(html).toContain("col-span-2");
    // Two columns is the grid; a wide field opts out of it rather than the grid being one column.
    expect(html).toContain("grid-cols-2");
  });
});

/**
 * TableOrCards with the table passed as a CHILD, not as a `children` prop (react/no-children-prop).
 * TableOrCards declares `children` REQUIRED and createElement's props parameter cannot see it arrive
 * by the third argument (TS2769), so the props are widened to the full type here, once, rather than
 * at every call. At run time React sets `props.children` from that argument exactly as before.
 */
function tableOrCards(props: Omit<ComponentProps<typeof TableOrCards>, "children">, table: ReactNode) {
  return createElement(TableOrCards, props as ComponentProps<typeof TableOrCards>, table);
}

describe("TableOrCards", () => {
  it("renders BOTH halves and hides each at the opposite breakpoint", () => {
    // Neither half may be dropped: the table is the desktop layout and the cards are the phone
    // one, and shipping only one of them is the bug in either direction.
    const html = render(tableOrCards(
      { cards, cardsLabel: "Maker scores" },
      createElement("table", { "data-test": "the-table" }),
    ));
    expect(html).toContain('class="hidden sm:block"');
    expect(html).toContain('data-test="the-table"');
    expect(html).toMatch(/aria-label="Maker scores"[^>]*class="[^"]*sm:hidden/);
  });

  it("the table half is what carries the wide minWidth, so the cards are never the scrolling one", () => {
    const html = render(tableOrCards(
      { cards, cardsLabel: "Maker scores" },
      createElement("div", { style: { minWidth: 790 } }),
    ));
    const cardsHalf = html.slice(html.indexOf('aria-label="Maker scores"'));
    expect(cardsHalf).not.toContain("min-width");
    expect(cardsHalf).not.toContain("790");
  });
});
