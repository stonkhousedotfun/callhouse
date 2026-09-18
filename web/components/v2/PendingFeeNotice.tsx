import { Notice } from "@/components/ui";
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

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

function percent(bps: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

function nextRate(kind: PendingFeeNoticeProps["kind"], fees: NextOrderBookFees): string {
  if (kind === "bid")
    return `Scheduled taker fee for crossing asks: the lesser of ${formatUsdg(BigInt(fees.takerFeeFlat.raw))} USDG or ${percent(fees.takerFeeCapBps)} of premium.`;
  if (kind === "buyer")
    return `Scheduled taker fee: the lesser of ${formatUsdg(BigInt(fees.takerFeeFlat.raw))} USDG or ${percent(fees.takerFeeCapBps)} of premium.`;
  if (kind === "writer") return `Scheduled seller fee: ${percent(fees.premiumFeeBps)} of premium.`;
  if (kind === "resale") return `Scheduled resale fee: ${percent(fees.resaleFeeBps)} of premium.`;
  return `Scheduled resale fee: ${percent(fees.resaleFeeBps)} of premium; scheduled taker fee: the lesser of ${formatUsdg(BigInt(fees.takerFeeFlat.raw))} USDG or ${percent(fees.takerFeeCapBps)} of premium.`;
}

export function PendingFeeNotice({ effectiveAt, nextFees, kind, className }: PendingFeeNoticeProps) {
  if (!Number.isSafeInteger(effectiveAt) || effectiveAt <= 0) return null;
  const when = new Date(effectiveAt * 1000);
  if (Number.isNaN(when.getTime())) return null;
  return <Notice tone="info" role="status" title="Fee change scheduled" className={className}>
    <p>A fee change is scheduled for <time dateTime={when.toISOString()}>{EASTERN.format(when)}</time>.</p>
    <p className="mt-1">{nextRate(kind, nextFees)}</p>
    {kind === "buyer" || kind === "resaleImmediate"
      ? <p className="mt-1">Quotes use current fees. The fee is set on chain when the trade executes; review the scheduled time before confirming.</p>
      : kind === "bid"
        ? <p className="mt-1">A bid that crosses an ask uses the taker fee at execution. A resting bid can fill after this change; you can cancel it first.</p>
        : <p className="mt-1">Quotes use current fees. A resting order may fill under the new fees after activation. You can cancel it before it fills.</p>}
  </Notice>;
}
