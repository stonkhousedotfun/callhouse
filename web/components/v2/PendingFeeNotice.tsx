import { Notice } from "@/components/ui";
import { Time } from "@/components/ui/Time";
import { displayExact } from "@/lib/numberFormat";
import { formatUsdg } from "@/lib/v2/payoffCard";
import type { ConfigResponse } from "@/lib/v2/api-types";

export type NextOrderBookFees = NonNullable<ConfigResponse["pendingFees"]>;

export type PendingFeeNoticeProps = {
  /** Unix seconds when the scheduled rates may take effect. */
  effectiveAt: number;
  nextFees: NextOrderBookFees;
  kind: "buyer" | "bid" | "writer" | "resale" | "resaleImmediate";
  className?: string;
};

/** A fee rate exactly, with no zero tail: 750 -> "7.5%", 125 -> "1.25%". A rate is never rounded to one decimal. */
function percent(bps: number): string {
  return `${displayExact(BigInt(Math.round(bps)), 2, { minDecimals: 0 })}%`;
}

function nextRate(kind: PendingFeeNoticeProps["kind"], fees: NextOrderBookFees): string {
  const taker = `the lesser of ${formatUsdg(BigInt(fees.takerFeeFlat.raw))} USDG or ${percent(fees.takerFeeCapBps)} of premium`;
  if (kind === "bid" || kind === "buyer") return `New taker fee: ${taker}.`;
  if (kind === "writer") return `New seller fee: ${percent(fees.premiumFeeBps)} of premium.`;
  if (kind === "resale") return `New resale fee: ${percent(fees.resaleFeeBps)} of premium.`;
  return `New resale fee: ${percent(fees.resaleFeeBps)} of premium; new taker fee: ${taker}.`;
}

export function PendingFeeNotice({ effectiveAt, nextFees, kind, className }: PendingFeeNoticeProps) {
  if (!Number.isSafeInteger(effectiveAt) || effectiveAt <= 0) return null;
  const when = new Date(effectiveAt * 1000);
  if (Number.isNaN(when.getTime())) return null;
  return <Notice tone="info" role="status" title="Fee change scheduled" className={className}>
    <p>From <Time at={effectiveAt} />. {nextRate(kind, nextFees)}</p>
    {kind === "buyer" || kind === "resaleImmediate"
      ? <p className="mt-1">You pay the fee in force when your trade confirms.</p>
      : kind === "bid"
        ? <p className="mt-1">Any part that buys at once pays the fee in force then. A resting bid can fill after the change; you can cancel it first.</p>
        : <p className="mt-1">An open order can fill under the new fees. You can cancel it first.</p>}
  </Notice>;
}
