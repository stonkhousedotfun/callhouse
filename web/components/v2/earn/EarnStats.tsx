import type { ReactNode } from "react";

import { InfoTip, StatTile, type StatTone } from "@/components/ui";
import type { LabelledValue } from "@/lib/v2/vaultCopy";

export function splitUnit(text: string): { value: string; unit?: string } {
  const match = /^(.*\d.*) (USDG|shares)$/.exec(text);
  return match ? { value: match[1], unit: match[2] } : { value: text };
}

export function labelledParts(value: LabelledValue): { sub: ReactNode; tip: string | null } {
  const caution = value.tone === "caution";
  if (value.label.length <= 16) {
    return { sub: <span className={caution ? "font-medium text-warn" : "capitalize"}>{value.label}</span>, tip: null };
  }
  return { sub: caution ? <span className="font-medium text-warn">Estimate</span> : null, tip: value.label };
}

export function EarnStat({ id, label, tip, align = "start", text, sub, tone }: {
    id: string;
  label: string;
  tip?: ReactNode;
  align?: "start" | "end";
  text: string;
  sub?: ReactNode;
  tone?: StatTone;
}) {
  const { value, unit } = splitUnit(text);
  return <div data-stat={id} className="grid min-w-0">
    <StatTile tone={tone} value={value} unit={unit} sub={sub}
      label={<span className="inline-flex items-center gap-1.5">{label}
        {tip ? <InfoTip text={tip} label={`About ${label.toLowerCase()}`} align={align} /> : null}</span>} />
  </div>;
}

export function FactBox({ facts, className }: {
  facts: readonly { key: string; label: string; tip: ReactNode; value: ReactNode }[];
  className?: string;
}) {
  return <dl className={`grid divide-y divide-line rounded-md border border-line bg-field px-3.5 text-[13px] leading-snug ${className ?? ""}`.trim()}>
    {facts.map((fact) => <div key={fact.key} className="grid gap-1 py-3">
      <dt className="flex items-center gap-1.5 font-semibold text-ink">{fact.label}
        <InfoTip text={fact.tip} label={`About ${fact.label.toLowerCase()}`} align="start" /></dt>
      <dd className="text-ink-2">{fact.value}</dd>
    </div>)}
  </dl>;
}
