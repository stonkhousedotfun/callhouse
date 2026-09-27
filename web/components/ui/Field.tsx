import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

import { ChevronDownIcon } from "./icons";
import { InfoTip } from "./InfoTip";

/**
 * An amount field: a label over a JetBrains Mono input with the unit pinned inside its right edge.
 *
 *   <Field id="deposit-amount" label="Amount" suffix="NVDA" value={raw} onChange={…} inputMode="decimal" />
 *
 * `id` is required: it ties the <label> to the input, and the run fills the input by it
 * (#deposit-amount, #redeem-shares, #fill-qty). `hint` renders under the input, linked by
 * aria-describedby.
 */
export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className" | "type" | "size"> & {
  id: string;
  label?: ReactNode;
  tip?: ReactNode;
  aside?: ReactNode;
  suffix?: ReactNode;
  hint?: ReactNode;
  size?: "md" | "sm";
  className?: string;
};

export const inputClasses =
  "num block w-full min-w-0 rounded-md border border-line-2 bg-surface text-ink transition-[border-color,box-shadow] duration-150 hover:border-ink-3 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60";

const INPUT_SIZE = {
  md: "px-3.5 py-3 text-[17px]",
  sm: "px-2.5 py-1.5 text-[14px]",
} as const;

export function FieldLabel({ htmlFor, tip, tipLabel, aside, children }: {
  htmlFor: string; tip?: ReactNode; tipLabel?: string; aside?: ReactNode; children: ReactNode;
}) {
  return <div className="flex min-h-5 min-w-0 items-center justify-between gap-3">
    <span className="flex min-w-0 items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-[12.5px] font-semibold text-ink-2">{children}</label>
      {tip ? <InfoTip text={tip} label={tipLabel ?? (typeof children === "string" ? `About ${children.toLowerCase()}` : undefined)} /> : null}
    </span>
    {aside ? <span className="min-w-0 truncate text-[12.5px] text-ink-3">{aside}</span> : null}
  </div>;
}

export function Field({ id, label, tip, aside, suffix, hint, size = "md", className, ...input }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      {label ? (
        <FieldLabel htmlFor={id} tip={tip} aside={aside}>{label}</FieldLabel>
      ) : (
        <label htmlFor={id} className="sr-only">
          Amount
        </label>
      )}
      <div className="relative">
        <input
          id={id}
          type="text"
          aria-describedby={hintId}
          className={cn(inputClasses, INPUT_SIZE[size], suffix ? (size === "sm" ? "pr-14" : "pr-24") : null)}
          {...input}
        />
        {suffix ? (
          <span
            aria-hidden="true"
            className={cn(
              "num pointer-events-none absolute top-1/2 -translate-y-1/2 font-medium text-ink-3",
              size === "sm" ? "right-2.5 text-[11px]" : "right-3.5 text-[13px]",
            )}
          >
            {suffix}
          </span>
        ) : null}
      </div>
      {hint ? (
        <div id={hintId} className="text-[12px] text-ink-3">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "className"> & {
  id: string;
  label: ReactNode;
  tip?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function SelectField({ id, label, tip, aside, className, children, ...select }: SelectFieldProps) {
  return <div className={cn("grid min-w-0 gap-1.5", className)}>
    <FieldLabel htmlFor={id} tip={tip} aside={aside}>{label}</FieldLabel>
    <div className="relative">
      <select id={id} className={cn(inputClasses, "appearance-none py-3 pl-3.5 pr-10 font-body text-[15px] font-medium")} {...select}>
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
    </div>
  </div>;
}
