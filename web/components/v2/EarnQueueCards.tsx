/**
 * The lending vault's queue, as the person waiting in it sees it: a preview line before a redemption, and a
 * card per open request with a Cancel button. The words come from lib/v2/earnQueue.ts; nothing here decides a
 * branch or reads the chain, so each component renders the same on the server and in the browser.
 *
 * The payments the vault HELD for this wallet (lib/v2/earnDeferred.ts), each with a Claim to a receiver the
 * user may change. The receiver field is the one piece of local state here: it starts at the connected wallet and
 * the button enables only for a canonical, non-zero address (earnDeferred.ts parseReceiver).
 */
"use client";

import { useState } from "react";
import type { Address } from "viem";

import { Button, ExternalLink, Panel } from "@/components/ui";
import { HELD_EXPLAINER, HELD_SECTION_TITLE, parseReceiver, type HeldPaymentCard, type HeldPaymentsView } from "@/lib/v2/earnDeferred";
import type { QueuedRequestCard, RedeemPreview } from "@/lib/v2/earnQueue";

export function RedeemPreviewLine({ preview, className }: { preview: RedeemPreview; className?: string }) {
  return <p className={`text-sm text-ink-2 ${className ?? ""}`.trim()} data-redeem-preview={preview.outcome}>
    <span className="font-semibold text-ink">If you redeem now:</span>{" "}
    <span title={preview.tooltip} className="cursor-help underline decoration-dotted underline-offset-2">{preview.line}</span>
    <span className="sr-only"> {preview.tooltip}</span>{" "}
    <ExternalLink href={preview.faqHref} className="text-ink-3 underline underline-offset-2">How withdrawals work</ExternalLink>
  </p>;
}

function Row({ label, children }: { label: string; children: string }) {
  return <div>
    <dt className="text-ink-3 text-xs font-semibold">{label}</dt>
    <dd className="mt-0.5 text-sm text-ink">{children}</dd>
  </div>;
}

export function QueuedRequestCardView({ card, canAct, busy, onCancel }: {
  card: QueuedRequestCard;
  /** A wallet is connected that can send the cancel. The button still shows, disabled, without one. */
  canAct: boolean;
  /** Any write in flight on the page; every Cancel waits for it. */
  busy: boolean;
  onCancel: (card: QueuedRequestCard) => void;
}) {
  return <Panel as="article" pad="sm" className="flex flex-col gap-3" data-queued-request={card.kind}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-base font-extrabold">{card.title}</h3>
      <span className="text-sm font-semibold text-ink-2">{card.position}</span>
    </div>
    <dl className="grid gap-3 sm:grid-cols-2">
      <Row label="Held for you">{card.escrow}</Row>
      <Row label="Expected">{card.expected}</Row>
      <div className="sm:col-span-2"><Row label="Why it waits">{card.reason}</Row></div>
    </dl>
    {card.contractPreview ? <p data-slot="queued-contract-preview" className="text-sm text-ink">{card.contractPreview}</p> : null}
    {card.partial ? <p className="text-sm text-ink-2">{card.partial}</p> : null}
    <p className="text-sm text-ink-2">{card.note}</p>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ExternalLink href={card.faqHref} className="text-sm text-ink-3 underline underline-offset-2">How the queue works</ExternalLink>
      {card.cancelId === null ? null : <Button size="sm" variant="ghost" disabled={!canAct || busy}
        onClick={() => onCancel(card)}>{card.cancelLabel}</Button>}
    </div>
  </Panel>;
}

/** Nothing at all when nothing is queued: an empty queue is not news on these pages. */
export function EarnQueueCards({ cards, canAct, busy, onCancel, className }: {
  cards: readonly QueuedRequestCard[];
  canAct: boolean;
  busy: boolean;
  onCancel: (card: QueuedRequestCard) => void;
  className?: string;
}) {
  if (cards.length === 0) return null;
  return <section aria-labelledby="earn-queue-title" className={`flex flex-col gap-3 ${className ?? ""}`.trim()}>
    <div>
      <h2 id="earn-queue-title" className="text-xl font-extrabold tracking-[-0.02em]">Your queued lending requests</h2>
      <p className="mt-1 text-sm text-ink-2">
        Waiting in line. Each is paid in order, priced when it is paid, and can be cancelled until then.
      </p>
    </div>
    {cards.map((card) => <QueuedRequestCardView key={card.key} card={card} canAct={canAct} busy={busy} onCancel={onCancel} />)}
  </section>;
}

export function HeldPaymentCardView({ card, canAct, busy, onClaim }: {
  card: HeldPaymentCard;
  /** A wallet is connected that can send the claim. The button still shows, disabled, without one. */
  canAct: boolean;
  busy: boolean;
  onClaim: (card: HeldPaymentCard, to: Address) => void;
}) {
  const [receiver, setReceiver] = useState<string>(card.defaultReceiver);
  const check = parseReceiver(receiver);
  const fieldId = `held-receiver-${card.key}`;
  return <Panel as="article" pad="sm" className="flex flex-col gap-3" data-held-payment={card.held.id.toString()}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-base font-extrabold">{card.title}</h3>
      <span className="num text-sm font-semibold text-ink">{card.amount}</span>
    </div>
    <p className="text-sm text-ink-2">{card.why}</p>
    {card.receiverWarning ? <p className="text-sm text-ink-2" role="note">{card.receiverWarning}</p> : null}
    <div>
      <label htmlFor={fieldId} className="block text-xs font-semibold text-ink-3">Pay to</label>
      <input id={fieldId} value={receiver} onChange={(event) => setReceiver(event.target.value)} spellCheck={false}
        autoComplete="off" aria-invalid={!check.ok}
        className="num mt-1 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-sm text-ink" />
      {check.ok ? null : <p className="mt-1 text-xs text-ink-2" data-receiver-error>{check.reason}</p>}
    </div>
    <div className="flex justify-end">
      <Button size="sm" disabled={!canAct || busy || !check.ok}
        onClick={() => { if (check.ok) onClaim(card, check.address); }}>{card.claimLabel}</Button>
    </div>
  </Panel>;
}

/** Nothing at all when nothing is held and the read succeeded; a status line alone when it could not check. */
export function HeldPayments({ view, canAct, busy, onClaim, className }: {
  view: HeldPaymentsView;
  canAct: boolean;
  busy: boolean;
  onClaim: (card: HeldPaymentCard, to: Address) => void;
  className?: string;
}) {
  if (view.cards.length === 0 && view.status === null) return null;
  return <section aria-labelledby="earn-held-title" className={`flex flex-col gap-3 ${className ?? ""}`.trim()}>
    <div>
      <h2 id="earn-held-title" className="text-xl font-extrabold tracking-[-0.02em]">{HELD_SECTION_TITLE}</h2>
      {view.cards.length ? <p className="mt-1 text-sm text-ink-2">{HELD_EXPLAINER}</p> : null}
    </div>
    {view.cards.map((card) => <HeldPaymentCardView key={card.key} card={card} canAct={canAct} busy={busy} onClaim={onClaim} />)}
    {view.status ? <p role="status" className="text-sm text-ink-3">{view.status}</p> : null}
  </section>;
}
