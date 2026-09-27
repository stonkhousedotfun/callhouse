import { cn } from "@/lib/cn";

/**
 * The small Call / Put tag beside a strike. Call is --accent-soft ground with
 * --accent-text ink; Put is --danger-soft with --danger-text. The word is always printed: red/green alone is not a
 * signal a colour-blind reader gets.
 *
 * `isPut` is the v2 wire's own field (series.isPut), so a caller passes it straight through rather than mapping to a
 * string first.
 */
export function OptionTag({ isPut, className }: { isPut: boolean; className?: string }) {
  return (
    <span
      data-slot="option-tag"
      className={cn(
        "inline-flex items-center rounded-[6px] px-[7px] py-0.5 font-body text-xs font-bold leading-[1.4]",
        isPut ? "bg-danger-soft text-danger-text" : "bg-accent-soft text-accent-text",
        className,
      )}
    >
      {isPut ? "Put" : "Call"}
    </span>
  );
}
