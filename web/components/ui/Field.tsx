import type { InputHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * An amount field: a label over a Geist Mono input with the unit pinned inside its right edge.
 *
 *   <Field id="deposit-amount" label="Amount" suffix="NVDA" value={raw} onChange={…} inputMode="decimal" />
 *
 * `id` is required: it ties the <label> to the input, and the W-13 run fills the input by it
 * (#deposit-amount, #redeem-shares, #fill-qty). `hint` renders under the input, linked by
 * aria-describedby.
 */
export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className" | "type"> & {
  id: string;
  label: ReactNode;
  suffix?: ReactNode;
  hint?: ReactNode;
  className?: string;
};

export const inputClasses =
  "num block w-full min-w-0 rounded-md border border-line-2 bg-surface px-3.5 py-3 text-[17px] text-ink transition-[border-color,box-shadow] duration-150 hover:border-ink-3 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60";

export function Field({ id, label, suffix, hint, className, ...input }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("grid gap-2", className)}>
      <label htmlFor={id} className="text-[13.5px] font-semibold text-ink-2">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type="text"
          aria-describedby={hintId}
          className={cn(inputClasses, suffix ? "pr-24" : null)}
          {...input}
        />
        {suffix ? (
          <span
            aria-hidden="true"
            className="num pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] font-medium text-ink-3"
          >
            {suffix}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-[12.5px] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
