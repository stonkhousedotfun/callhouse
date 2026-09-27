"use client";

/**
 * "Earliest withdrawal" on a vault surface: one line, its reason behind the "?" InfoTip (it opens
 * on tap and keyboard focus, and its text is always in the page for a screen reader, which a `title` never was), and
 * a link to the FAQ answer that explains it. The words come from lib/v2/earliestWithdrawal.ts; the branch comes from
 * the indexer.
 */
import { useEffect, useState } from "react";

import { ExternalLink, InfoTip } from "@/components/ui";
import type { EarliestWithdrawal as Wire } from "@/lib/v2/api-types";
import { earliestWithdrawalCopy } from "@/lib/v2/earliestWithdrawal";

function useSecondsClock(provided: number | undefined): number {
  const [clock, setClock] = useState(() => provided ?? Math.floor(Date.now() / 1_000));
  useEffect(() => {
    if (provided !== undefined) return;
    const timer = window.setInterval(() => setClock(Math.floor(Date.now() / 1_000)), 60_000);
    return () => window.clearInterval(timer);
  }, [provided]);
  return provided ?? clock;
}

export function EarliestWithdrawalLine({ value, surface, now, className }: {
  /** The wire value; undefined when the indexer does not send it. */
  value: Wire | undefined;
  surface: "earn" | "house";
  /** Unix seconds; the component keeps its own minute clock when omitted. */
  now?: number;
  className?: string;
}) {
  const clock = useSecondsClock(now);
  const copy = earliestWithdrawalCopy(value, surface, clock);
  return <p className={`text-sm text-ink-2 ${className ?? ""}`.trim()} data-earliest-withdrawal={value?.reason ?? "not-sent"}>
    <span className="font-semibold text-ink">Earliest withdrawal:</span>{" "}
    <span>{copy.line}</span>{" "}
    <InfoTip label="Why this time" text={copy.tooltip} />{" "}
    <ExternalLink href={copy.faqHref} className="text-ink-3 underline underline-offset-2">How withdrawals work</ExternalLink>
  </p>;
}
