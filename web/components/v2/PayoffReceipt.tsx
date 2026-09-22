"use client";

import { useEffect, useId, useState } from "react";

import { buildPayoffReceipt, type PayoffReceipt as Receipt, type PayoffReceiptInput, type ReceiptLine } from "@/lib/v2/payoffReceipt";

/** One line of the receipt: the label, the figure, how it was reached, and the rule behind it behind an
 * info toggle (§2.5: the copy is written from the contract rule, never the file path). */
function Line({ line, emphasis = false }: { line: ReceiptLine; emphasis?: boolean }) {
  const [showRule, setShowRule] = useState(false);
  const ruleId = useId();
  return <li className={`py-2 ${emphasis ? "border-t border-line-2 pt-3" : ""}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className={`flex items-center gap-1.5 text-sm ${emphasis ? "font-semibold text-ink" : "text-ink-2"}`}>
        {line.label}
        <button type="button" aria-expanded={showRule} aria-controls={ruleId} aria-label={`How ${line.label.toLowerCase()} is calculated`}
          onClick={() => setShowRule((open) => !open)}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-line-2 text-[10px] font-bold text-ink-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">i</button>
      </span>
      <span className={`num text-sm ${emphasis ? "font-semibold text-ink" : "text-ink"}`}>{line.deduction ? "− " : ""}{line.value}</span>
    </div>
    <p className="num mt-0.5 text-xs text-ink-3">{line.note}</p>
    <p id={ruleId} hidden={!showRule} className="mt-1 rounded-sm bg-surface-2 px-2 py-1.5 text-xs leading-relaxed text-ink-2">{line.rule}</p>
  </li>;
}

/** "What you pay, and what you can get" (design §2.5): expandable, open on desktop, collapsed on mobile with the
 * total in the summary line. Pure input, pure output: every figure comes from {buildPayoffReceipt}. */
export function PayoffReceipt({ input, className = "" }: { input: PayoffReceiptInput; className?: string }) {
  const receipt: Receipt = buildPayoffReceipt(input);
  // Open by default on desktop only. Server markup renders collapsed; the effect opens it once the
  // viewport is known, so the summary total is what a phone sees first (§2.7).
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(min-width: 640px)").matches) setOpen(true);
  }, []);
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}
    className={`rounded-md border border-line bg-surface ${className}`} data-testid="payoff-receipt">
    <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
      <span className="mr-2 inline-block w-3 text-ink-3" aria-hidden="true">{open ? "▾" : "▸"}</span>
      What you pay, and what you can get
      <span className="num ml-2 block text-xs font-normal text-ink-2 sm:inline">{receipt.summary}</span>
    </summary>
    <div className="border-t border-line px-4 pb-4">
      <h4 className="mt-3 text-xs font-bold uppercase tracking-wide text-ink-3">{receipt.pay.title}</h4>
      <ul className="divide-y divide-line">
        {receipt.pay.lines.map((line) => <Line key={line.key} line={line} />)}
        <Line line={receipt.pay.total} emphasis />
      </ul>
      <h4 className="mt-4 text-xs font-bold uppercase tracking-wide text-ink-3">{receipt.get.title}</h4>
      <ul className="divide-y divide-line">
        {receipt.get.lines.map((line) => <Line key={line.key} line={line} />)}
        <Line line={receipt.get.total} emphasis />
      </ul>
    </div>
  </details>;
}
