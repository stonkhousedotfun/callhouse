import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { STATUS } from "@/lib/site";
import type { ConfigResponse, PendingAdminOperation } from "@/lib/v2/api-types";
import { TrustPageView } from "./TrustPage";

type TrustConfig = Pick<ConfigResponse, "contracts" | "safes" | "access" | "pendingOperations">;

const contracts: ConfigResponse["contracts"] = {
  clearinghouse: "0x0000000000000000000000000000000000000001",
  orderBook: "0x0000000000000000000000000000000000000002",
  settlementOracle: null,
  expiryCalendar: null,
  keeperRewards: null,
  autoRoller: null,
  payoutAdapter: null,
  makerVault: null,
  makerRegistry: null,
  rewardsDistributor: null,
  accessManager: "0x0000000000000000000000000000000000000003",
  sources: { chainlink: null, univ3: null, dataStreams: null },
};

const fixture: TrustConfig = {
  contracts,
  safes: {
    admin: "0x0000000000000000000000000000000000000004",
    treasury: "0x0000000000000000000000000000000000000005",
  },
  access: {
    manager: "0x0000000000000000000000000000000000000003",
    roles: [{
      id: 2,
      name: "MARKET_FEE_MANAGER_ROLE",
      delayS: 172800,
      holders: [{ address: "0x0000000000000000000000000000000000000006", delayS: 86400 }],
    }],
  },
  pendingOperations: [],
};

function render(data: TrustConfig): string {
  return renderToStaticMarkup(createElement(TrustPageView, { data }));
}

describe("trust page", () => {
  it("renders the runtime role table, delays, and holders", () => {
    const html = render(fixture);

    expect(html).toContain("MARKET_FEE_MANAGER_ROLE");
    expect(html).toContain(">2 days<");
    expect(html).toContain("1 day holder delay");
    expect(html).toContain("0x0000000000000000000000000000000000000006");
  });

  it("states the guardian limit and shows no audit status", () => {
    const html = render(fixture);

    expect(html).toContain("cannot cancel ADMIN-lane operations");
    expect(html).toContain("role grants and selector mappings");
    expect(html).not.toContain(STATUS.audit);
    expect(html).not.toContain(STATUS.auditLine);
    expect(html).not.toMatch(/\baudit/i);
  });

  it("reports an absent access block without rendering an empty role table", () => {
    const html = render({ ...fixture, access: undefined });

    expect(html).toContain("Role and holder data are not published yet.");
    expect(html).not.toContain('aria-label="Protocol access roles and holders"');
  });

  it("links to Market status, which left the top-level nav for this page (UX review item 5)", () => {
    const html = render(fixture);

    expect(html).toMatch(/<a [^>]*href="\/trust\/markets"[^>]*>Market status<\/a>/);
    // The link it sits beside is still there.
    expect(html).toMatch(/<a [^>]*href="\/trust\/burns"[^>]*>Token burns<\/a>/);
  });
});

/**
 * UX review item 6: the roles table set `minWidth={760}`, two full screens of sideways scroll on
 * a 390px phone. Below `sm` it is now a card list.
 *
 * THE ASSERTION THAT MATTERS IS NOT "cards exist" — it is that the cards carry EVERY column the
 * table carried. Dropping columns under `sm` is the cheap fix and the wrong one: a value a phone
 * user cannot see and cannot know about is the nav-mask defect in a table. So each test below
 * names a specific cell and asserts it survived into the card markup.
 */

/**
 * Just the card half of the markup.
 *
 * WRITTEN TWICE, BECAUSE THE FIRST VERSION WAS A FALSE GREEN AND THE MUTATION CAUGHT IT. It
 * anchored on `aria-label="Protocol access roles and holders"` — which the `<Table>` carries too,
 * and the table is rendered FIRST. So the slice began at the table, every column heading was
 * "found" in the `<th>` row, and deleting a card field left the test green. Anchoring on
 * `sm:hidden`, which only the card list has, is what makes the assertions below load-bearing:
 * with this anchor, dropping a card field turns them red.
 */
function cardHalf(html: string): string {
  const at = html.indexOf("sm:hidden");
  expect(at, "the card list was located — the control for every assertion using this").toBeGreaterThan(-1);
  return html.slice(at);
}

describe("trust page roles on a phone", () => {
  it("renders both a table and a card list, and hides one at each breakpoint", () => {
    const html = render(fixture);
    expect(html).toContain('class="hidden sm:block"');
    expect(html).toMatch(/aria-label="Protocol access roles and holders"[^>]*class="[^"]*sm:hidden/);
  });

  it("the card list keeps EVERY column the table has, not a subset", () => {
    const html = render(fixture);
    const cards = cardHalf(html);
    expect(cards, "role name").toContain("MARKET_FEE_MANAGER_ROLE");
    expect(cards, "role id, which was its own column").toContain("Role ID 2");
    expect(cards, "role delay column heading").toContain("Role delay");
    expect(cards, "holders column heading").toContain("Holders");
    expect(cards, "the holder address itself").toContain("0x0000000000000000000000000000000000000006");
    // The delay values are formatted by the same helper the table row uses, so a card and a row
    // cannot disagree about the same number.
    expect(cards, "holder delay").toContain("holder delay");
  });

  it("the card list is labelled, so the phone layout is not the less accessible one", () => {
    expect(render(fixture)).toContain('aria-label="Protocol access roles and holders"');
  });

  it("says so when a role has no holders rather than rendering an empty cell", () => {
    const empty = { ...fixture, access: { ...fixture.access!, roles: [{ ...fixture.access!.roles[0]!, holders: [] }] } };
    const html = render(empty as TrustConfig);
    expect(cardHalf(html)).toContain("No holders published.");
  });
});

/**
 * The pending-operation time comes from the shared `stamp()` in lib/v2/time.ts, not a
 * local formatter. Two instants at the SAME New York wall-clock time on opposite sides of the US
 * daylight-saving change: a formatter that lost its zone renders 8:00 PM / 9:00 PM on a UTC
 * runner, and one that hard-coded the suffix names the wrong zone for half the year.
 */
const SUMMER = Date.UTC(2026, 8, 21, 20, 0, 0) / 1000; // 16:00 New York, EDT
const WINTER = Date.UTC(2026, 0, 21, 21, 0, 0) / 1000; // 16:00 New York, EST

function pending(key: string, id: string, label: string, readyAt: number): PendingAdminOperation {
  return {
    key, id, label, readyAt,
    role: "ADMIN",
    target: "0x0000000000000000000000000000000000000001",
    selector: "0x12345678",
    caller: "0x0000000000000000000000000000000000000004",
    scheduledAt: readyAt - 172_800,
  };
}

describe("NEW_LISTING is shown as a zero-delay lane that can only set up a new market", () => {
  const withNewListing: TrustConfig = { ...fixture, access: { ...fixture.access!, roles: [
    ...fixture.access!.roles,
    { id: 11, name: "NEW_LISTING", delayS: 0, holders: [{ address: "0x0000000000000000000000000000000000000004", delayS: 0 }] },
  ] } };
  const NOTE = "only set up a market that does not exist yet";

  it("the table and the card list both carry the note on the NEW_LISTING row, beside its No delay", () => {
    const html = render(withNewListing);
    const at = html.indexOf("sm:hidden");
    const table = html.slice(0, at);
    const cards = cardHalf(html);
    for (const [half, where] of [[table, "table"], [cards, "cards"]] as const) {
      expect(half, where).toContain("NEW_LISTING");
      expect(half, where).toContain(NOTE);
      expect(half.match(/data-slot="role-scope"/g)?.length, `${where}: one note, on one row`).toBe(1);
    }
    expect(table).toMatch(/NEW_LISTING<p[^>]*data-slot="role-scope"[^>]*>No delay by design/);
  });

  it("no other role carries it", () => {
    expect(render(fixture)).not.toContain('data-slot="role-scope"');
  });
});

describe("trust page pending operations", () => {
  it("renders each ready time in New York, naming EDT or EST by the date", () => {
    const html = render({ ...fixture, pendingOperations: [
      pending("0xaa:1", "0xaa", "Raise the fee", SUMMER),
      pending("0xbb:1", "0xbb", "Lower the fee", WINTER),
    ] });

    expect(html).toContain("Sep 21, 4:00 PM EDT"); // server render (and hydration) shows New York, zone named; the browser switches to the reader's zone.
    expect(html).toContain("Jan 21, 4:00 PM EST");
  });

  it("keys each row on the unique operation key, not the operationId a reschedule reuses", () => {
    // A rescheduled operation keeps its operationId and gets a new nonce, so `id` repeats while
    // `key` (`operationId:nonce`) does not — see PendingAdminOperation in api-types and the same
    // choice in PendingOperationsNotice. Both rows must render.
    const html = render({ ...fixture, pendingOperations: [
      pending("0xaa:1", "0xaa", "First schedule", SUMMER),
      pending("0xaa:2", "0xaa", "Rescheduled", WINTER),
    ] });
    expect(html).toContain("First schedule");
    expect(html).toContain("Rescheduled");

    // WHY THIS READS THE SOURCE. A duplicate React key is only diagnosed by the client reconciler;
    // renderToStaticMarkup renders both rows and warns about nothing (measured on react-dom 19.3.0),
    // and this suite deliberately has no DOM environment. So the render above cannot tell `id`
    // from `key`, and the guard is the key expression itself.
    const source = readFileSync(resolve(import.meta.dirname, "TrustPage.tsx"), "utf8");
    expect(source).toContain("<li key={operation.key}");
    expect(source).not.toContain("key={operation.id}");
  });
});

/**
 * At delay 0 nothing is scheduled, so the guardian has nothing to cancel. The page says so -- only when the
 * Admin Safe's holder delay reads 0 on every one of role ids 0-5 -- and hides the line when any lane is non-zero,
 * unread or missing. Pending operations show a ready DATE, never a clock, including one whose readyAt has passed.
 */
describe("admin changes at delay 0", () => {
  const SAFE = "0x0000000000000000000000000000000000000004";
  const lanes = (delays: Partial<Record<number, number>> = {}, drop?: number) => ({
    manager: "0x0000000000000000000000000000000000000003",
    roles: [0, 1, 2, 3, 4, 5].filter((id) => id !== drop).map((id) => ({
      id, name: `R${id}`, delayS: 0, holders: [{ address: SAFE.toUpperCase().replace("0X", "0x"), delayS: delays[id] ?? 0 }],
    })),
  });
  const ADMIN_LINE = "take effect immediately, with no scheduled notice";

  it("shows the immediate-effect line when every one of role ids 0-5 reads 0 for the Admin Safe", () => {
    const html = render({ ...fixture, access: lanes() });
    expect(html).toContain('data-slot="admin-immediate"');
    expect(html).toContain(ADMIN_LINE);
    // The guardian sentence stays: it is true again after the lock.
    expect(html).toContain("cancel scheduled fee");
  });

  it("hides it when any lane is non-zero, a lane is missing, the access table is unread, or the Safe is unknown", () => {
    for (const id of [0, 1, 2, 3, 4, 5]) {
      expect(render({ ...fixture, access: lanes({ [id]: 86_400 }) }), `role ${id} non-zero`).not.toContain(ADMIN_LINE);
      expect(render({ ...fixture, access: lanes({}, id) }), `role ${id} missing`).not.toContain(ADMIN_LINE);
    }
    expect(render({ ...fixture, access: undefined })).not.toContain(ADMIN_LINE);
    expect(render({ ...fixture, access: lanes(), safes: undefined })).not.toContain(ADMIN_LINE);
  });

  it("the lede no longer calls the roles delayed", () => {
    const html = render(fixture);
    expect(html).not.toContain("delayed roles");
    expect(html).toContain("role delays");
  });

  it("pending operations, empty: says none are scheduled", () => {
    expect(render({ ...fixture, pendingOperations: [] })).toContain("No pending administrative operations are scheduled.");
  });

  it("pending operations, readyAt already past: the ready date renders, with no countdown and no negative or zero clock", () => {
    const readyAt = Math.floor(Date.now() / 1000) - 3_600;
    const op: PendingAdminOperation = {
      key: `0x${"4".repeat(64)}:1`, id: `0x${"4".repeat(64)}`, role: "FEE_MANAGER", target: "0x1111111111111111111111111111111111111111",
      selector: "0x12345678", label: "Set burn split", caller: SAFE, scheduledAt: readyAt, readyAt,
    };
    const html = render({ ...fixture, pendingOperations: [op] });
    expect(html).toContain("Set burn split");
    expect(html).toContain(new Date(readyAt * 1000).toISOString());
    expect(html).not.toContain('role="timer"');
    // Visible text only: the <time dateTime> attribute is an ISO stamp with seconds, not a clock a reader sees.
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/\d\d:\d\d:\d\d|-\d+\s*(s|sec|m|h)\b|\b0s\b|\bnow\b/);
  });
});
