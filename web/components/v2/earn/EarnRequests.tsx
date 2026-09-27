"use client";

import type { Address } from "viem";

import { Button, ExternalLink, InfoTip, Panel } from "@/components/ui";
import { HeldPaymentCardView } from "@/components/v2/EarnQueueCards";
import { HELD_EXPLAINER, HELD_SECTION_TITLE, type HeldPaymentCard, type HeldPaymentsView } from "@/lib/v2/earnDeferred";
import type { QueuedRequestCard } from "@/lib/v2/earnQueue";

const QUEUE_EXPLAINER = "Waiting in line. Each is paid in order, priced when it is paid, and can be cancelled until then.";

function SectionHead({ id, title, tip }: { id: string; title: string; tip: string | null }) {
  return <h2 id={id} className="flex items-center gap-1.5 font-display text-lg font-bold text-ink">{title}
    {tip ? <InfoTip label={`About ${title.toLowerCase()}`} align="start" text={tip} /> : null}</h2>;
}

function EarnRequestCard({ card, canAct, busy, onCancel }: {
  card: QueuedRequestCard;
  canAct: boolean;
  busy: boolean;
  onCancel: (card: QueuedRequestCard) => void;
}) {
  return <Panel as="article" pad="sm" className="grid gap-4" data-queued-request={card.kind}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 text-base font-bold text-ink">{card.title}
        <InfoTip label="How this request is paid" align="start" text={card.note} /></h3>
      <span className="rounded-pill bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-accent-text">{card.position}</span>
    </div>
    <dl className="grid gap-3 text-[13.5px] sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-[12px] font-semibold text-ink-3">Held for you</dt>
        <dd className="mt-0.5 text-ink">{card.escrow}</dd>
      </div>
      <div className="min-w-0">
        <dt className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-3">Expected
          <InfoTip label="Why it waits" align="start" text={card.reason} /></dt>
        <dd className="mt-0.5 text-ink">{card.expected}</dd>
      </div>
    </dl>
    {card.contractPreview ? <p data-slot="queued-contract-preview" className="rounded-md border border-line bg-field px-3.5 py-2.5 text-[13.5px] font-semibold text-ink">{card.contractPreview}</p> : null}
    {card.partial ? <p className="text-[13.5px] text-ink-2">{card.partial}</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ExternalLink href={card.faqHref} className="text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink">How the queue works</ExternalLink>
      {card.cancelId === null ? null : <Button size="sm" variant="ghost" disabled={!canAct || busy}
        onClick={() => onCancel(card)}>{card.cancelLabel}</Button>}
    </div>
  </Panel>;
}

export function EarnRequests({ cards, canAct, busy, onCancel }: {
  cards: readonly QueuedRequestCard[];
  canAct: boolean;
  busy: boolean;
  onCancel: (card: QueuedRequestCard) => void;
}) {
  if (cards.length === 0) return null;
  return <section aria-labelledby="earn-queue-title" className="grid gap-3">
    <SectionHead id="earn-queue-title" title="Your queued lending requests" tip={QUEUE_EXPLAINER} />
    {cards.map((card) => <EarnRequestCard key={card.key} card={card} canAct={canAct} busy={busy} onCancel={onCancel} />)}
  </section>;
}

export function EarnHeldPayments({ view, canAct, busy, onClaim }: {
  view: HeldPaymentsView;
  canAct: boolean;
  busy: boolean;
  onClaim: (card: HeldPaymentCard, to: Address) => void;
}) {
  if (view.cards.length === 0) return null;
  return <section aria-labelledby="earn-held-title" className="grid gap-3">
    <SectionHead id="earn-held-title" title={HELD_SECTION_TITLE} tip={HELD_EXPLAINER} />
    {view.cards.map((card) => <HeldPaymentCardView key={card.key} card={card} canAct={canAct} busy={busy} onClaim={onClaim} />)}
    {view.status ? <p role="status" className="text-[13px] text-ink-3">{view.status}</p> : null}
  </section>;
}
