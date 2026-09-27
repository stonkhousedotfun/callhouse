/**
 * USDG the order book is holding for this wallet because a payment could not be sent (lib/v2/owed.ts), with
 * the one action that releases it. Makers, takers and resale sellers can all be owed. Stateless, so it renders the
 * same on the server; the page owns the read and the write.
 */
import { Button, Notice } from "@/components/ui";
import type { OwedBannerModel } from "@/lib/v2/owed";

/** The banner's one line (OrderBook `_payOrOwe` credits `owed` when a USDG transfer fails). */
export const OWED_LINE = "A payment to this wallet could not be sent, so the order book is holding it.";

export function OwedBanner({ model, canAct, busy, onClaim, className }: {
  /** Null when nothing is owed or the balance was not read: then there is nothing to show. */
  model: OwedBannerModel | null;
  canAct: boolean;
  busy: boolean;
  onClaim: () => void;
  className?: string;
}) {
  if (model === null) return null;
  return <Notice tone="warn" role="status" className={className} title={`${model.amount} waiting for you in the order book`}>
    <div className="flex flex-wrap items-center justify-between gap-3" data-owed-banner={model.raw.toString()}>
      <p className="text-sm">{OWED_LINE}</p>
      <Button size="sm" disabled={!canAct || busy} onClick={onClaim}>Claim {model.amount}</Button>
    </div>
  </Notice>;
}
