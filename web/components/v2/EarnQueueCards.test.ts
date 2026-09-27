/**
 * The queue cards, the redeem preview line and the owed banner, rendered with react-dom/server in vitest's
 * node environment as the other component tests here are. Rendering on the server at all is the SSR-safety check:
 * none of these reads `window`, a wallet or the chain.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { heldPaymentsView, type HeldPaymentsRead } from "@/lib/v2/earnDeferred";
import type { QueuedRequestCard } from "@/lib/v2/earnQueue";
import { WITHDRAWAL_PAID_NOTE, redeemPreview } from "@/lib/v2/earnQueue";
import { faqHref } from "@/lib/v2/earliestWithdrawal";
import { owedBanner } from "@/lib/v2/owed";
import { EarnQueueCards, HeldPaymentCardView, HeldPayments, QueuedRequestCardView, RedeemPreviewLine } from "./EarnQueueCards";
import { OWED_LINE, OwedBanner } from "./OwedBanner";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const esc = (s: string) => s.replace(/'/g, "&#x27;");

const card = (over: Partial<QueuedRequestCard> = {}): QueuedRequestCard => ({
  key: "0x66-5", kind: "withdrawal", title: "Queued withdrawal #5", escrow: "3.0000 shares held by the vault", partial: null,
  position: "2nd in line, 1 request ahead", reason: "Earlier requests are ahead of it.",
  expected: "After the open option settles, after today's 4pm ET close", note: WITHDRAWAL_PAID_NOTE,
  faqHref: faqHref("earn"), cancelId: 5n, cancelLabel: "Cancel and return shares", ...over,
});

describe("queued request cards", () => {
  it("render every state field, the FAQ link and an enabled Cancel", () => {
    const out = html(createElement(QueuedRequestCardView, { card: card(), canAct: true, busy: false, onCancel: () => {} }));
    for (const text of ["Queued withdrawal #5", "2nd in line, 1 request ahead", "3.0000 shares held by the vault",
      "Earlier requests are ahead of it.", esc("After the open option settles, after today's 4pm ET close"),
      "You will be paid automatically when it clears", "&quot;Payments held for you&quot;", "How the queue works", "Cancel and return shares"])
      expect(out).toContain(text);
    expect(out).toContain(`href="${faqHref("earn")}"`);
    expect(out).toContain('data-queued-request="withdrawal"');
    expect(out).not.toMatch(/<button[^>]* disabled=""/);
  });

  it("disable Cancel with no wallet or while another write runs, and offer none without a queue id", () => {
    expect(html(createElement(QueuedRequestCardView, { card: card(), canAct: false, busy: false, onCancel: () => {} })))
      .toMatch(/<button[^>]* disabled=""[^>]*>Cancel and return shares/);
    expect(html(createElement(QueuedRequestCardView, { card: card(), canAct: true, busy: true, onCancel: () => {} })))
      .toMatch(/<button[^>]* disabled=""[^>]*>Cancel and return shares/);
    const none = html(createElement(QueuedRequestCardView, { card: card({ cancelId: null }), canAct: true, busy: false, onCancel: () => {} }));
    expect(none).not.toContain("<button");
    expect(none).toContain("Queued withdrawal #5");
  });

  it("show previewQueued's line under the card's terms when the page read it, and nothing before", () => {
    const shown = html(createElement(QueuedRequestCardView, { card: card({ contractPreview: "If served now: 4 USDG." }),
      canAct: true, busy: false, onCancel: () => {} }));
    expect(shown).toMatch(/<p data-slot="queued-contract-preview"[^>]*>If served now: 4 USDG\.<\/p>/);
    expect(shown.indexOf('data-slot="queued-contract-preview"')).toBeGreaterThan(shown.indexOf("Earlier requests are ahead of it."));
    expect(shown.indexOf('data-slot="queued-contract-preview"')).toBeLessThan(shown.indexOf("Cancel and return shares"));
    for (const unread of [null, undefined])
      expect(html(createElement(QueuedRequestCardView, { card: card({ contractPreview: unread }), canAct: true, busy: false,
        onCancel: () => {} }))).not.toContain("queued-contract-preview");
  });

  it("show a partly served request's progress, and a deposit's own words", () => {
    const partial = html(createElement(QueuedRequestCardView, { card: card({ partial: "Partly paid: 1.0000 of 3.0000 shares served so far." }),
      canAct: true, busy: false, onCancel: () => {} }));
    expect(partial).toContain("Partly paid: 1.0000 of 3.0000 shares served so far.");
    const dep = html(createElement(QueuedRequestCardView, { card: card({ kind: "deposit", title: "Queued deposit #6",
      escrow: "250.00 USDG held by the vault", cancelLabel: "Cancel and return USDG" }), canAct: true, busy: false, onCancel: () => {} }));
    expect(dep).toContain('data-queued-request="deposit"');
    expect(dep).toContain("250.00 USDG held by the vault");
    expect(dep).toContain("Cancel and return USDG");
  });

  it("the list renders nothing when nothing is queued, and a titled section otherwise", () => {
    expect(html(createElement(EarnQueueCards, { cards: [], canAct: true, busy: false, onCancel: () => {} }))).toBe("");
    const out = html(createElement(EarnQueueCards, { cards: [card(), card({ key: "0x66-6", title: "Queued deposit #6", kind: "deposit" })],
      canAct: true, busy: false, onCancel: () => {} }));
    expect(out).toContain("Your queued lending requests");
    expect(out.match(/data-queued-request=/g)).toHaveLength(2);
  });

  it("Cancel hands the card to the page's handler, which owns the write", () => {
    const onCancel = vi.fn();
    const element = QueuedRequestCardView({ card: card(), canAct: true, busy: false, onCancel });
    // Walk the rendered tree to the Cancel button and press it: the component adds nothing of its own to the call.
    const find = (node: unknown): { props: { onClick?: () => void; children?: unknown } } | null => {
      if (!node || typeof node !== "object") return null;
      const el = node as { props?: { onClick?: () => void; children?: unknown } };
      if (el.props?.onClick && el.props.children === "Cancel and return shares") return el as never;
      const kids = el.props?.children;
      for (const child of Array.isArray(kids) ? kids : [kids]) { const hit = find(child); if (hit) return hit; }
      return null;
    };
    find(element)!.props.onClick!();
    expect(onCancel).toHaveBeenCalledWith(card());
  });
});

describe("redeem preview line", () => {
  it("says what the vault's state means for a redeem made now, with its reason and the FAQ link", () => {
    const preview = redeemPreview({ ew: { kind: "queued", at: null, reason: "venue-liquidity", liquidityCap: "0" },
      shares: null, assetsPerShare: null, shareDecimals: 18, queueDepth: null, now: 1_790_362_800 });
    const out = html(createElement(RedeemPreviewLine, { preview }));
    expect(out).toContain("If you redeem now:");
    expect(out).toContain("Will queue: waiting for venue liquidity");
    expect(out).toContain('data-redeem-preview="queues"');
    expect(out).toContain('<span class="sr-only">');
    expect(out).toContain(`href="${faqHref("earn")}"`);
  });
});

describe("owed banner", () => {
  it("shows the amount, why it is held, and a Claim button for an observed positive balance", () => {
    const out = html(createElement(OwedBanner, { model: owedBanner(2_500_000n), canAct: true, busy: false, onClaim: () => {} }));
    expect(out).toContain("2.50 USDG waiting for you in the order book");
    // One short line instead of lib/v2/owed.ts's OWED_EXPLAINER paragraph.
    expect(out).toContain(esc(OWED_LINE));
    expect(out).toMatch(/<button[^>]*>Claim 2.50 USDG<\/button>/);
    expect(out).not.toMatch(/<button[^>]* disabled=""/);
    expect(out).toContain('data-owed-banner="2500000"');
  });

  it("renders nothing for zero or an unread balance, and disables Claim without a wallet or during a write", () => {
    expect(html(createElement(OwedBanner, { model: owedBanner(0n), canAct: true, busy: false, onClaim: () => {} }))).toBe("");
    expect(html(createElement(OwedBanner, { model: owedBanner(null), canAct: true, busy: false, onClaim: () => {} }))).toBe("");
    for (const [canAct, busy] of [[false, false], [true, true]] as const)
      expect(html(createElement(OwedBanner, { model: owedBanner(1n), canAct, busy, onClaim: () => {} })))
        .toMatch(/<button[^>]* disabled=""[^>]*>Claim/);
  });
});

/*
 * A payment the vault HELD (lib/v2/earnDeferred.ts), shown with a Claim to a receiver the user may change.
 */
const ME = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const VAULT = "0x00000000000000000000000000000000000000E5" as const;
const heldRead = (over: Partial<{ owner: `0x${string}`; receiver: `0x${string}` }> = {}): HeldPaymentsRead => ({
  status: "ok", complete: true, checked: 3,
  items: [{ vault: VAULT, id: 7n, owner: over.owner ?? ME, receiver: over.receiver ?? ME, assets: 12_500_000n }],
});

describe("held payments", () => {
  it("render the amount, why it is held, the receiver field at the connected wallet, and an enabled Claim", () => {
    const view = heldPaymentsView(heldRead(), ME);
    const out = html(createElement(HeldPayments, { view, canAct: true, busy: false, onClaim: () => {} }));
    for (const text of ["Payments held for you", "Held payment for request #7", "12.50 USDG", "could not deliver the payment",
      "Pay to", `value="${ME}"`, "claim to another address you control"]) expect(out).toContain(text);
    expect(out).toContain('data-held-payment="7"');
    expect(out).toMatch(/<button(?![^>]* disabled="")[^>]*>Claim<\/button>/);
    expect(out).not.toContain("data-receiver-error");
  });

  it("disable Claim without a wallet or while another write runs", () => {
    const [card] = heldPaymentsView(heldRead(), ME).cards;
    for (const props of [{ canAct: false, busy: false }, { canAct: true, busy: true }]) {
      expect(html(createElement(HeldPaymentCardView, { card: card!, ...props, onClaim: () => {} })))
        .toMatch(/<button[^>]* disabled=""[^>]*>Claim<\/button>/);
    }
  });

  it("start from the connected wallet but refuse to claim to a receiver that is not a canonical address", () => {
    // The default is the connected wallet, and that is exactly the address that may be frozen: the field is editable,
    // and an address typed without its checksum (the one form a typo cannot be caught in) keeps Claim disabled.
    const [card] = heldPaymentsView(heldRead(), ME).cards;
    const lower = { ...card!, defaultReceiver: "0x70556baa315dd8d467ea452abcd7deebea073ff9" as `0x${string}` };
    const out = html(createElement(HeldPaymentCardView, { card: lower, canAct: true, busy: false, onClaim: () => {} }));
    expect(out).toMatch(/<button[^>]* disabled=""[^>]*>Claim<\/button>/);
    expect(out).toContain("data-receiver-error");
    expect(out).toContain("mixed-case checksum");
    const good = { ...card!, defaultReceiver: "0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9" as `0x${string}` };
    expect(html(createElement(HeldPaymentCardView, { card: good, canAct: true, busy: false, onClaim: () => {} })))
      .toMatch(/<button(?![^>]* disabled="")[^>]*>Claim<\/button>/);
  });

  it("render nothing when nothing is held, and only the status line when the read failed", () => {
    expect(html(createElement(HeldPayments, { view: heldPaymentsView({ status: "ok", items: [], complete: true, checked: 0 }, ME),
      canAct: true, busy: false, onClaim: () => {} }))).toBe("");
    const failed = html(createElement(HeldPayments, { view: heldPaymentsView({ status: "unavailable", reason: "x" }, ME),
      canAct: true, busy: false, onClaim: () => {} }));
    expect(failed).toContain("could not be checked right now");
    expect(failed).not.toContain("<button");
  });

  it("a wallet that made the request for another receiver: no frozen-wallet warning, and the receiver it could not pay is named", () => {
    const out = html(createElement(HeldPayments, { view: heldPaymentsView(heldRead({ receiver: OTHER }), ME), canAct: true, busy: false, onClaim: () => {} }));
    expect(out).toContain(`The vault could not pay ${OTHER}`);
    expect(out).toContain("because you made the request");
    expect(out).not.toContain("claim to another address you control");
  });
});
